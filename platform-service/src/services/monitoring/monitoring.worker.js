const cloudwatchService = require('../aws/cloudwatch.service');
const ssmService = require('../aws/ssm.service');
const ec2Service = require('../aws/ec2.service');
const healthProbeService = require('./health.probe.service');
const alertService = require('./alert.service');
const monitoringStorage = require('./monitoring.storage');
const storageService = require('../storage.service');
const config = require('../../config');

/**
 * Monitoring Worker & Orchestration Engine for the Autonomous CloudOps Platform.
 * Executes live monitoring cycles, persists real metrics, and manages alerts.
 */
class MonitoringWorker {
  constructor() {
    this.intervalSeconds = config.monitoring?.intervalSeconds || 60;
    this._timer = null;
    this._isRunning = false;
    this._isCycleInProgress = false;
  }

  /**
   * Starts the background monitoring polling loop
   */
  start(intervalSeconds = this.intervalSeconds) {
    if (this._isRunning) {
      return { started: false, message: 'Monitoring worker is already active' };
    }

    this.intervalSeconds = Math.max(15, parseInt(intervalSeconds, 10) || 60);
    this._isRunning = true;

    // Run initial cycle after 5 seconds
    const initTimer = setTimeout(() => {
      if (this._isRunning) {
        this.runCycle().catch(err => console.error('[MonitoringWorker] Initial cycle error:', err.message));
      }
    }, 5000);
    if (initTimer && typeof initTimer.unref === 'function') initTimer.unref();

    this._timer = setInterval(() => {
      if (this._isRunning) {
        this.runCycle().catch(err => console.error('[MonitoringWorker] Polling cycle error:', err.message));
      }
    }, this.intervalSeconds * 1000);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();

    return { started: true, intervalSeconds: this.intervalSeconds };
  }

  /**
   * Stops the background monitoring polling loop
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._isRunning = false;
    return { stopped: true };
  }

  isRunning() {
    return this._isRunning;
  }

  /**
   * Executes a monitoring cycle across all active deployed projects
   */
  async runCycle() {
    if (this._isCycleInProgress) {
      return { skipped: true, reason: 'Previous monitoring cycle still in progress' };
    }

    this._isCycleInProgress = true;
    const results = [];

    try {
      const projects = storageService.listProjects();

      for (const project of projects) {
        try {
          const awsState = storageService.getAWSState(project.id);
          if (awsState && (awsState.status === 'SUCCESS' || awsState.status === 'RUNNING' || awsState.ec2?.instanceId)) {
            const projectResult = await this.performMonitoringCycle(project.id);
            results.push({ projectId: project.id, success: true, result: projectResult });
          }
        } catch (projErr) {
          // Isolate project failure so it does not stop other projects
          console.error(`[MonitoringWorker] Error monitoring project '${project.id}':`, projErr.message);
          results.push({ projectId: project.id, success: false, error: projErr.message });
        }
      }
    } finally {
      this._isCycleInProgress = false;
    }

    return { executedAt: new Date().toISOString(), projectsCount: results.length, results };
  }

