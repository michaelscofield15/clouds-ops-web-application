const ssmService = require('../aws/ssm.service');
const healthProbeService = require('../monitoring/health.probe.service');
const storageService = require('../storage.service');
const auditService = require('../audit.service');
const config = require('../../config');
const { ACTION_TYPES, RemediationAction } = require('./remediationAction.model');

class RemediationExecutorService {
  /**
   * Masks any sensitive credentials in output
   */
  _maskSecrets(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
      .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
      .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');
  }

  /**
   * Executes a safe, templated remediation action against real AWS infrastructure.
   * @param {object} incident The incident being remediated
   * @param {string} actionType Specific remediation action to execute
   * @param {object} options Execution options
   * @returns {Promise<RemediationAction>} Completed remediation action result
   */
  async execute(incident, actionType, options = {}) {
    const projectId = incident.projectId;
    const awsState = storageService.getAWSState(projectId);

    if (!awsState || !awsState.ec2?.instanceId) {
      throw new Error(`Cannot remediate: Project '${projectId}' has no active EC2 deployment`);
    }

    const instanceId = awsState.ec2.instanceId;
    const region = awsState.ec2.region || config.aws.region || 'ap-south-1';
    const containerName = awsState.deployment?.containerName || awsState.container?.name || `cloudops-${projectId.slice(0, 8)}`;
    const port = awsState.deployment?.port || awsState.port || 3000;
    const publicIp = awsState.ec2.publicIp;
    const endpoint = awsState.endpoint || (publicIp ? `http://${publicIp}:${port}/health` : null);

    const action = new RemediationAction({
      incidentId: incident.incidentId,
      projectId,
      actionType,
      attempt: incident.remediationAttempts + 1,
      resourceId: instanceId
    });

    action.markRunning({ instanceId, containerName, region, endpoint });

    try {
      let executionResult = null;

      switch (actionType) {
        case ACTION_TYPES.START_CONTAINER:
          executionResult = await this._startContainer(instanceId, containerName, region);
          break;

        case ACTION_TYPES.RESTART_CONTAINER:
          executionResult = await this._restartContainer(instanceId, containerName, region);
          break;

        case ACTION_TYPES.RESTART_DOCKER_DAEMON:
          executionResult = await this._restartDockerDaemon(instanceId, region);
          break;

        case ACTION_TYPES.ROLLBACK_DEPLOYMENT:
          executionResult = await this._rollbackDeployment(projectId, awsState, region);
          break;

        case ACTION_TYPES.RETRY_HEALTH_PROBE:
          executionResult = { message: 'Retrying health check probe directly' };
          break;

        default:
          throw new Error(`Unsupported remediation action type: '${actionType}'`);
      }

      action.commandId = executionResult.commandId || null;

      // Real Verification Gate: Re-verify actual health
      const verification = await this.verifyHealth(endpoint, instanceId, containerName, region, options);

      if (verification.isHealthy) {
        action.markSuccess(executionResult, verification);
      } else {
        action.markFailed(new Error(`Post-remediation health verification failed: HTTP ${verification.httpStatus || 'offline'} (Status: ${verification.containerStatus})`), verification);
      }

      // Record in platform audit log
      auditService.log('SELF_HEALING_ACTION', {
        incidentId: incident.incidentId,
        projectId,
        actionType,
        status: action.status,
        commandId: action.commandId,
        durationMs: action.durationMs
      });

      return action;
    } catch (err) {
      action.markFailed(err);

      auditService.log('SELF_HEALING_ACTION_FAILED', {
        incidentId: incident.incidentId,
        projectId,
        actionType,
        error: err.message
      });

      return action;
    }
  }

  /**
   * Real SSM Docker Container Start
   */
  async _startContainer(instanceId, containerName, region) {
    const commands = [
      `docker start ${containerName}`,
      'sleep 2',
      `docker ps --filter name=${containerName}`
    ];
    const ssmRes = await ssmService.executeCommand(instanceId, commands, {
      region,
      timeoutSeconds: 45,
      comment: `Self-Healing Start ${containerName}`
    });
    return {
      commandId: ssmRes.commandId,
      status: ssmRes.status,
      stdout: this._maskSecrets(ssmRes.stdout)
    };
  }

