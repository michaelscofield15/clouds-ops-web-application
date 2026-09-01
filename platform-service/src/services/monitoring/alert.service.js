const crypto = require('crypto');

/**
 * Default configurable alert thresholds and rules
 */
const DEFAULT_ALERT_THRESHOLDS = {
  cpu: {
    warning: 80.0,
    critical: 90.0
  },
  memory: {
    warning: 85.0,
    critical: 95.0
  },
  disk: {
    warning: 85.0,
    critical: 95.0
  },
  responseTimeMs: {
    warning: 2000,
    critical: 5000
  },
  containerRestarts: {
    warning: 1,
    critical: 4
  }
};

/**
 * Alert Engine for real-time infrastructure and application observability.
 * Manages alert evaluation, deduplication, lifecycle transitions, and auto-resolution.
 */
class AlertService {
  constructor(customThresholds = {}) {
    this.thresholds = {
      ...DEFAULT_ALERT_THRESHOLDS,
      ...customThresholds
    };
  }

  /**
   * Generates a deterministic alert key for deduplication
   */
  _generateAlertKey(projectId, type, source) {
    return `${projectId}:${type}:${source}`;
  }

  /**
   * Evaluates a full infrastructure and application monitoring snapshot against alert rules.
   * @param {string} projectId Project ID
   * @param {object} snapshot Live metrics and health snapshot
   * @param {Array<object>} existingAlerts Current active or past alerts for the project
   * @returns {object} { updatedAlerts, newAlertsCount, resolvedAlertsCount }
   */
  evaluateSnapshot(projectId, snapshot, existingAlerts = []) {
    const alertsMap = new Map();
    // Index existing alerts by their unique key
    for (const a of existingAlerts) {
      const key = a.key || a.dedupKey || this._generateAlertKey(a.projectId || projectId, a.type, a.source);
      alertsMap.set(key, { ...a, key });
    }

    const evaluatedKeys = new Set();
    const evaluatedConditions = [];

    // Helper to evaluate a numeric threshold metric
    const evaluateMetricCondition = (type, source, currentValue, unit, warningThreshold, criticalThreshold, metricTitle) => {
      if (typeof currentValue !== 'number' || isNaN(currentValue)) {
        return;
      }

      const key = this._generateAlertKey(projectId, type, source);
      evaluatedKeys.add(key);

      const isCritical = currentValue >= criticalThreshold;
      const isWarning = currentValue >= warningThreshold;

      if (isCritical || isWarning) {
        const severity = isCritical ? 'CRITICAL' : 'WARNING';
        const threshold = isCritical ? criticalThreshold : warningThreshold;
        const message = `${metricTitle} utilization is high: ${currentValue}${unit} (Threshold: ${threshold}${unit})`;

        this._upsertActiveAlert(alertsMap, {
          key,
          projectId,
          type,
          source,
          severity,
          message,
          currentValue,
          threshold,
          unit
        });
      } else {
        // Condition is normal -> resolve any active alert
        this._resolveAlertIfActive(alertsMap, key, `${metricTitle} returned to normal (${currentValue}${unit} < ${warningThreshold}${unit})`);
      }
    };

    // 1. EC2 CPU Utilization (AWS CloudWatch)
    if (snapshot.ec2 && snapshot.ec2.cpu && typeof snapshot.ec2.cpu.value === 'number') {
      evaluateMetricCondition(
        'HIGH_CPU_UTILIZATION',
        'AWS CloudWatch',
        snapshot.ec2.cpu.value,
        '%',
        this.thresholds.cpu.warning,
        this.thresholds.cpu.critical,
        'EC2 CPU'
      );
    }

    // 2. Guest OS Memory Utilization (EC2 via SSM)
    if (snapshot.os && snapshot.os.memory && typeof snapshot.os.memory.usedPercentage === 'number') {
      evaluateMetricCondition(
        'HIGH_MEMORY_UTILIZATION',
        'EC2 via SSM',
        snapshot.os.memory.usedPercentage,
        '%',
        this.thresholds.memory.warning,
        this.thresholds.memory.critical,
        'Guest OS Memory'
      );
    }

    // 3. Guest Filesystem Disk Utilization (EC2 via SSM)
    if (snapshot.os && snapshot.os.disk && typeof snapshot.os.disk.usedPercentage === 'number') {
      evaluateMetricCondition(
        'HIGH_DISK_UTILIZATION',
        'EC2 via SSM',
        snapshot.os.disk.usedPercentage,
        '%',
        this.thresholds.disk.warning,
        this.thresholds.disk.critical,
        'Filesystem Disk'
      );
    }

    // 4. SSM Agent Health (AWS Systems Manager)
    if (snapshot.ssm) {
      const key = this._generateAlertKey(projectId, 'SSM_OFFLINE', 'AWS Systems Manager');
      evaluatedKeys.add(key);

      if (snapshot.ssm.pingStatus && snapshot.ssm.pingStatus !== 'Online') {
        this._upsertActiveAlert(alertsMap, {
          key,
          projectId,
          type: 'SSM_OFFLINE',
          source: 'AWS Systems Manager',
          severity: 'CRITICAL',
          message: `SSM Agent is unhealthy or unreachable (Status: ${snapshot.ssm.pingStatus})`,
          currentValue: snapshot.ssm.pingStatus,
          threshold: 'Online',
          unit: 'status'
        });
      } else if (snapshot.ssm.pingStatus === 'Online') {
        this._resolveAlertIfActive(alertsMap, key, 'SSM Agent connectivity restored to Online');
      }
    }

    // 5. EC2 Instance State (AWS EC2)
    if (snapshot.ec2 && snapshot.ec2.state) {
      const key = this._generateAlertKey(projectId, 'EC2_STOPPED', 'AWS EC2');
      evaluatedKeys.add(key);

      if (snapshot.ec2.state !== 'running') {
        this._upsertActiveAlert(alertsMap, {
          key,
          projectId,
          type: 'EC2_STOPPED',
          source: 'AWS EC2',
          severity: 'CRITICAL',
          message: `EC2 Instance '${snapshot.ec2.instanceId || 'unknown'}' is not running (State: ${snapshot.ec2.state})`,
          currentValue: snapshot.ec2.state,
          threshold: 'running',
          unit: 'state'
        });
      } else {
        this._resolveAlertIfActive(alertsMap, key, 'EC2 Instance state is running');
      }
    }

    // 6. Docker Container State & Restarts (Docker via SSM)
    if (snapshot.docker && snapshot.docker.container) {
      const container = snapshot.docker.container;
      const stateKey = this._generateAlertKey(projectId, 'CONTAINER_STOPPED', 'Docker via SSM');
      evaluatedKeys.add(stateKey);

      if (container.status !== 'running' && container.status !== 'CONTAINER_NOT_FOUND') {
        const severity = (container.status === 'dead' || container.status === 'oom_killed') ? 'CRITICAL' : 'WARNING';
        this._upsertActiveAlert(alertsMap, {
          key: stateKey,
          projectId,
          type: 'CONTAINER_STOPPED',
          source: 'Docker via SSM',
          severity,
          message: `Docker container '${container.name}' is not running (Status: ${container.status})`,
          currentValue: container.status,
          threshold: 'running',
          unit: 'status'
        });
      } else if (container.status === 'running') {
        this._resolveAlertIfActive(alertsMap, stateKey, `Docker container '${container.name}' is running`);
      }

      // Restart count monitoring
      if (typeof container.restarts === 'number') {
        const restartKey = this._generateAlertKey(projectId, 'CONTAINER_RESTARTS_DETECTED', 'Docker via SSM');
        evaluatedKeys.add(restartKey);

        if (container.restarts >= this.thresholds.containerRestarts.warning) {
          const isCritical = container.restarts >= this.thresholds.containerRestarts.critical;
          this._upsertActiveAlert(alertsMap, {
            key: restartKey,
            projectId,
            type: 'CONTAINER_RESTARTS_DETECTED',
            source: 'Docker via SSM',
            severity: isCritical ? 'CRITICAL' : 'WARNING',
            message: `Docker container '${container.name}' has restarted ${container.restarts} time(s)`,
            currentValue: container.restarts,
            threshold: this.thresholds.containerRestarts.warning,
            unit: 'restarts'
          });
        }
      }
    }

    // 7. Application HTTP Health Check (HTTP Health Probe)
    if (snapshot.application) {
      const app = snapshot.application;
      const healthKey = this._generateAlertKey(projectId, 'APPLICATION_UNHEALTHY', 'HTTP Health Check');
      evaluatedKeys.add(healthKey);

      if (!app.isHealthy && app.status !== 'UNCONFIGURED') {
        this._upsertActiveAlert(alertsMap, {
          key: healthKey,
          projectId,
          type: 'APPLICATION_UNHEALTHY',
          source: 'HTTP Health Check',
          severity: 'CRITICAL',
          message: `Application health check failed: ${app.error || app.status} (HTTP Status: ${app.httpStatus || 'None'})`,
          currentValue: app.httpStatus || app.status,
          threshold: '200 OK',
          unit: 'status'
        });
      } else if (app.isHealthy) {
        this._resolveAlertIfActive(alertsMap, healthKey, `Application health check passing (HTTP ${app.httpStatus}, ${app.durationMs}ms)`);
      }

      // Latency threshold
      if (typeof app.durationMs === 'number' && app.isHealthy) {
        evaluateMetricCondition(
          'HIGH_RESPONSE_TIME',
          'HTTP Health Check',
          app.durationMs,
          'ms',
          this.thresholds.responseTimeMs.warning,
          this.thresholds.responseTimeMs.critical,
          'Application Response Latency'
        );
      }
    }

    // Convert map to array and sort: ACTIVE/ACKNOWLEDGED first, then sorted by lastSeen descending
    const allAlerts = Array.from(alertsMap.values()).sort((a, b) => {
      const activeScore = (s) => (s === 'ACTIVE' ? 3 : s === 'ACKNOWLEDGED' ? 2 : 1);
      const scoreDiff = activeScore(b.status) - activeScore(a.status);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    });

    const activeCount = allAlerts.filter(a => a.status === 'ACTIVE').length;
    const acknowledgedCount = allAlerts.filter(a => a.status === 'ACKNOWLEDGED').length;

    return {
      alerts: allAlerts,
      activeCount,
      acknowledgedCount,
      totalCount: allAlerts.length,
      evaluatedAt: new Date().toISOString()
    };
  }

