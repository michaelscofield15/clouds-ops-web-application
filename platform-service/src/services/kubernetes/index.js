const k8sClient = require('./k8s.client');
const prereqService = require('./prereq.service');
const manifestGenerator = require('./manifest.generator');
const storageService = require('../storage.service');
const auditService = require('../audit.service');
const dockerClient = require('../docker/docker.client');
const config = require('../../config');
const http = require('http');

class KubernetesEngine {
  constructor() {
    this.deployments = new Map();
  }

  /**
   * Deploys a project onto the real local Kind Kubernetes cluster
   */
  async deploy(projectId, options = {}) {
    const startTime = Date.now();
    const metadata = storageService.getProject(projectId);
    if (!metadata) {
      const error = new Error(`Project '${projectId}' not found`);
      error.code = 'PROJECT_NOT_FOUND';
      error.status = 404;
      throw error;
    }

    const projectAnalysis = metadata.analysis || {};
    const dockerEngine = require('../docker');
    const dockerState = metadata.dockerState || dockerEngine.dockerStates?.get(projectId) || {};

    // 1. Check if project is Dockerized
    const imageTag = dockerState.image?.tag || options.imageTag;
    if (!imageTag) {
      const error = new Error('NOT_DOCKERIZED: Project must be dockerized before Kubernetes deployment');
      error.code = 'NOT_DOCKERIZED';
      error.status = 400;
      throw error;
    }

    // 2. Verify Docker image actually exists locally in Docker daemon
    try {
      await dockerClient.inspectImage(imageTag);
    } catch (err) {
      const error = new Error(`IMAGE_NOT_FOUND: Docker image '${imageTag}' does not exist in local daemon (${err.message})`);
      error.code = 'IMAGE_NOT_FOUND';
      error.status = 400;
      throw error;
    }

    // 3. Check / Ensure Kind cluster
    auditService.log(projectId, 'KUBERNETES_CHECK', 'PENDING', { cluster: config.kubernetes.clusterName });
    const clusterResult = await prereqService.ensureCluster(config.kubernetes.clusterName);
    await prereqService.verifyContextSafety(config.kubernetes.contextName);

    // 4. Load Docker image into Kind cluster nodes
    auditService.log(projectId, 'KUBERNETES_IMAGE_LOAD', 'PENDING', { imageTag, cluster: config.kubernetes.clusterName });
    console.log(`[KubernetesEngine] Loading image '${imageTag}' into Kind cluster...`);
    try {
      await k8sClient.loadDockerImage(imageTag, config.kubernetes.clusterName);
    } catch (err) {
      const error = new Error(`IMAGE_LOAD_FAILED: Failed to load Docker image into Kind cluster (${err.message})`);
      error.code = 'IMAGE_LOAD_FAILED';
      throw error;
    }

    // 5. Generate Manifests & Create Namespace
    const manifests = manifestGenerator.generateManifests(projectId, projectAnalysis, { image: { tag: imageTag } });
    const { namespace, deploymentName, serviceName, port, combinedYaml } = manifests;

    auditService.log(projectId, 'KUBERNETES_NAMESPACE_CREATE', 'PENDING', { namespace });
    await k8sClient.createNamespace(namespace);

    // 6. Apply Deployment & Service
    auditService.log(projectId, 'KUBERNETES_DEPLOYMENT_APPLY', 'PENDING', { deploymentName, serviceName, namespace });
    console.log(`[KubernetesEngine] Applying Kubernetes manifests to namespace '${namespace}'...`);
    try {
      await k8sClient.applyManifest(combinedYaml, namespace);
    } catch (err) {
      const error = new Error(`DEPLOYMENT_APPLY_FAILED: kubectl apply failed (${err.message})`);
      error.code = 'DEPLOYMENT_APPLY_FAILED';
      throw error;
    }

    // 7. Wait for Deployment Rollout
    console.log(`[KubernetesEngine] Waiting for rollout of '${deploymentName}'...`);
    try {
      await k8sClient.waitForRollout(deploymentName, namespace, config.kubernetes.rolloutTimeoutSec);
    } catch (err) {
      // Fetch pod states to diagnose reason (CrashLoopBackOff, ImagePullBackOff, etc.)
      const pods = await k8sClient.getPods(namespace, `app=${manifests.appLabel}`);
      const failedPod = pods.find(p => p.waitingReason || p.phase === 'Failed');
      const reason = failedPod ? failedPod.waitingReason || failedPod.phase : 'Timeout';

      const error = new Error(`DEPLOYMENT_TIMEOUT: Deployment rollout failed or timed out (${reason}: ${err.message})`);
      error.code = 'DEPLOYMENT_TIMEOUT';
      error.reason = reason;
      error.pods = pods;
      throw error;
    }

    // 8. Verify Pod Readiness
    const pods = await k8sClient.getPods(namespace, `app=${manifests.appLabel}`);
    const readyPod = pods.find(p => p.ready && p.phase === 'Running');
    if (!readyPod) {
      const error = new Error('POD_NOT_READY: Pod is running but failed readiness check');
      error.code = 'POD_NOT_READY';
      error.pods = pods;
      throw error;
    }
    auditService.log(projectId, 'KUBERNETES_POD_READY', 'SUCCESS', { podName: readyPod.name, node: readyPod.nodeName });

    // 9. Verify Service & Endpoints
    const serviceInfo = await k8sClient.getService(serviceName, namespace);
    const endpointsInfo = await k8sClient.getEndpoints(serviceName, namespace);
    if (!serviceInfo || !endpointsInfo.hasEndpoints) {
      const error = new Error('SERVICE_UNAVAILABLE: Kubernetes Service exists but has no active ready endpoints');
      error.code = 'SERVICE_UNAVAILABLE';
      throw error;
    }

    // 10. Real Application-Level HTTP Health Check
    auditService.log(projectId, 'KUBERNETES_HEALTH_CHECK', 'PENDING', { serviceName, port });
    let healthResult = { status: 'healthy', statusCode: 200, durationMs: 0 };
    let portForwardHandle = null;

    try {
      portForwardHandle = await k8sClient.startPortForward(serviceName, namespace, port);
      const localPort = portForwardHandle.localPort;

      healthResult = await this._probeHealth(`http://127.0.0.1:${localPort}/health`);
    } catch (err) {
      const error = new Error(`HEALTH_CHECK_FAILED: Real HTTP health check failed on service endpoint (${err.message})`);
      error.code = 'HEALTH_CHECK_FAILED';
      throw error;
    } finally {
      if (portForwardHandle && portForwardHandle.stop) {
        portForwardHandle.stop();
      }
    }

    // 11. Retrieve live Pod logs and Events
    const logs = await k8sClient.getPodLogs(readyPod.name, namespace, '', 100);
    const events = await k8sClient.getEvents(namespace);

    const durationMs = Date.now() - startTime;

    const deploymentState = {
      projectId,
      status: 'deployed',
      cluster: {
        name: config.kubernetes.clusterName,
        context: config.kubernetes.contextName,
        nodes: clusterResult.nodes
      },
      namespace,
      deployment: {
        name: deploymentName,
        status: 'Available',
        replicas: { desired: 1, ready: 1, available: 1 }
      },
      service: {
        name: serviceName,
        type: serviceInfo.type,
        clusterIP: serviceInfo.clusterIP,
        ports: serviceInfo.ports,
        hasEndpoints: endpointsInfo.hasEndpoints,
        readyEndpoints: endpointsInfo.readyAddresses
      },
      pod: {
        name: readyPod.name,
        phase: readyPod.phase,
        ready: readyPod.ready,
        nodeName: readyPod.nodeName,
        podIP: readyPod.podIP,
        restartCount: readyPod.restartCount,
        image: imageTag
      },
      health: {
        status: 'healthy',
        endpoint: '/health',
        statusCode: healthResult.statusCode,
        response: healthResult.response
      },
      metrics: {
        deploymentDurationMs: durationMs
      },
      deployedAt: new Date().toISOString()
    };

    this.deployments.set(projectId, deploymentState);

    // Persist in project storage
    storageService.updateProject(projectId, {
      kubernetesState: deploymentState
    });

    auditService.log(projectId, 'KUBERNETES_DEPLOYMENT_APPLY', 'SUCCESS', {
      deploymentName,
      namespace,
      serviceName,
      podName: readyPod.name,
      durationMs
    });

    return deploymentState;
  }

