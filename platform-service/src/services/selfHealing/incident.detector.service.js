const { Incident, INCIDENT_TYPES, INCIDENT_SEVERITIES, INCIDENT_STATUSES } = require('./incident.model');
const remediationPolicyService = require('./remediationPolicy.service');

class IncidentDetectorService {
  /**
   * Evaluates a monitoring snapshot and produces detected incidents, correlating related symptoms.
   * @param {string} projectId Project identifier
   * @param {object} snapshot Live monitoring snapshot from Phase 7
   * @param {Array<Incident>} existingIncidents Currently known incidents for the project
   * @returns {Array<Incident>} List of new or updated incidents
   */
  detectIncidents(projectId, snapshot = {}, existingIncidents = []) {
    if (!snapshot || !projectId) return [];

    const rawDetections = [];
    const containerName = snapshot.docker?.container?.name || `cloudops-${projectId.slice(0, 8)}`;
    const instanceId = snapshot.ec2?.instanceId || null;

    // 1. Check Docker Daemon
    if (snapshot.docker?.daemon && snapshot.docker.daemon.status === 'stopped') {
      rawDetections.push({
        type: INCIDENT_TYPES.DOCKER_DAEMON_STOPPED,
        severity: INCIDENT_SEVERITIES.CRITICAL,
        resourceId: instanceId,
        resourceType: 'EC2',
        failureMessage: `Docker system daemon is stopped on EC2 instance '${instanceId}'`,
        currentValue: 'stopped',
        threshold: 'running',
        evidence: { daemon: snapshot.docker.daemon }
      });
    }

    // 2. Check Docker Container State
    if (snapshot.docker?.container) {
      const c = snapshot.docker.container;
      const restarts = c.restarts || 0;

      if (restarts >= 3) {
        rawDetections.push({
          type: INCIDENT_TYPES.CONTAINER_RESTART_LOOP,
          severity: INCIDENT_SEVERITIES.CRITICAL,
          resourceId: containerName,
          resourceType: 'CONTAINER',
          failureMessage: `Container '${containerName}' is in a crash restart loop (${restarts} restarts)`,
          currentValue: restarts,
          threshold: 3,
          evidence: { container: c }
        });
      } else if (c.status === 'stopped' || c.status === 'dead' || c.status === 'oom_killed' || c.isRunning === false) {
        if (c.status !== 'CONTAINER_NOT_FOUND') {
          rawDetections.push({
            type: (c.status === 'dead' || c.status === 'oom_killed') ? INCIDENT_TYPES.CONTAINER_CRASHED : INCIDENT_TYPES.CONTAINER_STOPPED,
            severity: INCIDENT_SEVERITIES.CRITICAL,
            resourceId: containerName,
            resourceType: 'CONTAINER',
            failureMessage: `Docker container '${containerName}' is ${c.status} on instance '${instanceId}'`,
            currentValue: c.status,
            threshold: 'running',
            evidence: { container: c }
          });
        }
      }
    }

    // 3. Check Application HTTP Health Probe
    if (snapshot.application) {
      const app = snapshot.application;
      if (!app.isHealthy && app.status !== 'UNCONFIGURED') {
        const is5xx = app.httpStatus && app.httpStatus >= 500 && app.httpStatus < 600;
        rawDetections.push({
          type: is5xx ? INCIDENT_TYPES.HEALTH_CHECK_5XX : INCIDENT_TYPES.HEALTH_CHECK_FAILED,
          severity: INCIDENT_SEVERITIES.CRITICAL,
          resourceId: containerName,
          resourceType: 'APP',
          failureMessage: `Application health check failed: HTTP ${app.httpStatus || 'No Response'} (${app.error || 'Connection refused or timeout'})`,
          currentValue: app.httpStatus || 'offline',
          threshold: 200,
          evidence: { application: app }
        });
      }
    }

    // 4. Check SSM Connectivity
    if (snapshot.ssm) {
      if (snapshot.ssm.pingStatus && snapshot.ssm.pingStatus !== 'Online') {
        rawDetections.push({
          type: INCIDENT_TYPES.SSM_OFFLINE,
          severity: INCIDENT_SEVERITIES.CRITICAL,
          resourceId: instanceId,
          resourceType: 'SSM',
          failureMessage: `AWS SSM agent is unreachable or offline (Status: ${snapshot.ssm.pingStatus})`,
          currentValue: snapshot.ssm.pingStatus,
          threshold: 'Online',
          evidence: { ssm: snapshot.ssm }
        });
      }
    }

    // 5. Check EC2 Instance State
    if (snapshot.ec2 && snapshot.ec2.state && snapshot.ec2.state !== 'running' && snapshot.ec2.state !== 'unknown') {
      rawDetections.push({
        type: INCIDENT_TYPES.EC2_STOPPED,
        severity: INCIDENT_SEVERITIES.CRITICAL,
        resourceId: instanceId,
        resourceType: 'EC2',
        failureMessage: `EC2 instance '${instanceId}' is not running (State: ${snapshot.ec2.state})`,
        currentValue: snapshot.ec2.state,
        threshold: 'running',
        evidence: { ec2: snapshot.ec2 }
      });
    }

    // 6. Check High Resource Alerts from Snapshot (CPU, Memory, Disk)
    if (snapshot.alerts?.active) {
      for (const alert of snapshot.alerts.active) {
        if (alert.type === 'HIGH_CPU_UTILIZATION') {
          rawDetections.push({
            type: INCIDENT_TYPES.HIGH_CPU_UTILIZATION,
            severity: alert.severity || INCIDENT_SEVERITIES.WARNING,
            resourceId: instanceId,
            resourceType: 'EC2',
            failureMessage: alert.message,
            currentValue: alert.currentValue,
            threshold: alert.threshold,
            evidence: { alert }
          });
        } else if (alert.type === 'HIGH_MEMORY_UTILIZATION') {
          rawDetections.push({
            type: INCIDENT_TYPES.HIGH_MEMORY_UTILIZATION,
            severity: alert.severity || INCIDENT_SEVERITIES.WARNING,
            resourceId: instanceId,
            resourceType: 'EC2',
            failureMessage: alert.message,
            currentValue: alert.currentValue,
            threshold: alert.threshold,
            evidence: { alert }
          });
        } else if (alert.type === 'HIGH_DISK_UTILIZATION') {
          rawDetections.push({
            type: INCIDENT_TYPES.HIGH_DISK_UTILIZATION,
            severity: alert.severity || INCIDENT_SEVERITIES.WARNING,
            resourceId: instanceId,
            resourceType: 'EC2',
            failureMessage: alert.message,
            currentValue: alert.currentValue,
            threshold: alert.threshold,
            evidence: { alert }
          });
        }
      }
    }

    // 7. Correlate Detections
    const correlatedDetections = this._correlateSymptoms(rawDetections);

    // 8. Map to Incident Models & Match Existing Active Incidents
    const resultingIncidents = [];
    const activeExistingMap = new Map();

    for (const inc of existingIncidents) {
      if (inc.status !== INCIDENT_STATUSES.RESOLVED && inc.status !== INCIDENT_STATUSES.FAILED) {
        activeExistingMap.set(`${inc.type}:${inc.resourceId}`, inc);
      }
    }

    for (const det of correlatedDetections) {
      const key = `${det.type}:${det.resourceId}`;
      let incident = activeExistingMap.get(key);

      if (incident) {
        // Update existing active incident
        incident.lastSeenAt = new Date().toISOString();
        incident.failureMessage = det.failureMessage;
        incident.currentValue = det.currentValue;
        incident.evidence = { ...incident.evidence, ...det.evidence };
        resultingIncidents.push(incident);
      } else {
        // Create new incident
        const policy = remediationPolicyService.getPolicy(det.type);
        incident = new Incident({
          projectId,
          type: det.type,
          severity: det.severity || policy.severity,
          resourceId: det.resourceId,
          resourceType: det.resourceType,
          failureMessage: det.failureMessage,
          currentValue: det.currentValue,
          threshold: det.threshold,
          remediationPolicy: policy.description,
          maxAttempts: policy.maxAttempts,
          evidence: det.evidence
        });
        resultingIncidents.push(incident);
      }
    }

    return resultingIncidents;
  }

