const { spawn } = require('child_process');
const config = require('../../config');

/**
 * Execute a docker command safely via child_process.spawn with an argument array.
 * Untrusted strings are never passed to a shell.
 */
function execDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeout || config.docker.buildTimeoutMs;
    const proc = spawn('docker', args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error(`Docker command timed out after ${timeoutMs}ms: docker ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(`Failed to invoke Docker CLI: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        const errorMsg = stderr.trim() || stdout.trim() || `Docker exited with code ${code}`;
        const err = new Error(errorMsg);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

class DockerClient {
  async isAvailable() {
    return this.checkDockerAvailability();
  }

  /**
   * Checks if Docker CLI is installed and the Docker daemon is responding
   */
  async checkDockerAvailability() {
    if (this._cachedAvailability && this._cachedAvailability.available && (Date.now() - (this._cachedAvailabilityTime || 0) < 15000)) {
      return this._cachedAvailability;
    }
    try {
      const { stdout } = await execDocker(['info', '--format', '{{json .}}'], {
        timeout: 10000,
        env: { DOCKER_CLI_HINTS: 'false', DOCKER_CLI_TELEMETRY: 'false' }
      });
      let info = {};
      try {
        info = JSON.parse(stdout);
      } catch (e) {
        // Fallback for non-json format
      }

      // Also get version
      let version = 'unknown';
      try {
        const verResult = await execDocker(['version', '--format', '{{.Client.Version}}'], {
          timeout: 8000,
          env: { DOCKER_CLI_HINTS: 'false', DOCKER_CLI_TELEMETRY: 'false' }
        });
        version = verResult.stdout || 'unknown';
      } catch (e) {
        // ignore
      }

      const res = {
        available: true,
        version,
        serverVersion: info.ServerVersion || version,
        operatingSystem: info.OperatingSystem || 'Docker Host'
      };
      this._cachedAvailability = res;
      this._cachedAvailabilityTime = Date.now();
      return res;
    } catch (err) {
      const res = {
        available: false,
        error: `Docker daemon is not available: ${err.message}`
      };
      this._cachedAvailability = null;
      this._cachedAvailabilityTime = 0;
      return res;
    }
  }

  /**
   * Builds a Docker image with an argument array
   */
  async buildImage(contextDir, tag, options = {}) {
    const startTime = Date.now();
    const args = ['build', '-t', tag];

    if (options.platform) {
      args.push('--platform', options.platform);
    }

    if (options.dockerfilePath) {
      args.push('-f', options.dockerfilePath);
    }

    args.push(contextDir);

    const { stdout, stderr } = await execDocker(args, {
      cwd: contextDir,
      timeout: options.timeout || config.docker.buildTimeoutMs
    });

    const durationMs = Date.now() - startTime;

    // Inspect image metadata to get image ID, architecture, and size
    const imageInfo = await this.inspectImage(tag);

    return {
      success: true,
      tag,
      imageId: imageInfo.id,
      imageSize: imageInfo.size,
      architecture: imageInfo.architecture,
      os: imageInfo.os,
      platform: imageInfo.platform,
      durationMs,
      buildLogs: (stdout + '\n' + stderr).trim()
    };
  }

  /**
   * Inspects a Docker image and parses metadata
   */
  async inspectImage(imageTagOrId) {
    const { stdout } = await execDocker(['image', 'inspect', imageTagOrId]);
    const parsed = JSON.parse(stdout);
    if (!parsed || parsed.length === 0) {
      throw new Error(`Image '${imageTagOrId}' not found`);
    }

    const img = parsed[0];
    const os = img.Os || 'linux';
    const architecture = img.Architecture || 'unknown';
    const platform = `${os}/${architecture}`;

    return {
      id: img.Id,
      size: img.Size,
      sizeFormatted: `${(img.Size / (1024 * 1024)).toFixed(2)} MB`,
      created: img.Created,
      architecture,
      os,
      platform,
      exposedPorts: Object.keys(img.Config?.ExposedPorts || {}),
      cmd: img.Config?.Cmd || [],
      entrypoint: img.Config?.Entrypoint || []
    };
  }

  /**
   * Runs a container securely with resource limits, no privileged mode, and dynamic host port
   */
  async runContainer(imageTag, options = {}) {
    const internalPort = options.internalPort || 3000;
    const memoryLimit = options.memory || config.docker.containerMemoryLimit;
    const cpuLimit = options.cpu || config.docker.containerCpuLimit;
    const containerName = options.name || `cloudops-${Date.now()}`;

    // Security & isolation flags:
    // - Dynamic host port mapping on loopback: -p 127.0.0.1::$internalPort
    // - Resource limits: --memory, --cpus
    // - No privileged, no host volume mounts
    const args = [
      'run',
      '-d',
      '--name', containerName,
      '--memory', memoryLimit,
      '--cpus', cpuLimit,
      '-p', `127.0.0.1::${internalPort}`
    ];

    if (options.env && typeof options.env === 'object') {
      for (const [k, v] of Object.entries(options.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    args.push(imageTag);

    const { stdout } = await execDocker(args);
    const containerId = stdout.trim();

    return {
      containerId,
      containerName,
      internalPort
    };
  }

  /**
   * Inspects container state and extracts dynamic host port mapping
   */
  async inspectContainer(containerId) {
    const { stdout } = await execDocker(['inspect', containerId]);
    const parsed = JSON.parse(stdout);
    if (!parsed || parsed.length === 0) {
      throw new Error(`Container '${containerId}' not found`);
    }

    const container = parsed[0];
    const state = container.State || {};
    const networkSettings = container.NetworkSettings || {};
    const ports = networkSettings.Ports || {};

    let hostPort = null;
    let internalPort = null;

    // Find mapped host port
    for (const [portKey, bindings] of Object.entries(ports)) {
      if (bindings && bindings.length > 0) {
        internalPort = parseInt(portKey.split('/')[0], 10);
        hostPort = parseInt(bindings[0].HostPort, 10);
        break;
      }
    }

    return {
      id: container.Id,
      name: container.Name?.replace(/^\//, ''),
      running: state.Running === true,
      status: state.Status,
      exitCode: state.ExitCode,
      startedAt: state.StartedAt,
      error: state.Error || null,
      internalPort,
      hostPort
    };
  }

  /**
   * Retrieves container logs
   */
  async getContainerLogs(containerId, tail = 200) {
    const { stdout, stderr } = await execDocker(['logs', '--tail', String(tail), containerId]);
    return (stdout + (stderr ? '\n' + stderr : '')).trim();
  }

  /**
   * Stops and removes a container
   */
  async stopAndRemoveContainer(containerId) {
    try {
      await execDocker(['stop', '-t', '5', containerId], { timeout: 15000 });
    } catch (e) {
      // Ignore if already stopped
    }

    try {
      await execDocker(['rm', '-f', containerId], { timeout: 15000 });
    } catch (e) {
      // Ignore if already removed
    }

    return true;
  }

  /**
   * Removes a Docker image
   */
  async removeImage(imageTagOrId) {
    try {
      await execDocker(['rmi', '-f', imageTagOrId], { timeout: 15000 });
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = new DockerClient();
