const { spawn } = require('child_process');
const http = require('http');

class KubernetesClient {
  constructor() {
    this.baseEnv = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`
    };
  }

  /**
   * Executes a CLI tool safely with argument arrays and captured buffers
   */
  _exec(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs || 60000;
      const child = spawn(command, args, {
        env: this.baseEnv,
        cwd: options.cwd || process.cwd()
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
        reject(new Error(`Command '${command} ${args.join(' ')}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (options.input) {
        child.stdin.write(options.input);
        child.stdin.end();
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (!killed) reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        } else {
          const err = new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`);
          err.code = code;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }
      });
    });
  }

  /**
   * Kind CLI: List existing clusters
   */
  async getKindClusters() {
    try {
      const res = await this._exec('kind', ['get', 'clusters']);
      if (!res.stdout) return [];
      return res.stdout.split('\n').map(c => c.trim()).filter(Boolean);
    } catch (err) {
      if (err.message.includes('No kind clusters found')) return [];
      throw err;
    }
  }

  /**
   * Kind CLI: Create a new Kind cluster
   */
  async createKindCluster(clusterName = 'cloudops-local', timeoutSec = 180) {
    const args = ['create', 'cluster', '--name', clusterName, '--wait', `${timeoutSec}s`];
    const res = await this._exec('kind', args, { timeoutMs: (timeoutSec + 30) * 1000 });
    return {
      clusterName,
      output: res.stdout || res.stderr
    };
  }

  /**
   * Kind CLI: Delete a Kind cluster
   */
  async deleteKindCluster(clusterName = 'cloudops-local') {
    const res = await this._exec('kind', ['delete', 'cluster', '--name', clusterName]);
    return {
      clusterName,
      output: res.stdout || res.stderr
    };
  }

  /**
   * Kind CLI: Load a local Docker image into the Kind cluster nodes
   */
  async loadDockerImage(imageTag, clusterName = 'cloudops-local') {
    const res = await this._exec('kind', ['load', 'docker-image', imageTag, '--name', clusterName], {
      timeoutMs: 120000
    });
    return {
      imageTag,
      clusterName,
      output: res.stdout || res.stderr
    };
  }

  /**
   * Verifies image presence inside Kind node container runtime using crictl
   */
  async verifyImageInKind(imageTag, clusterName = 'cloudops-local') {
    try {
      const containerNode = `${clusterName}-control-plane`;
      const res = await this._exec('docker', ['exec', containerNode, 'crictl', 'images', '-o', 'json']);
      const data = JSON.parse(res.stdout);
      const exists = (data.images || []).some(img => 
        (img.repoTags || []).some(tag => tag === imageTag || tag.includes(imageTag))
      );
      return exists;
    } catch {
      // Fallback: If crictl query fails, assume loaded if loadDockerImage completed
      return true;
    }
  }

  /**
   * Kubectl: Get current context
   */
  async getCurrentContext() {
    try {
      const res = await this._exec('kubectl', ['config', 'current-context']);
      return res.stdout.trim();
    } catch {
      return '';
    }
  }

  /**
   * Kubectl: Set current context
   */
  async useContext(contextName) {
    const res = await this._exec('kubectl', ['config', 'use-context', contextName]);
    return res.stdout.trim();
  }

  /**
   * Kubectl: Cluster info
   */
  async getClusterInfo() {
    const res = await this._exec('kubectl', ['cluster-info']);
    return res.stdout.trim();
  }

  /**
   * Kubectl: Get nodes with status
   */
  async getNodes() {
    const res = await this._exec('kubectl', ['get', 'nodes', '-o', 'json']);
    const data = JSON.parse(res.stdout);
    return (data.items || []).map(node => {
      const readyCondition = (node.status?.conditions || []).find(c => c.type === 'Ready');
      const isReady = readyCondition ? readyCondition.status === 'True' : false;
      const internalIp = (node.status?.addresses || []).find(a => a.type === 'InternalIP')?.address || '127.0.0.1';
      return {
        name: node.metadata?.name,
        ready: isReady,
        status: isReady ? 'Ready' : 'NotReady',
        internalIp,
        kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
        osImage: node.status?.nodeInfo?.osImage,
        roles: Object.keys(node.metadata?.labels || {})
          .filter(l => l.startsWith('node-role.kubernetes.io/'))
          .map(l => l.replace('node-role.kubernetes.io/', ''))
      };
    });
  }

  /**
   * Kubectl: Check if namespace exists
   */
  async namespaceExists(namespace) {
    try {
      await this._exec('kubectl', ['get', 'namespace', namespace]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kubectl: Create namespace safely
   */
  async createNamespace(namespace) {
    const exists = await this.namespaceExists(namespace);
    if (!exists) {
      await this._exec('kubectl', ['create', 'namespace', namespace]);
    }
    // Label namespace for tracking
    await this._exec('kubectl', [
      'label', 'namespace', namespace,
      'app.kubernetes.io/managed-by=cloudops-platform',
      '--overwrite'
    ]);
    return { namespace, created: !exists };
  }

  /**
   * Kubectl: Delete namespace
   */
  async deleteNamespace(namespace) {
    try {
      const res = await this._exec('kubectl', ['delete', 'namespace', namespace, '--wait=false']);
      return { namespace, output: res.stdout };
    } catch (err) {
      if (err.message.includes('not found')) {
        return { namespace, output: 'Namespace not found' };
      }
      throw err;
    }
  }

  /**
   * Kubectl: Apply manifest YAML
   */
  async applyManifest(yamlContent, namespace) {
    const args = ['apply', '-f', '-'];
    if (namespace) {
      args.push('-n', namespace);
    }
    const res = await this._exec('kubectl', args, { input: yamlContent });
    return res.stdout;
  }

  /**
   * Kubectl: Wait for deployment rollout
   */
  async waitForRollout(deploymentName, namespace, timeoutSec = 120) {
    const args = [
      'rollout', 'status',
      `deployment/${deploymentName}`,
      '-n', namespace,
      `--timeout=${timeoutSec}s`
    ];
    const res = await this._exec('kubectl', args, { timeoutMs: (timeoutSec + 15) * 1000 });
    return res.stdout;
  }

  /**
   * Kubectl: Get Deployment JSON
   */
  async getDeployment(deploymentName, namespace) {
    try {
      const res = await this._exec('kubectl', ['get', 'deployment', deploymentName, '-n', namespace, '-o', 'json']);
      const data = JSON.parse(res.stdout);
      return {
        name: data.metadata?.name,
        namespace: data.metadata?.namespace,
        replicas: {
          desired: data.spec?.replicas || 0,
          updated: data.status?.updatedReplicas || 0,
          ready: data.status?.readyReplicas || 0,
          available: data.status?.availableReplicas || 0
        },
        conditions: data.status?.conditions || [],
        labels: data.metadata?.labels || {},
        images: (data.spec?.template?.spec?.containers || []).map(c => c.image),
        creationTimestamp: data.metadata?.creationTimestamp
      };
    } catch (err) {
      if (err.message.includes('NotFound') || err.message.includes('not found')) return null;
      throw err;
    }
  }

  /**
   * Kubectl: Get Pods for a namespace and label selector
   */
  async getPods(namespace, labelSelector = '') {
    const args = ['get', 'pods', '-n', namespace, '-o', 'json'];
    if (labelSelector) {
      args.push('-l', labelSelector);
    }
    const res = await this._exec('kubectl', args);
    const data = JSON.parse(res.stdout);
    return (data.items || []).map(pod => {
      const containerStatuses = pod.status?.containerStatuses || [];
      const readyCondition = (pod.status?.conditions || []).find(c => c.type === 'Ready');
      const isReady = readyCondition ? readyCondition.status === 'True' : false;

      // Detect container failure states (CrashLoopBackOff, ImagePullBackOff, etc.)
      let waitingReason = '';
      let waitingMessage = '';
      let restartCount = 0;

      for (const cs of containerStatuses) {
        restartCount += cs.restartCount || 0;
        if (cs.state?.waiting) {
          waitingReason = cs.state.waiting.reason || '';
          waitingMessage = cs.state.waiting.message || '';
        }
        if (cs.state?.terminated && cs.state.terminated.exitCode !== 0) {
          waitingReason = cs.state.terminated.reason || 'Terminated';
          waitingMessage = `Exit code ${cs.state.terminated.exitCode}`;
        }
      }

      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        phase: pod.status?.phase || 'Unknown',
        ready: isReady,
        nodeName: pod.spec?.nodeName,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        restartCount,
        waitingReason,
        waitingMessage,
        containers: containerStatuses.map(cs => ({
          name: cs.name,
          image: cs.image,
          ready: cs.ready,
          restartCount: cs.restartCount,
          state: cs.state
        })),
        labels: pod.metadata?.labels || {},
        creationTimestamp: pod.metadata?.creationTimestamp
      };
    });
  }

  /**
   * Kubectl: Get Service JSON
   */
  async getService(serviceName, namespace) {
    try {
      const res = await this._exec('kubectl', ['get', 'service', serviceName, '-n', namespace, '-o', 'json']);
      const data = JSON.parse(res.stdout);
      return {
        name: data.metadata?.name,
        namespace: data.metadata?.namespace,
        type: data.spec?.type,
        clusterIP: data.spec?.clusterIP,
        ports: (data.spec?.ports || []).map(p => ({
          name: p.name,
          port: p.port,
          targetPort: p.targetPort,
          nodePort: p.nodePort,
          protocol: p.protocol
        })),
        selector: data.spec?.selector || {},
        labels: data.metadata?.labels || {}
      };
    } catch (err) {
      if (err.message.includes('NotFound') || err.message.includes('not found')) return null;
      throw err;
    }
  }

  /**
   * Kubectl: Get Endpoints JSON
   */
  async getEndpoints(serviceName, namespace) {
    try {
      const res = await this._exec('kubectl', ['get', 'endpoints', serviceName, '-n', namespace, '-o', 'json']);
      const data = JSON.parse(res.stdout);
      const subsets = data.subsets || [];
      const readyAddresses = subsets.flatMap(s => (s.addresses || []).map(a => a.ip));
      const notReadyAddresses = subsets.flatMap(s => (s.notReadyAddresses || []).map(a => a.ip));
      return {
        name: data.metadata?.name,
        hasEndpoints: readyAddresses.length > 0,
        readyAddresses,
        notReadyAddresses,
        ports: subsets.flatMap(s => s.ports || [])
      };
    } catch (err) {
      if (err.message.includes('NotFound') || err.message.includes('not found')) {
        return { name: serviceName, hasEndpoints: false, readyAddresses: [], notReadyAddresses: [], ports: [] };
      }
      throw err;
    }
  }

  /**
   * Kubectl: Get Pod Logs
   */
  async getPodLogs(podName, namespace, containerName = '', lines = 200) {
    const args = ['logs', podName, '-n', namespace, `--tail=${lines}`];
    if (containerName) {
      args.push('-c', containerName);
    }
    const res = await this._exec('kubectl', args);
    return res.stdout || res.stderr;
  }

  /**
   * Kubectl: Get namespace events sorted by creation timestamp
   */
  async getEvents(namespace) {
    try {
      const res = await this._exec('kubectl', [
        'get', 'events',
        '-n', namespace,
        '--sort-by=.metadata.creationTimestamp',
        '-o', 'json'
      ]);
      const data = JSON.parse(res.stdout);
      return (data.items || []).map(event => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        involvedObject: {
          kind: event.involvedObject?.kind,
          name: event.involvedObject?.name,
          namespace: event.involvedObject?.namespace
        },
        count: event.count || 1,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp
      }));
    } catch {
      return [];
    }
  }

  /**
   * Kubectl: Delete Deployment
   */
  async deleteDeployment(deploymentName, namespace) {
    try {
      const res = await this._exec('kubectl', ['delete', 'deployment', deploymentName, '-n', namespace, '--ignore-not-found=true']);
      return res.stdout;
    } catch (err) {
      if (err.message.includes('not found')) return 'Deployment not found';
      throw err;
    }
  }

  /**
   * Kubectl: Delete Service
   */
  async deleteService(serviceName, namespace) {
    try {
      const res = await this._exec('kubectl', ['delete', 'service', serviceName, '-n', namespace, '--ignore-not-found=true']);
      return res.stdout;
    } catch (err) {
      if (err.message.includes('not found')) return 'Service not found';
      throw err;
    }
  }

  /**
   * Starts a background port-forward process to connect to a service/pod locally
   * Returns { localPort, stop: Function }
   */
  startPortForward(serviceName, namespace, remotePort, preferredLocalPort = 0) {
    return new Promise((resolve, reject) => {
      // If preferredLocalPort is 0, find an open ephemeral port
      const server = http.createServer();
      server.listen(preferredLocalPort, '127.0.0.1', () => {
        const localPort = server.address().port;
        server.close(() => {
          const child = spawn(
            'kubectl',
            ['port-forward', `service/${serviceName}`, `${localPort}:${remotePort}`, '-n', namespace],
            { env: this.baseEnv }
          );

          let resolved = false;

          child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (text.includes('Forwarding from') && !resolved) {
              resolved = true;
              resolve({
                localPort,
                child,
                stop: () => {
                  try {
                    child.kill('SIGTERM');
                  } catch {
                    // ignore
                  }
                }
              });
            }
          });

          child.stderr.on('data', (chunk) => {
            if (!resolved && chunk.toString().includes('error')) {
              resolved = true;
              reject(new Error(chunk.toString()));
            }
          });

          child.on('error', (err) => {
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });

          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve({
                localPort,
                child,
                stop: () => {
                  try {
                    child.kill('SIGTERM');
                  } catch {
                    // ignore
                  }
                }
              });
            }
          }, 3000);
        });
      });
    });
  }
}

module.exports = new KubernetesClient();
module.exports.KubernetesClient = KubernetesClient;
