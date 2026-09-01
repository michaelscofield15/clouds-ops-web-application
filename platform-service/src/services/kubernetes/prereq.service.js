const k8sClient = require('./k8s.client');
const config = require('../../config');

class PrereqService {
  /**
   * Performs deep, real detection of all system prerequisites
   */
  async checkPrerequisites() {
    const report = {
      os: {
        platform: process.platform,
        arch: process.arch,
        version: process.version
      },
      docker: {
        installed: false,
        daemonRunning: false,
        version: '',
        error: null
      },
      kubectl: {
        installed: false,
        version: '',
        error: null
      },
      kind: {
        installed: false,
        version: '',
        error: null
      },
      homebrew: {
        installed: false
      },
      kubernetes: {
        connected: false,
        context: '',
        expectedContext: config.kubernetes.contextName,
        clusterName: config.kubernetes.clusterName,
        clusterExists: false,
        nodesReady: false,
        nodeCount: 0,
        nodes: [],
        error: null
      },
      allReady: false
    };

    // 1. Check Homebrew
    try {
      await k8sClient._exec('which', ['brew']);
      report.homebrew.installed = true;
    } catch {
      report.homebrew.installed = false;
    }

    // 2. Check Docker
    try {
      const dockerVer = await k8sClient._exec('docker', ['--version']);
      report.docker.installed = true;
      report.docker.version = dockerVer.stdout;

      // Check daemon
      await k8sClient._exec('docker', ['info']);
      report.docker.daemonRunning = true;
    } catch (err) {
      report.docker.error = err.message;
    }

    // 3. Check kubectl
    try {
      const kVer = await k8sClient._exec('kubectl', ['version', '--client', '--output=yaml']);
      report.kubectl.installed = true;
      const match = kVer.stdout.match(/gitVersion:\s*([^\s]+)/);
      report.kubectl.version = match ? match[1] : 'installed';
    } catch (err) {
      report.kubectl.error = err.message;
    }

    // 4. Check Kind
    try {
      const kindVer = await k8sClient._exec('kind', ['version']);
      report.kind.installed = true;
      report.kind.version = kindVer.stdout;
    } catch (err) {
      report.kind.error = err.message;
    }

    // 5. Check Kind Clusters & Kubernetes Context
    if (report.docker.daemonRunning && report.kind.installed && report.kubectl.installed) {
      try {
        const clusters = await k8sClient.getKindClusters();
        report.kubernetes.clusterExists = clusters.includes(config.kubernetes.clusterName);

        const currentContext = await k8sClient.getCurrentContext();
        report.kubernetes.context = currentContext;

        if (report.kubernetes.clusterExists) {
          // Verify nodes
          try {
            const nodes = await k8sClient.getNodes();
            report.kubernetes.nodes = nodes;
            report.kubernetes.nodeCount = nodes.length;
            report.kubernetes.nodesReady = nodes.length > 0 && nodes.every(n => n.ready);
            report.kubernetes.connected = report.kubernetes.nodesReady;
          } catch (kErr) {
            report.kubernetes.error = kErr.message;
          }
        }
      } catch (err) {
        report.kubernetes.error = err.message;
      }
    }

    report.allReady =
      report.docker.daemonRunning &&
      report.kubectl.installed &&
      report.kind.installed &&
      report.kubernetes.clusterExists &&
      report.kubernetes.nodesReady;

    return report;
  }

  /**
   * Ensures Kind cluster exists and is in ready state
   */
  async ensureCluster(clusterName = config.kubernetes.clusterName) {
    // 1. Verify Docker daemon
    try {
      await k8sClient._exec('docker', ['info']);
    } catch (err) {
      const error = new Error(`DOCKER_UNAVAILABLE: Docker daemon is not running (${err.message})`);
      error.code = 'DOCKER_UNAVAILABLE';
      throw error;
    }

    // 2. Check if cluster already exists
    const clusters = await k8sClient.getKindClusters();
    if (clusters.includes(clusterName)) {
      // Ensure context is active
      const expectedContext = `kind-${clusterName}`;
      await k8sClient.useContext(expectedContext);

      // Verify nodes are ready
      const nodes = await k8sClient.getNodes();
      const readyNode = nodes.find(n => n.ready);
      if (readyNode) {
        return {
          clusterName,
          context: expectedContext,
          status: 'ready',
          action: 'reused_existing',
          nodes
        };
      }
    }

    // 3. Create cluster
    console.log(`[KubernetesPrereq] Creating Kind cluster '${clusterName}'...`);
    try {
      await k8sClient.createKindCluster(clusterName, config.kubernetes.rolloutTimeoutSec);
    } catch (err) {
      const error = new Error(`CLUSTER_CREATION_FAILED: Failed to create Kind cluster (${err.message})`);
      error.code = 'CLUSTER_CREATION_FAILED';
      throw error;
    }

    // 4. Verify context & node readiness
    const expectedContext = `kind-${clusterName}`;
    await k8sClient.useContext(expectedContext);

    // Poll until node is ready (up to 60s)
    let readyNodes = [];
    for (let i = 0; i < 30; i++) {
      try {
        const nodes = await k8sClient.getNodes();
        if (nodes.length > 0 && nodes.every(n => n.ready)) {
          readyNodes = nodes;
          break;
        }
      } catch {
        // retry
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (readyNodes.length === 0) {
      const error = new Error('KUBERNETES_CLUSTER_NOT_READY: Kind cluster nodes failed to become Ready');
      error.code = 'KUBERNETES_CLUSTER_NOT_READY';
      throw error;
    }

    return {
      clusterName,
      context: expectedContext,
      status: 'ready',
      action: 'created_new',
      nodes: readyNodes
    };
  }

  /**
   * Safety verification: ensures current kubectl context matches expected Kind cluster
   */
  async verifyContextSafety(expectedContext = config.kubernetes.contextName) {
    const currentContext = await k8sClient.getCurrentContext();
    if (currentContext !== expectedContext) {
      // Attempt to switch to expected context if it exists
      try {
        await k8sClient.useContext(expectedContext);
      } catch {
        const error = new Error(`KUBERNETES_CONTEXT_MISMATCH: Current context '${currentContext}' does not match expected '${expectedContext}'`);
        error.code = 'KUBERNETES_CONTEXT_MISMATCH';
        throw error;
      }
    }
    return true;
  }
}

module.exports = new PrereqService();
module.exports.PrereqService = PrereqService;
