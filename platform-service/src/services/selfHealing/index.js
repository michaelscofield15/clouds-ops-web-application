const incidentDetector = require('./incident.detector.service');
const remediationPolicy = require('./remediationPolicy.service');
const remediationExecutor = require('./remediation.executor.service');
const selfHealingStorage = require('./selfHealing.storage');
const { Incident, INCIDENT_STATUSES, INCIDENT_TYPES } = require('./incident.model');
const { RemediationAction, ACTION_TYPES } = require('./remediationAction.model');

class SelfHealingEngine {
  constructor() {
    this.storage = selfHealingStorage;
    this.policy = remediationPolicy;
    this.detector = incidentDetector;
    this.executor = remediationExecutor;
  }

  /**
   * Evaluates a live monitoring snapshot and autonomously remediates detected issues if safe.
   * @param {string} projectId Project identifier
   * @param {object} snapshot Live monitoring snapshot from Phase 7
   * @param {object} options Override options
   * @returns {Promise<object>} Evaluation and remediation result
   */
  async evaluateProject(projectId, snapshot, options = {}) {
    if (!projectId || !snapshot) {
      return { evaluated: false, message: 'Missing projectId or snapshot' };
    }

    const existingIncidents = this.storage.getIncidents(projectId);
    const settings = this.storage.getProjectSettings(projectId);
    const globalAuto = this.storage.getGlobalAutoRecovery();

    // 1. Detect and Correlate Incidents
    const detectedIncidents = this.detector.detectIncidents(projectId, snapshot, existingIncidents);
    const processedResults = [];

    // 2. Process each detected incident
    for (const incident of detectedIncidents) {
      // Save initial detected state
      this.storage.saveIncident(projectId, incident);

      // Check if incident is already resolved or in verification
      if (incident.status === INCIDENT_STATUSES.RESOLVED) {
        processedResults.push({ incidentId: incident.incidentId, status: incident.status, action: 'NONE' });
        continue;
      }

      // Check Policy and Safety Limits
      const permission = this.policy.evaluateRemediationPermission(incident, settings, globalAuto);

      if (!permission.allowed) {
        if (permission.escalate && incident.status !== INCIDENT_STATUSES.ESCALATED) {
          incident.transitionTo(INCIDENT_STATUSES.ESCALATED, permission.reason);
          this.storage.saveIncident(projectId, incident);
        } else {
          incident.addTimelineEvent('POLICY_EVALUATION', `Auto-remediation skipped: ${permission.reason}`);
          this.storage.saveIncident(projectId, incident);
        }
        processedResults.push({ incidentId: incident.incidentId, status: incident.status, permitted: false, reason: permission.reason });
        continue;
      }

      // Execute Approved Remediation
      incident.transitionTo(INCIDENT_STATUSES.REMEDIATING, `Policy approved action '${permission.actionType}'`);
      const action = new RemediationAction({
        incidentId: incident.incidentId,
        projectId,
        actionType: permission.actionType,
        attempt: incident.remediationAttempts + 1,
        resourceId: incident.resourceId
      });

      incident.recordAttempt(action);
      this.storage.saveIncident(projectId, incident);

      try {
        const actionResult = await this.executor.execute(incident, permission.actionType, options);
        this.storage.saveRemediation(projectId, actionResult);

        incident.lastRemediatedAt = new Date().toISOString();

        if (actionResult.status === 'SUCCESS' && actionResult.verificationResult?.isHealthy) {
          // Verification Gate Passed
          incident.transitionTo(
            INCIDENT_STATUSES.RESOLVED,
            `Remediation succeeded and verified healthy (HTTP ${actionResult.verificationResult.httpStatus || 200})`,
            { actionId: actionResult.actionId, verification: actionResult.verificationResult }
          );
        } else {
          // Remediation Failed or Health Verification Failed
          const failReason = actionResult.error || 'Health verification failed after recovery action';
          if (incident.remediationAttempts >= permission.maxAttempts) {
            incident.transitionTo(
              INCIDENT_STATUSES.ESCALATED,
              `Exhausted maximum retry attempts (${incident.remediationAttempts}/${permission.maxAttempts}): ${failReason}`,
              { actionId: actionResult.actionId }
            );
          } else {
            incident.transitionTo(
              INCIDENT_STATUSES.ANALYZING,
              `Remediation attempt #${incident.remediationAttempts} failed: ${failReason}; cooldown applied`,
              { actionId: actionResult.actionId }
            );
          }
        }
      } catch (execErr) {
        action.markFailed(execErr);
        this.storage.saveRemediation(projectId, action);

        if (incident.remediationAttempts >= permission.maxAttempts) {
          incident.transitionTo(INCIDENT_STATUSES.ESCALATED, `Remediation execution error: ${execErr.message}`);
        } else {
          incident.addTimelineEvent('FAILED', `Execution error: ${execErr.message}`);
        }
      }

      this.storage.saveIncident(projectId, incident);
      processedResults.push({ incidentId: incident.incidentId, status: incident.status, action: permission.actionType });
    }

    return {
      evaluated: true,
      projectId,
      incidentsProcessed: processedResults.length,
      results: processedResults,
      stats: this.storage.getProjectStats(projectId)
    };
  }

