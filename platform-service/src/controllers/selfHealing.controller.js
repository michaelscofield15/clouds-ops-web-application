const selfHealingEngine = require('../services/selfHealing');
const monitoringWorker = require('../services/monitoring/monitoring.worker');
const storageService = require('../services/storage.service');

/**
 * Controller for Autonomous Self-Healing and Recovery APIs
 */
class SelfHealingController {
  /**
   * GET /api/recovery/status
   */
  async getGlobalStatus(req, res) {
    try {
      const stats = selfHealingEngine.getStatus();
      return res.status(200).json(stats);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve global recovery status', message: err.message });
    }
  }

  /**
   * POST /api/recovery/pause
   */
  async pauseGlobalRecovery(req, res) {
    try {
      selfHealingEngine.storage.setGlobalAutoRecovery(false);
      return res.status(200).json({
        success: true,
        globalAutoRecovery: false,
        message: 'Global autonomous recovery has been paused (SAFETY_LOCK)'
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to pause recovery engine', message: err.message });
    }
  }

  /**
   * POST /api/recovery/resume
   */
  async resumeGlobalRecovery(req, res) {
    try {
      selfHealingEngine.storage.setGlobalAutoRecovery(true);
      return res.status(200).json({
        success: true,
        globalAutoRecovery: true,
        message: 'Global autonomous recovery has been resumed'
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to resume recovery engine', message: err.message });
    }
  }

  /**
   * GET /api/projects/:projectId/recovery/status
   */
  async getProjectRecoveryStatus(req, res) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      const status = selfHealingEngine.getStatus(projectId);
      return res.status(200).json(status);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve project recovery status', message: err.message });
    }
  }

  /**
   * POST /api/projects/:projectId/recovery/settings
   */
  async updateProjectSettings(req, res) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      const updated = selfHealingEngine.storage.saveProjectSettings(projectId, req.body || {});
      return res.status(200).json({ success: true, settings: updated });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to update recovery settings', message: err.message });
    }
  }

  /**
   * GET /api/projects/:projectId/incidents
   */
  async getProjectIncidents(req, res) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      const incidents = selfHealingEngine.storage.getIncidents(projectId);
      return res.status(200).json({
        projectId,
        count: incidents.length,
        incidents
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve incidents', message: err.message });
    }
  }

  /**
   * GET /api/projects/:projectId/incidents/:incidentId
   */
  async getIncidentDetail(req, res) {
    try {
      const { projectId, incidentId } = req.params;
      const incident = selfHealingEngine.storage.getIncident(projectId, incidentId);
      if (!incident) {
        return res.status(404).json({ error: `Incident '${incidentId}' not found for project '${projectId}'` });
      }

      const allRemediations = selfHealingEngine.storage.getRemediations(projectId);
      const relatedRemediations = allRemediations.filter(r => r.incidentId === incidentId);

      return res.status(200).json({
        incident,
        remediations: relatedRemediations
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve incident detail', message: err.message });
    }
  }

  /**
   * GET /api/projects/:projectId/remediations
   */
  async getProjectRemediations(req, res) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      const remediations = selfHealingEngine.storage.getRemediations(projectId);
      return res.status(200).json({
        projectId,
        count: remediations.length,
        remediations
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve remediations', message: err.message });
    }
  }

  /**
   * POST /api/projects/:projectId/recovery/check
   * Triggers an immediate live monitoring probe & self-healing evaluation cycle
   */
  async triggerRecoveryCheck(req, res) {
    try {
      const { projectId } = req.params;
      const project = storageService.getProject(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project '${projectId}' not found` });
      }

      // Execute live probe
      const snapshot = await monitoringWorker.performMonitoringCycle(projectId);
      // Run self-healing evaluation
      const result = await selfHealingEngine.evaluateProject(projectId, snapshot, req.body || {});

      return res.status(200).json({
        success: true,
        snapshotStatus: snapshot.status,
        result
      });
    } catch (err) {
      return res.status(500).json({ error: 'Recovery check failed', message: err.message });
    }
  }

  /**
   * POST /api/projects/:projectId/incidents/:incidentId/acknowledge
   */
  async acknowledgeIncident(req, res) {
    try {
      const { projectId, incidentId } = req.params;
      const operator = req.body?.operator || 'Operator';
      const incident = selfHealingEngine.acknowledgeIncident(projectId, incidentId, operator);
      return res.status(200).json({ success: true, incident });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to acknowledge incident', message: err.message });
    }
  }

  /**
   * POST /api/projects/:projectId/incidents/:incidentId/approve
   * Operator manually approves execution of remediation
   */
  async approveRemediation(req, res) {
    try {
      const { projectId, incidentId } = req.params;
      const actionType = req.body?.actionType || 'RESTART_CONTAINER';
      const result = await selfHealingEngine.manualRemediate(projectId, incidentId, actionType, req.body || {});
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to execute approved remediation', message: err.message });
    }
  }

  /**
   * POST /api/projects/:projectId/incidents/:incidentId/resolve
   */
  async resolveIncident(req, res) {
    try {
      const { projectId, incidentId } = req.params;
      const resolutionNotes = req.body?.notes || 'Manually resolved by operator';
      const incident = selfHealingEngine.resolveIncident(projectId, incidentId, resolutionNotes);
      return res.status(200).json({ success: true, incident });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to resolve incident', message: err.message });
    }
  }
}

module.exports = new SelfHealingController();