  /**
   * Real SSM Docker Container Restart
   */
  async _restartContainer(instanceId, containerName, region) {
    const commands = [
      `docker restart -t 5 ${containerName}`,
      'sleep 2',
      `docker ps --filter name=${containerName}`
    ];
    const ssmRes = await ssmService.executeCommand(instanceId, commands, {
      region,
      timeoutSeconds: 45,
      comment: `Self-Healing Restart ${containerName}`
    });
    return {
      commandId: ssmRes.commandId,
      status: ssmRes.status,
      stdout: this._maskSecrets(ssmRes.stdout)
    };
  }

  /**
   * Real SSM Docker Daemon Restart
   */
  async _restartDockerDaemon(instanceId, region) {
    const commands = [
      'systemctl restart docker',
      'sleep 3',
      'systemctl is-active docker'
    ];
    const ssmRes = await ssmService.executeCommand(instanceId, commands, {
      region,
      timeoutSeconds: 45,
      comment: 'Self-Healing Restart Docker Daemon'
    });
    return {
      commandId: ssmRes.commandId,
      status: ssmRes.status,
      stdout: this._maskSecrets(ssmRes.stdout)
    };
  }

  /**
   * Real Deployment Rollback via ECR + SSM
   */
  async _rollbackDeployment(projectId, currentAwsState, region) {
    const prev = currentAwsState.previousDeployment;
    if (!prev || !prev.targetImageUri) {
      throw new Error(`Rollback failed: No previous known-good deployment record found for project '${projectId}'`);
    }

    const instanceId = currentAwsState.ec2.instanceId;
    const containerName = currentAwsState.deployment?.containerName || `cloudops-${projectId.slice(0, 8)}`;
    const port = currentAwsState.deployment?.port || 3000;
    const ecrRegistryHost = prev.targetImageUri.split('/')[0];

    const deployRes = await ssmService.deployDockerContainer(instanceId, {
      ecrRegistryHost,
      targetImageUri: prev.targetImageUri,
      containerName,
      port,
      region
    });

    return {
      rolledBackTo: prev.targetImageUri,
      containerName,
      status: 'ROLLED_BACK',
      stdout: this._maskSecrets(deployRes.stdout)
    };
  }

  /**
   * Real Health Verification Gate
   */
  async verifyHealth(endpoint, instanceId, containerName, region, options = {}) {
    const retries = options.healthCheckRetries || 3;
    const retryDelayMs = options.retryDelayMs || 2500;
    let latestProbe = null;

    // 1. Probe HTTP endpoint with retries
    if (endpoint) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        latestProbe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 5000 });
        if (latestProbe.isHealthy) {
          break;
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, retryDelayMs));
        }
      }
    }

    // 2. Query SSM for live container state
    let containerInfo = { status: 'unknown', isRunning: false };
    try {
      const dockerMetrics = await ssmService.getDockerMetrics(instanceId, containerName, region);
      if (dockerMetrics && dockerMetrics.container) {
        containerInfo = {
          status: dockerMetrics.container.status,
          isRunning: dockerMetrics.container.isRunning,
          restarts: dockerMetrics.container.restarts
        };
      }
    } catch {
      // Fallback
    }

    const isHealthy = Boolean((latestProbe?.isHealthy) || (containerInfo.isRunning && (!endpoint || latestProbe?.httpStatus === 200)));

    return {
      isHealthy,
      httpStatus: latestProbe?.httpStatus || null,
      responseTimeMs: latestProbe?.durationMs || null,
      containerStatus: containerInfo.status,
      containerRunning: containerInfo.isRunning,
      verifiedAt: new Date().toISOString()
    };
  }
}

module.exports = new RemediationExecutorService();
module.exports.RemediationExecutorService = RemediationExecutorService;
