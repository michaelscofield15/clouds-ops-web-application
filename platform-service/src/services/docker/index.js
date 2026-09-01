const path = require('path');
const dockerClient = require('./docker.client');
const dockerfileGenerator = require('./dockerfile.generator');
const healthChecker = require('./health.checker');
const storageService = require('../storage.service');

class DockerEngine {
  constructor() {
    this.dockerStates = new Map();
  }

  /**
   * Sanitizes project name to form a valid Docker image repository name
   */
  sanitizeImageName(name) {
    return (name || 'app')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'app';
  }

  /**
   * Complete automated Dockerization flow
   */
  async dockerize(projectId, options = {}) {
    // 1. Docker availability check
    const availability = await dockerClient.checkDockerAvailability();
    if (!availability.available) {
      return {
        projectId,
        status: 'blocked',
        reason: 'Docker daemon is not available',
        error: availability.error
      };
    }

    // 2. Retrieve project workspace & Phase 2 analysis
    const workspace = storageService.getWorkspacePath(projectId);
    if (!workspace) {
      const err = new Error(`Workspace for project ID '${projectId}' not found`);
      err.status = 404;
      throw err;
    }

    const analysis = storageService.getAnalysis(projectId);
    if (!analysis) {
      const err = new Error(`Analysis for project ID '${projectId}' not found`);
      err.status = 400;
      throw err;
    }

    const projectDir = workspace.extractDir;
    const internalPort = (analysis.port && analysis.port.value && analysis.port.value !== 'unknown')
      ? analysis.port.value
      : 3000;

    // 3. Prepare Dockerfile (Case A: Generate, Case B: Existing, Case C: Repair)
    let dockerfileInfo = dockerfileGenerator.prepareDockerfile(projectDir, analysis);
    const shortId = projectId.slice(0, 8);
    const repoName = this.sanitizeImageName(analysis.project?.name);
    const imageTag = `cloudops/${repoName}:build-${shortId}`;
    const containerName = `cloudops-${repoName}-${shortId}-${Date.now()}`;

    let buildResult;
    try {
      // 4. Build Docker image
      buildResult = await dockerClient.buildImage(projectDir, imageTag, { platform: options.platform });
    } catch (buildErr) {
      // Case C: Existing Dockerfile failed — attempt safe repair with backup
      if (dockerfileInfo.source === 'existing') {
        try {
          dockerfileGenerator.attemptSafeRepair(projectDir, analysis);
          buildResult = await dockerClient.buildImage(projectDir, imageTag, { platform: options.platform });
          dockerfileInfo = {
            source: 'repaired_after_failure',
            backupPath: path.join(projectDir, 'Dockerfile.cloudops-backup')
          };
        } catch (repairErr) {
          return {
            projectId,
            status: 'blocked',
            reason: 'Existing Dockerfile failed and automatic repair was not successful',
            error: buildErr.message,
            dockerfile: {
              source: 'existing',
              failed: true
            }
          };
        }
      } else {
        return {
          projectId,
          status: 'failed',
          reason: 'Docker image build failed',
          error: buildErr.message,
          dockerfile: {
            source: dockerfileInfo.source
          }
        };
      }
    }

    // Stop any previous container for this project if one was already tracked
    const existingState = this.dockerStates.get(projectId);
    if (existingState && existingState.container && existingState.container.id) {
      await dockerClient.stopAndRemoveContainer(existingState.container.id);
    }

    // 5. Run container with dynamic host port mapping & resource limits
    let runResult;
    try {
      runResult = await dockerClient.runContainer(imageTag, {
        internalPort,
        name: containerName
      });
    } catch (runErr) {
      return {
        projectId,
        status: 'failed',
        reason: 'Failed to start Docker container',
        error: runErr.message,
        image: {
          tag: imageTag,
          id: buildResult.imageId
        }
      };
    }

    // 6. Inspect container state and port allocation
    let containerInfo = await dockerClient.inspectContainer(runResult.containerId);

    if (!containerInfo.running) {
      const logs = await dockerClient.getContainerLogs(runResult.containerId);
      await dockerClient.stopAndRemoveContainer(runResult.containerId);
      return {
        projectId,
        status: 'failed',
        reason: 'Container exited immediately after startup',
        container: {
          id: runResult.containerId,
          status: containerInfo.status,
          exitCode: containerInfo.exitCode
        },
        logs
      };
    }

    // 7. Verify HTTP Health Check on mapped host port
    const healthResult = await healthChecker.waitForHealthy(containerInfo.hostPort, '/health');
    const containerLogs = await dockerClient.getContainerLogs(runResult.containerId, 50);

    const isHealthy = healthResult.status === 'healthy';

    if (!isHealthy) {
      // Clean up failed container
      await dockerClient.stopAndRemoveContainer(runResult.containerId);

      const failedState = {
        projectId,
        status: 'failed',
        reason: 'Container health check probe failed',
        dockerfile: {
          source: dockerfileInfo.source
        },
        image: {
          tag: imageTag,
          id: buildResult.imageId
        },
        container: {
          id: runResult.containerId,
          status: 'stopped_after_health_failure'
        },
        portMapping: {
          internalPort,
          hostPort: containerInfo.hostPort
        },
        health: healthResult,
        logs: containerLogs
      };

      this.dockerStates.set(projectId, failedState);
      return failedState;
    }

    // 8. Successful Dockerization state
    const successState = {
      projectId,
      status: 'success',
      dockerfile: {
        source: dockerfileInfo.source,
        backupPath: dockerfileInfo.backupPath || undefined
      },
      image: {
        name: repoName,
        tag: imageTag,
        id: buildResult.imageId,
        size: buildResult.imageSize,
        architecture: buildResult.architecture,
        os: buildResult.os,
        platform: buildResult.platform
      },
      container: {
        id: runResult.containerId,
        name: containerName,
        status: 'running'
      },
      portMapping: {
        internalPort,
        hostPort: containerInfo.hostPort
      },
      health: {
        status: 'healthy',
        endpoint: '/health',
        statusCode: healthResult.statusCode,
        response: healthResult.response
      },
      build: {
        status: 'success',
        durationMs: buildResult.durationMs
      },
      dockerizedAt: new Date().toISOString()
    };

    this.dockerStates.set(projectId, successState);
    storageService.updateProject(projectId, { dockerState: successState });
    return successState;
  }