  /**
   * Manually triggers a specific remediation action on an incident
   */
  async manualRemediate(projectId, incidentId, actionType, options = {}) {
    const incident = this.storage.getIncident(projectId, incidentId);
    if (!incident) {
      throw new Error(`Incident '${incidentId}' not found for project '${projectId}'`);
    }

    incident.transitionTo(INCIDENT_STATUSES.REMEDIATING, `Operator triggered manual remediation: ${actionType}`);
    const action = new RemediationAction({
      incidentId,
      projectId,
      actionType,
      attempt: incident.remediationAttempts + 1,
      resourceId: incident.resourceId
    });

    incident.recordAttempt(action);
    this.storage.saveIncident(projectId, incident);

    const actionResult = await this.executor.execute(incident, actionType, options);
    this.storage.saveRemediation(projectId, actionResult);

    if (actionResult.status === 'SUCCESS' && actionResult.verificationResult?.isHealthy) {
      incident.transitionTo(INCIDENT_STATUSES.RESOLVED, `Manual remediation succeeded: ${actionType}`, { verification: actionResult.verificationResult });
    } else {
      incident.addTimelineEvent('MANUAL_ACTION_RESULT', `Manual remediation finished with status: ${actionResult.status}`);
    }

    this.storage.saveIncident(projectId, incident);
    return { incident, action: actionResult };
  }

  /**
   * Operator acknowledges an incident
   */
  acknowledgeIncident(projectId, incidentId, operator = 'Operator') {
    const incident = this.storage.getIncident(projectId, incidentId);
    if (!incident) {
      throw new Error(`Incident '${incidentId}' not found`);
    }

    incident.transitionTo(INCIDENT_STATUSES.ACKNOWLEDGED, `Acknowledged by ${operator}`);
    this.storage.saveIncident(projectId, incident);
    return incident;
  }

  /**
   * Operator manually resolves an incident
   */
  resolveIncident(projectId, incidentId, resolutionNotes = 'Manually resolved by operator') {
    const incident = this.storage.getIncident(projectId, incidentId);
    if (!incident) {
      throw new Error(`Incident '${incidentId}' not found`);
    }

    incident.transitionTo(INCIDENT_STATUSES.RESOLVED, resolutionNotes);
    this.storage.saveIncident(projectId, incident);
    return incident;
  }

  /**
   * Global and project status summary
   */
  getStatus(projectId = null) {
    if (projectId) {
      return {
        ...this.storage.getProjectStats(projectId),
        settings: this.storage.getProjectSettings(projectId),
        incidents: this.storage.getIncidents(projectId),
        remediations: this.storage.getRemediations(projectId)
      };
    }
    return this.storage.getGlobalStats();
  }
}

module.exports = new SelfHealingEngine();
module.exports.SelfHealingEngine = SelfHealingEngine;
module.exports.INCIDENT_TYPES = INCIDENT_TYPES;
module.exports.INCIDENT_STATUSES = INCIDENT_STATUSES;
module.exports.ACTION_TYPES = ACTION_TYPES;
