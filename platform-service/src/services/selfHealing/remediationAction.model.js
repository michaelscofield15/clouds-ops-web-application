const crypto = require('crypto');

const ACTION_STATUSES = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED'
};

const ACTION_TYPES = {
  RESTART_CONTAINER: 'RESTART_CONTAINER',
  START_CONTAINER: 'START_CONTAINER',
  RESTART_DOCKER_DAEMON: 'RESTART_DOCKER_DAEMON',
  ROLLBACK_DEPLOYMENT: 'ROLLBACK_DEPLOYMENT',
  TERRAFORM_PLAN_DRIFT: 'TERRAFORM_PLAN_DRIFT',
  RETRY_HEALTH_PROBE: 'RETRY_HEALTH_PROBE',
  ALERT_ONLY: 'ALERT_ONLY',
  ESCALATE_TO_HUMAN: 'ESCALATE_TO_HUMAN'
};

class RemediationAction {
  constructor(data = {}) {
    this.actionId = data.actionId || `act-${Date.now().toString().slice(-6)}-${crypto.randomBytes(3).toString('hex')}`;
    this.incidentId = data.incidentId;
    this.projectId = data.projectId;
    this.actionType = data.actionType || ACTION_TYPES.RESTART_CONTAINER;
    this.status = data.status || ACTION_STATUSES.PENDING;
    this.attempt = data.attempt || 1;
    this.commandId = data.commandId || null;
    this.terraformOperationId = data.terraformOperationId || null;
    this.resourceId = data.resourceId || null;
    this.details = data.details || {};
    this.result = data.result || null;
    this.error = data.error || null;
    this.verificationResult = data.verificationResult || null;
    this.startedAt = data.startedAt || new Date().toISOString();
    this.completedAt = data.completedAt || null;
    this.durationMs = data.durationMs || null;
  }

  markRunning(details = {}) {
    this.status = ACTION_STATUSES.RUNNING;
    this.startedAt = new Date().toISOString();
    this.details = { ...this.details, ...details };
    return this;
  }

  markSuccess(result, verificationResult = null) {
    this.status = ACTION_STATUSES.SUCCESS;
    this.completedAt = new Date().toISOString();
    this.result = result;
    if (result && result.commandId) {
      this.commandId = result.commandId;
    }
    this.verificationResult = verificationResult;
    if (this.startedAt) {
      this.durationMs = Date.now() - new Date(this.startedAt).getTime();
    }
    return this;
  }

  markFailed(error, verificationResult = null) {
    this.status = ACTION_STATUSES.FAILED;
    this.completedAt = new Date().toISOString();
    this.error = typeof error === 'string' ? error : error?.message || 'Action execution failed';
    this.verificationResult = verificationResult;
    if (this.startedAt) {
      this.durationMs = Date.now() - new Date(this.startedAt).getTime();
    }
    return this;
  }

  markSkipped(reason) {
    this.status = ACTION_STATUSES.SKIPPED;
    this.completedAt = new Date().toISOString();
    this.error = reason || 'Action skipped by policy';
    return this;
  }

  toJSON() {
    return {
      actionId: this.actionId,
      incidentId: this.incidentId,
      projectId: this.projectId,
      actionType: this.actionType,
      status: this.status,
      attempt: this.attempt,
      commandId: this.commandId,
      terraformOperationId: this.terraformOperationId,
      resourceId: this.resourceId,
      details: this.details,
      result: this.result,
      error: this.error,
      verificationResult: this.verificationResult,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      durationMs: this.durationMs
    };
  }
}

module.exports = {
  RemediationAction,
  ACTION_STATUSES,
  ACTION_TYPES
};
