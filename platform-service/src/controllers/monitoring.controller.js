const {
  monitoringWorker,
  monitoringStorage,
  alertService,
  healthProbeService
} = require('../services/monitoring');
const storageService = require('../services/storage.service');

/**
 * Controller for Real-Time Monitoring & Observability APIs
 */
class MonitoringController {
  /**
   * GET /api/projects/:projectId/monitoring/status
   * Returns the consolidated monitoring snapshot
   */
  async getStatus(req, res, next) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      let snapshot = monitoringStorage.getLatestSnapshot(projectId);
      
      // If no snapshot exists yet, perform an initial live check
      if (!snapshot) {
        snapshot = await monitoringWorker.performMonitoringCycle(projectId);
      }

      return res.status(200).json(snapshot);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/monitoring/metrics
   * Returns time-series metric history for charts
   */
  async getMetrics(req, res, next) {
    try {
      const { projectId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
      
      const history = monitoringStorage.getMetricHistory(projectId, { limit });
      return res.status(200).json({
        projectId,
        count: history.length,
        metrics: history
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/monitoring/health
   * Returns health check history and failure rate summary
   */
  async getHealth(req, res, next) {
    try {
      const { projectId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;

      const history = monitoringStorage.getHealthHistory(projectId, { limit });
      const summary = healthProbeService.calculateHealthSummary(history);

      return res.status(200).json({
        projectId,
        summary,
        history
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/monitoring/logs
   * Returns recent real container logs
   */
  async getLogs(req, res, next) {
    try {
      const { projectId } = req.params;
      const lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;

      const logs = monitoringStorage.getLogs(projectId);
      if (!logs) {
        return res.status(200).json({
          projectId,
          linesCount: 0,
          logLines: [],
          logs: 'No logs recorded yet. Perform a monitoring check to retrieve logs.'
        });
      }

      return res.status(200).json(logs);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/monitoring/alerts
   * Returns alerts list
   */
  async getAlerts(req, res, next) {
    try {
      const { projectId } = req.params;
      const alerts = monitoringStorage.getAlerts(projectId);
      const activeCount = alerts.filter(a => a.status === 'ACTIVE').length;
      const acknowledgedCount = alerts.filter(a => a.status === 'ACKNOWLEDGED').length;

      return res.status(200).json({
        projectId,
        activeCount,
        acknowledgedCount,
        totalCount: alerts.length,
        alerts
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/monitoring/check
   * Forces an immediate real monitoring cycle
   */
  async triggerManualCheck(req, res, next) {
    try {
      const { projectId } = req.params;
      const snapshot = await monitoringWorker.performMonitoringCycle(projectId);
      return res.status(200).json(snapshot);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/monitoring/start
   * Starts monitoring polling loop
   */
  async startMonitoring(req, res, next) {
    try {
      const interval = req.body?.intervalSeconds;
      const result = monitoringWorker.start(interval);
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/monitoring/stop
   * Stops monitoring polling loop
   */
  async stopMonitoring(req, res, next) {
    try {
      const result = monitoringWorker.stop();
      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/monitoring/alerts/:alertId/acknowledge
   * Acknowledges an active alert
   */
  async acknowledgeAlert(req, res, next) {
    try {
      const { projectId, alertId } = req.params;
      const acknowledgedBy = req.body?.acknowledgedBy || 'operator';
      const note = req.body?.note || '';

      const alerts = monitoringStorage.getAlerts(projectId);
      const updatedAlerts = alertService.acknowledgeAlert(alerts, alertId, acknowledgedBy, note);
      monitoringStorage.saveAlerts(projectId, updatedAlerts);

      const target = updatedAlerts.find(a => a.id === alertId);
      if (!target) {
        return res.status(404).json({ error: `Alert '${alertId}' not found` });
      }

      return res.status(200).json({
        success: true,
        alert: target
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new MonitoringController();