  /**
   * Probes application HTTP health endpoint with retry backoff
   */
  async _probeHealth(url, maxRetries = 10, intervalMs = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const req = http.get(url, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 400) {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch { /* text */ }
                resolve({ statusCode: res.statusCode, response: parsed });
              } else {
                reject(new Error(`HTTP status ${res.statusCode}: ${data}`));
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
          });
        });
        return result;
      } catch (err) {
        if (attempt === maxRetries) {
          throw err;
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }
  }

  /**
   * Retrieves live, verified Kubernetes status for a project
   */
  async getStatus(projectId) {
    const metadata = storageService.getProject(projectId);
    if (!metadata) {
      return { status: 'not_found' };
    }

    const state = metadata.kubernetesState || this.deployments.get(projectId);
    if (!state || !state.namespace) {
      return { projectId, status: 'not_deployed' };
    }

    const { namespace, deployment, service } = state;

    try {
      const liveDeployment = await k8sClient.getDeployment(deployment.name, namespace);
      if (!liveDeployment) {
        return { projectId, status: 'not_found_in_cluster', namespace };
      }

      const livePods = await k8sClient.getPods(namespace);
      const liveService = await k8sClient.getService(service.name, namespace);
      const liveEndpoints = await k8sClient.getEndpoints(service.name, namespace);
      const events = await k8sClient.getEvents(namespace);

      return {
        projectId,
        status: liveDeployment.replicas.ready > 0 ? 'deployed' : 'degraded',
        namespace,
        deployment: liveDeployment,
        pods: livePods,
        service: liveService,
        endpoints: liveEndpoints,
        events: events.slice(-10),
        cluster: {
          name: config.kubernetes.clusterName,
          context: config.kubernetes.contextName
        },
        refreshedAt: new Date().toISOString()
      };
    } catch (err) {
      return {
        projectId,
        status: 'error',
        error: err.message
      };
    }
  }

  /**
   * Retrieves live Pod logs
   */
  async getLogs(projectId, lines = 200) {
    const metadata = storageService.getProject(projectId);
    const state = metadata?.kubernetesState || this.deployments.get(projectId);
    if (!state || !state.namespace) {
      const error = new Error('Project is not deployed to Kubernetes');
      error.code = 'NOT_DEPLOYED';
      error.status = 404;
      throw error;
    }

    const pods = await k8sClient.getPods(state.namespace);
    if (pods.length === 0) {
      return { projectId, namespace: state.namespace, logs: 'No active Pods found in namespace.' };
    }

    const pod = pods[0];
    const logs = await k8sClient.getPodLogs(pod.name, state.namespace, '', lines);
    return {
      projectId,
      namespace: state.namespace,
      podName: pod.name,
      logs
    };
  }

  /**
   * Retrieves live namespace events
   */
  async getEvents(projectId) {
    const metadata = storageService.getProject(projectId);
    const state = metadata?.kubernetesState || this.deployments.get(projectId);
    if (!state || !state.namespace) {
      return [];
    }
    return await k8sClient.getEvents(state.namespace);
  }

  /**
   * Deletes all Kubernetes resources for a project
   */
  async deleteDeployment(projectId) {
    const metadata = storageService.getProject(projectId);
    const state = metadata?.kubernetesState || this.deployments.get(projectId);
    if (!state || !state.namespace) {
      return { projectId, deleted: false, reason: 'Not deployed' };
    }

    const { namespace, deployment, service } = state;

    console.log(`[KubernetesEngine] Cleaning up Kubernetes resources in namespace '${namespace}'...`);
    auditService.log(projectId, 'KUBERNETES_DELETE', 'PENDING', { namespace });

    await k8sClient.deleteDeployment(deployment.name, namespace);
    await k8sClient.deleteService(service.name, namespace);
    await k8sClient.deleteNamespace(namespace);

    this.deployments.delete(projectId);
    storageService.updateProject(projectId, {
      kubernetesState: null
    });

    auditService.log(projectId, 'KUBERNETES_DELETE', 'SUCCESS', { namespace });

    return {
      projectId,
      namespace,
      deleted: true,
      deletedAt: new Date().toISOString()
    };
  }
}

module.exports = new KubernetesEngine();
module.exports.KubernetesEngine = KubernetesEngine;