  /**
   * Retrieves latest Dockerization state for a project
   */
  async getStatus(projectId) {
    const state = this.dockerStates.get(projectId);
    if (!state) {
      return {
        projectId,
        status: 'not_dockerized'
      };
    }

    // If container is tracked, refresh its real-time running status
    if (state.container && state.container.id && state.container.status === 'running') {
      try {
        const liveInfo = await dockerClient.inspectContainer(state.container.id);
        state.container.status = liveInfo.running ? 'running' : liveInfo.status;
        state.container.running = liveInfo.running;
      } catch (e) {
        state.container.status = 'stopped';
        state.container.running = false;
      }
    }

    return state;
  }

  /**
   * Retrieves real container logs
   */
  async getLogs(projectId, tail = 100) {
    const state = this.dockerStates.get(projectId);
    if (!state || !state.container || !state.container.id) {
      const err = new Error(`No container found for project ID '${projectId}'`);
      err.status = 404;
      throw err;
    }

    try {
      const logs = await dockerClient.getContainerLogs(state.container.id, tail);
      return {
        projectId,
        containerId: state.container.id,
        logs
      };
    } catch (e) {
      const err = new Error(`Failed to retrieve logs: ${e.message}`);
      err.status = 500;
      throw err;
    }
  }

  /**
   * Stops and removes a running container
   */
  async stopContainer(projectId) {
    const state = this.dockerStates.get(projectId);
    if (!state || !state.container || !state.container.id) {
      const err = new Error(`No container found for project ID '${projectId}'`);
      err.status = 404;
      throw err;
    }

    await dockerClient.stopAndRemoveContainer(state.container.id);
    state.container.status = 'removed';
    state.container.running = false;

    return {
      projectId,
      message: `Container '${state.container.id}' stopped and removed cleanly.`
    };
  }
}

module.exports = new DockerEngine();
