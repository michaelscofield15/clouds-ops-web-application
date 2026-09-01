const crypto = require('crypto');

/**
 * Valid lifecycle statuses for an Incident
 */
const INCIDENT_STATUSES = {
  DETECTED: 'DETECTED',
  ANALYZING: 'ANALYZING',
  REMEDIATING: 'REMEDIATING',
  VERIFYING: 'VERIFYING',
  RESOLVED: 'RESOLVED',
  ESCALATED: 'ESCALATED',
  FAILED: 'FAILED',
  ACKNOWLEDGED: 'ACKNOWLEDGED'
};

/**
 * Valid incident severities
 */
const INCIDENT_SEVERITIES = {
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  INFO: 'INFO'
};

/**
 * Supported Incident Failure Types
 */
const INCIDENT_TYPES = {
  CONTAINER_STOPPED: 'CONTAINER_STOPPED',
  CONTAINER_CRASHED: 'CONTAINER_CRASHED',
  CONTAINER_RESTART_LOOP: 'CONTAINER_RESTART_LOOP',
  HEALTH_CHECK_FAILED: 'HEALTH_CHECK_FAILED',
  HEALTH_CHECK_5XX: 'HEALTH_CHECK_5XX',
  EC2_STOPPED: 'EC2_STOPPED',
  EC2_UNAVAILABLE: 'EC2_UNAVAILABLE',
  SSM_OFFLINE: 'SSM_OFFLINE',
  HIGH_CPU_UTILIZATION: 'HIGH_CPU_UTILIZATION',
  HIGH_MEMORY_UTILIZATION: 'HIGH_MEMORY_UTILIZATION',
  HIGH_DISK_UTILIZATION: 'HIGH_DISK_UTILIZATION',
  DEPLOYMENT_HEALTH_FAILURE: 'DEPLOYMENT_HEALTH_FAILURE',
  TERRAFORM_DRIFT: 'TERRAFORM_DRIFT',
  ECR_PULL_FAILURE: 'ECR_PULL_FAILURE',
  DOCKER_DAEMON_STOPPED: 'DOCKER_DAEMON_STOPPED',
  IAM_PERMISSION_FAILURE: 'IAM_PERMISSION_FAILURE'
};

class Incident {
  constructor(data = {}) {
    this.incidentId = data.incidentId || `inc-${Date.now().toString().slice(-6)}-${crypto.randomBytes(3).toString('hex')}`;
    this.projectId = data.projectId;
    this.deploymentId = data.deploymentId || null;
    this.type = data.type || INCIDENT_TYPES.HEALTH_CHECK_FAILED;
    this.severity = data.severity || INCIDENT_SEVERITIES.WARNING;
    this.status = data.status || INCIDENT_STATUSES.DETECTED;
    this.detectedAt = data.detectedAt || new Date().toISOString();
    this.lastSeenAt = data.lastSeenAt || this.detectedAt;
    this.resolvedAt = data.resolvedAt || null;
    this.failureMessage = data.failureMessage || 'Unspecified failure condition detected';
    this.currentValue = data.currentValue !== undefined ? data.currentValue : null;
    this.threshold = data.threshold !== undefined ? data.threshold : null;
    this.unit = data.unit || '';
    this.resourceId = data.resourceId || null;
    this.resourceType = data.resourceType || 'CONTAINER'; // CONTAINER | EC2 | SSM | TERRAFORM | APP
    this.remediationPolicy = data.remediationPolicy || null;
    this.remediationAttempts = data.remediationAttempts || 0;
    this.maxAttempts = data.maxAttempts || 2;
    this.lastAction = data.lastAction || null;
    this.verificationStatus = data.verificationStatus || 'PENDING';
    this.escalationRequired = Boolean(data.escalationRequired);
    this.escalationReason = data.escalationReason || null;
    this.timeline = Array.isArray(data.timeline) ? data.timeline : [];
    this.evidence = data.evidence || {};
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();

    if (this.timeline.length === 0) {
      this.addTimelineEvent('DETECTED', `Incident detected: ${this.failureMessage}`);
    }
  }

  addTimelineEvent(stage, message, metadata = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      stage,
      message,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };
    this.timeline.push(event);
    this.updatedAt = event.timestamp;
    return event;
  }

  transitionTo(newStatus, reason, metadata = {}) {
    if (!INCIDENT_STATUSES[newStatus]) {
      throw new Error(`Invalid incident status transition: '${newStatus}'`);
    }
    const previousStatus = this.status;
    this.status = newStatus;
    this.updatedAt = new Date().toISOString();

    if (newStatus === INCIDENT_STATUSES.RESOLVED) {
      this.resolvedAt = this.updatedAt;
      this.verificationStatus = 'VERIFIED_HEALTHY';
    } else if (newStatus === INCIDENT_STATUSES.ESCALATED) {
      this.escalationRequired = true;
      this.escalationReason = reason || 'Remediation exhausted or manual escalation requested';
    }

    this.addTimelineEvent(newStatus, reason || `Status transitioned from ${previousStatus} to ${newStatus}`, metadata);
    return this;
  }

  recordAttempt(action) {
    this.remediationAttempts += 1;
    this.lastAction = action.actionType;
    this.updatedAt = new Date().toISOString();
    this.addTimelineEvent('REMEDIATING', `Executing remediation attempt #${this.remediationAttempts}: ${action.actionType}`, {
      actionId: action.actionId,
      attempt: this.remediationAttempts
    });
  }

  toJSON() {
    return {
      incidentId: this.incidentId,
      projectId: this.projectId,
      deploymentId: this.deploymentId,
      type: this.type,
      severity: this.severity,
      status: this.status,
      detectedAt: this.detectedAt,
      lastSeenAt: this.lastSeenAt,
      resolvedAt: this.resolvedAt,
      failureMessage: this.failureMessage,
      currentValue: this.currentValue,
      threshold: this.threshold,
      unit: this.unit,
      resourceId: this.resourceId,
      resourceType: this.resourceType,
      remediationPolicy: this.remediationPolicy,
      remediationAttempts: this.remediationAttempts,
      maxAttempts: this.maxAttempts,
      lastAction: this.lastAction,
      verificationStatus: this.verificationStatus,
      escalationRequired: this.escalationRequired,
      escalationReason: this.escalationReason,
      timeline: this.timeline,
      evidence: this.evidence,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}

module.exports = {
  Incident,
  INCIDENT_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES
};