  /**
   * Internal helper to upsert active alerts with deduplication
   */
  _upsertActiveAlert(alertsMap, alertData) {
    const now = new Date().toISOString();
    const existing = alertsMap.get(alertData.key);

    if (existing && (existing.status === 'ACTIVE' || existing.status === 'ACKNOWLEDGED')) {
      // Deduplicate: update last seen and current value
      alertsMap.set(alertData.key, {
        ...existing,
        severity: alertData.severity, // allow escalation from WARNING to CRITICAL
        message: alertData.message,
        currentValue: alertData.currentValue,
        lastSeen: now,
        occurrences: (existing.occurrences || 1) + 1
      });
    } else {
      // Create new active alert
      const id = 'alt-' + crypto.randomBytes(6).toString('hex');
      alertsMap.set(alertData.key, {
        id,
        key: alertData.key,
        projectId: alertData.projectId,
        type: alertData.type,
        source: alertData.source,
        severity: alertData.severity,
        message: alertData.message,
        currentValue: alertData.currentValue,
        threshold: alertData.threshold,
        unit: alertData.unit,
        status: 'ACTIVE',
        firstSeen: now,
        lastSeen: now,
        occurrences: 1,
        resolvedAt: null,
        resolutionMessage: null
      });
    }
  }

  /**
   * Internal helper to resolve an active alert when condition normalizes
   */
  _resolveAlertIfActive(alertsMap, key, resolutionMessage) {
    const existing = alertsMap.get(key);
    if (existing && (existing.status === 'ACTIVE' || existing.status === 'ACKNOWLEDGED')) {
      alertsMap.set(key, {
        ...existing,
        status: 'RESOLVED',
        resolvedAt: new Date().toISOString(),
        resolutionMessage: resolutionMessage || 'Condition normalized'
      });
    }
  }

  /**
   * Acknowledges an active alert
   */
  acknowledgeAlert(alertsList, alertId, acknowledgedBy = 'operator', note = '') {
    const updated = alertsList.map(alert => {
      if (alert.id === alertId && alert.status === 'ACTIVE') {
        return {
          ...alert,
          status: 'ACKNOWLEDGED',
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy,
          acknowledgmentNote: note,
          acknowledgementNote: note
        };
      }
      return alert;
    });

    return updated;
  }
}

module.exports = new AlertService();
module.exports.AlertService = AlertService;
module.exports.DEFAULT_ALERT_THRESHOLDS = DEFAULT_ALERT_THRESHOLDS;