  /**
   * Correlates symptoms to identify the root cause incident.
   * If a container is stopped or daemon is stopped, suppresses separate HEALTH_CHECK_FAILED incident.
   */
  _correlateSymptoms(detections = []) {
    const hasDaemonStopped = detections.some(d => d.type === INCIDENT_TYPES.DOCKER_DAEMON_STOPPED);
    const hasContainerStopped = detections.some(d => d.type === INCIDENT_TYPES.CONTAINER_STOPPED || d.type === INCIDENT_TYPES.CONTAINER_CRASHED || d.type === INCIDENT_TYPES.CONTAINER_RESTART_LOOP);
    const hasEC2Stopped = detections.some(d => d.type === INCIDENT_TYPES.EC2_STOPPED);
    const hasSSMOffline = detections.some(d => d.type === INCIDENT_TYPES.SSM_OFFLINE);

    return detections.filter(d => {
      // If EC2 or SSM is down, don't create independent container/app incidents
      if ((hasEC2Stopped || hasSSMOffline) && (d.type === INCIDENT_TYPES.CONTAINER_STOPPED || d.type === INCIDENT_TYPES.HEALTH_CHECK_FAILED || d.type === INCIDENT_TYPES.HEALTH_CHECK_5XX)) {
        return false;
      }
      // If container is stopped, correlate health check failure as a symptom rather than creating a separate incident
      if ((hasContainerStopped || hasDaemonStopped) && (d.type === INCIDENT_TYPES.HEALTH_CHECK_FAILED || d.type === INCIDENT_TYPES.HEALTH_CHECK_5XX)) {
        return false;
      }
      return true;
    });
  }
}

module.exports = new IncidentDetectorService();
module.exports.IncidentDetectorService = IncidentDetectorService;