  /**
   * Performs an immediate, real monitoring cycle for a specific project.
   * Directly queries AWS CloudWatch, AWS SSM, Docker on EC2, and the Application Health endpoint.
   * @param {string} projectId Project identifier
   * @returns {Promise<object>} Complete live monitoring snapshot
   */
  async performMonitoringCycle(projectId) {
    const project = storageService.getProject(projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found`);
    }

    const awsState = storageService.getAWSState(projectId);
    if (!awsState || !awsState.ec2?.instanceId) {
      return {
        projectId,
        status: 'NOT_DEPLOYED',
        message: 'Project is not deployed to AWS EC2 infrastructure',
        timestamp: new Date().toISOString()
      };
    }

    const instanceId = awsState.ec2.instanceId;
    const region = awsState.ec2.region || config.aws.region || 'ap-south-1';
    const containerName = awsState.deployment?.containerName || awsState.container?.name || `cloudops-${projectId.slice(0, 8)}`;
    const port = awsState.deployment?.port || awsState.port || 3000;
    const publicIp = awsState.ec2.publicIp;
    const endpoint = awsState.endpoint || (publicIp ? `http://${publicIp}:${port}/health` : null);

    // 1. Live EC2 State via AWS EC2 API
    let ec2LiveInfo = {
      instanceId,
      region,
      state: 'unknown',
      publicIp: publicIp || null,
      privateIp: awsState.ec2.privateIp || null,
      instanceType: awsState.ec2.instanceType || 't3.micro',
      source: 'AWS EC2 API'
    };

    try {
      const ec2Client = require('../aws/aws.client').getEC2Client(region);
      const { DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
      const descCmd = new DescribeInstancesCommand({ InstanceIds: [instanceId] });
      const descRes = await ec2Client.send(descCmd);
      if (descRes.Reservations?.[0]?.Instances?.[0]) {
        const inst = descRes.Reservations[0].Instances[0];
        ec2LiveInfo = {
          instanceId,
          region,
          state: inst.State?.Name || 'unknown',
          publicIp: inst.PublicIpAddress || publicIp || null,
          privateIp: inst.PrivateIpAddress || null,
          instanceType: inst.InstanceType || 't3.micro',
          availabilityZone: inst.Placement?.AvailabilityZone || null,
          source: 'AWS EC2 API'
        };
      }
    } catch {
      // Use cached state
      ec2LiveInfo.state = awsState.ec2.state || 'running';
    }

    // 2. CloudWatch Standard Metrics (CPU, Network In/Out, Disk Ops)
    const cloudWatchMetrics = await cloudwatchService.getAllEC2Metrics(instanceId, { region, windowMinutes: 60 });

    // 3. AWS Systems Manager (SSM) Agent Connectivity
    const ssmInfo = await ssmService.getInstanceInformation(instanceId, region);

    // 4. Guest OS Metrics & Docker Container Metrics (via SSM)
    let osMetrics = {
      source: 'EC2 via SSM',
      status: ssmInfo.isOnline ? 'AVAILABLE' : 'UNAVAILABLE',
      memory: { source: 'EC2 via SSM', status: 'UNAVAILABLE', usedPercentage: null },
      disk: { source: 'EC2 via SSM', status: 'UNAVAILABLE', usedPercentage: null }
    };

    let dockerMetrics = {
      source: 'Docker via SSM',
      daemon: { source: 'Docker via SSM', status: ssmInfo.isOnline ? 'unknown' : 'unavailable', isActive: false },
      container: { source: 'Docker via SSM', name: containerName, status: ssmInfo.isOnline ? 'unknown' : 'UNAVAILABLE', restarts: 0 },
      stats: { source: 'Docker via SSM', status: 'UNAVAILABLE' }
    };

    let containerLogs = {
      source: 'Docker via SSM',
      linesCount: 0,
      logLines: [],
      logs: 'SSM Agent offline'
    };

    if (ssmInfo.isOnline && ec2LiveInfo.state === 'running') {
      const probeResult = await ssmService.getFullMonitoringProbe(instanceId, containerName, 100, region);
      osMetrics = {
        source: 'EC2 via SSM',
        memory: probeResult.memory,
        disk: probeResult.disk
      };
      dockerMetrics = {
        source: 'Docker via SSM',
        daemon: probeResult.daemon,
        container: probeResult.container,
        stats: probeResult.stats
      };
      containerLogs = probeResult.logs;
    }

    // 5. Real Application HTTP Health Probe
    let healthProbe = {
      source: 'HTTP Health Check',
      status: 'UNCONFIGURED',
      isHealthy: false,
      httpStatus: null,
      durationMs: null
    };

    if (endpoint) {
      healthProbe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 8000 });
    }

    // Assemble the complete live snapshot
    const timestamp = new Date().toISOString();
    const snapshot = {
      projectId,
      timestamp,
      status: (ec2LiveInfo.state === 'running' && healthProbe.isHealthy) ? 'HEALTHY' : (healthProbe.isHealthy ? 'DEGRADED' : 'UNHEALTHY'),
      ec2: {
        ...ec2LiveInfo,
        cpu: cloudWatchMetrics.cpu,
        network: cloudWatchMetrics.network,
        diskOps: cloudWatchMetrics.diskOps
      },
      ssm: ssmInfo,
      os: {
        source: 'EC2 via SSM',
        memory: osMetrics.memory,
        disk: osMetrics.disk
      },
      docker: dockerMetrics,
      application: healthProbe,
      logsSummary: {
        linesCount: containerLogs.linesCount,
        lastUpdated: containerLogs.timestamp
      }
    };

    // 6. Persistence & Time-series Recording
    monitoringStorage.saveLatestSnapshot(projectId, snapshot);

    monitoringStorage.recordMetricPoint(projectId, {
      timestamp,
      cpu: cloudWatchMetrics.cpu.value,
      memory: osMetrics.memory?.usedPercentage,
      disk: osMetrics.disk?.usedPercentage,
      networkIn: cloudWatchMetrics.network?.networkIn?.value,
      networkOut: cloudWatchMetrics.network?.networkOut?.value,
      responseTimeMs: healthProbe.durationMs
    });

    monitoringStorage.recordHealthCheck(projectId, healthProbe);
    monitoringStorage.saveLogs(projectId, containerLogs);

    // 7. Alert Evaluation & Auto-Resolution
    const existingAlerts = monitoringStorage.getAlerts(projectId);
    const alertEvaluation = alertService.evaluateSnapshot(projectId, snapshot, existingAlerts);
    monitoringStorage.saveAlerts(projectId, alertEvaluation.alerts);

    snapshot.alerts = {
      active: alertEvaluation.alerts.filter(a => a.status === 'ACTIVE'),
      acknowledged: alertEvaluation.alerts.filter(a => a.status === 'ACKNOWLEDGED'),
      activeCount: alertEvaluation.activeCount,
      totalCount: alertEvaluation.totalCount
    };

    // 8. Phase 9: Autonomous Self-Healing & Automatic Recovery Evaluation
    try {
      const selfHealingEngine = require('../selfHealing');
      const recoveryEvaluation = await selfHealingEngine.evaluateProject(projectId, snapshot);
      snapshot.recovery = recoveryEvaluation;
    } catch (recoveryErr) {
      console.error(`[MonitoringWorker] Self-Healing evaluation error for '${projectId}':`, recoveryErr.message);
    }

    return snapshot;
  }
}

module.exports = new MonitoringWorker();
module.exports.MonitoringWorker = MonitoringWorker;
