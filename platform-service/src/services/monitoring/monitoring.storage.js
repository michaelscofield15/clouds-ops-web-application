const fs = require('fs');
const path = require('path');
const config = require('../../config');

/**
 * Storage service for monitoring metrics, health history, alerts, and logs.
 * Enforces bounded retention (default: 24 hours, max entries limit) to prevent unbounded disk growth.
 */
class MonitoringStorage {
  constructor(baseProjectsDir) {
    this.baseProjectsDir = baseProjectsDir || path.join(__dirname, '../../../temporary/projects');
    this.maxRetentionHours = 24;
    this.maxMetricEntries = 500;
    this.maxHealthEntries = 200;
    this.maxAlertEntries = 100;
  }

  _getMonitoringDir(projectId) {
    const dir = path.join(this.baseProjectsDir, projectId, 'monitoring');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  _readJsonFile(filePath, defaultValue) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore read error
    }
    return defaultValue;
  }

  _writeJsonFile(filePath, data) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[MonitoringStorage] Error writing ${filePath}:`, err.message);
    }
  }

  /**
   * Saves latest monitoring snapshot
   */
  saveLatestSnapshot(projectId, snapshot) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'latest-snapshot.json');
    this._writeJsonFile(filePath, snapshot);
    return snapshot;
  }

  /**
   * Retrieves latest monitoring snapshot
   */
  getLatestSnapshot(projectId) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'latest-snapshot.json');
    return this._readJsonFile(filePath, null);
  }

  /**
   * Appends time-series metric point and enforces retention limit
   */
  recordMetricPoint(projectId, metricPoint) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'metrics-history.json');
    let history = this._readJsonFile(filePath, []);

    const point = {
      timestamp: metricPoint.timestamp || new Date().toISOString(),
      cpu: typeof metricPoint.cpu === 'number' ? metricPoint.cpu : null,
      memory: typeof metricPoint.memory === 'number' ? metricPoint.memory : null,
      disk: typeof metricPoint.disk === 'number' ? metricPoint.disk : null,
      networkIn: typeof metricPoint.networkIn === 'number' ? metricPoint.networkIn : null,
      networkOut: typeof metricPoint.networkOut === 'number' ? metricPoint.networkOut : null,
      responseTimeMs: typeof metricPoint.responseTimeMs === 'number' ? metricPoint.responseTimeMs : null
    };

    history.push(point);

    // Prune entries older than retention window or exceeding max entries
    const cutoffTime = Date.now() - (this.maxRetentionHours * 60 * 60 * 1000);
    history = history.filter(p => new Date(p.timestamp).getTime() >= cutoffTime);

    if (history.length > this.maxMetricEntries) {
      history = history.slice(-this.maxMetricEntries);
    }

    this._writeJsonFile(filePath, history);
    return history;
  }

  /**
   * Retrieves metric history for charts
   */
  getMetricHistory(projectId, options = {}) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'metrics-history.json');
    let history = this._readJsonFile(filePath, []);

    if (options.limit && typeof options.limit === 'number') {
      history = history.slice(-options.limit);
    }

    return history;
  }

  /**
   * Appends health check result and prunes history
   */
  recordHealthCheck(projectId, healthResult) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'health-history.json');
    let history = this._readJsonFile(filePath, []);

    history.push({
      timestamp: healthResult.timestamp || new Date().toISOString(),
      status: healthResult.status,
      isHealthy: healthResult.isHealthy,
      httpStatus: healthResult.httpStatus,
      durationMs: healthResult.durationMs,
      endpoint: healthResult.endpoint,
      error: healthResult.error || null
    });

    if (history.length > this.maxHealthEntries) {
      history = history.slice(-this.maxHealthEntries);
    }

    this._writeJsonFile(filePath, history);
    return history;
  }

  /**
   * Retrieves health history
   */
  getHealthHistory(projectId, options = {}) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'health-history.json');
    let history = this._readJsonFile(filePath, []);

    if (options.limit && typeof options.limit === 'number') {
      history = history.slice(-options.limit);
    }

    return history;
  }

  /**
   * Saves alerts list
   */
  saveAlerts(projectId, alerts) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'alerts.json');
    let bounded = Array.isArray(alerts) ? alerts : [];
    if (bounded.length > this.maxAlertEntries) {
      bounded = bounded.slice(0, this.maxAlertEntries);
    }
    this._writeJsonFile(filePath, bounded);
    return bounded;
  }

  /**
   * Retrieves alerts list
   */
  getAlerts(projectId) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'alerts.json');
    return this._readJsonFile(filePath, []);
  }

  /**
   * Saves latest container logs snapshot
   */
  saveLogs(projectId, logsData) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'latest-logs.json');
    this._writeJsonFile(filePath, logsData);
    return logsData;
  }

  /**
   * Retrieves latest container logs snapshot
   */
  getLogs(projectId) {
    const dir = this._getMonitoringDir(projectId);
    const filePath = path.join(dir, 'latest-logs.json');
    return this._readJsonFile(filePath, null);
  }
}

module.exports = new MonitoringStorage();
module.exports.MonitoringStorage = MonitoringStorage;
