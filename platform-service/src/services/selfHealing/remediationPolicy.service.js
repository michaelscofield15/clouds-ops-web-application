const { INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('./incident.model');
const { ACTION_TYPES } = require('./remediationAction.model');

/**
 * Supported Recovery Modes per project
 */
const RECOVERY_MODES = {
  SAFE: 'SAFE',           // Only container restarts and health verification
  STANDARD: 'STANDARD',   // Container restarts + approved rollback
  DISABLED: 'DISABLED'    // Detection and alerts only; no automated remediations
};

/**
 * Built-in safety policy rules per incident type
 */
const DEFAULT_POLICIES = {
  [INCIDENT_TYPES.CONTAINER_STOPPED]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.START_CONTAINER, ACTION_TYPES.RESTART_CONTAINER],
    autoRemediateModes: [RECOVERY_MODES.SAFE, RECOVERY_MODES.STANDARD],
    maxAttempts: 2,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'Restart stopped Docker container via SSM and verify application health'
  },
  [INCIDENT_TYPES.CONTAINER_CRASHED]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.RESTART_CONTAINER],
    autoRemediateModes: [RECOVERY_MODES.SAFE, RECOVERY_MODES.STANDARD],
    maxAttempts: 2,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'Inspect exit code, restart crashed container, and verify application health'
  },
  [INCIDENT_TYPES.CONTAINER_RESTART_LOOP]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ESCALATE_TO_HUMAN],
    autoRemediateModes: [], // NEVER restart endlessly
    maxAttempts: 0,
    cooldownSeconds: 600,
    requiresHealthVerification: false,
    description: 'Circuit breaker triggered on repeated crash loop; escalate immediately'
  },
  [INCIDENT_TYPES.HEALTH_CHECK_FAILED]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.RETRY_HEALTH_PROBE, ACTION_TYPES.RESTART_CONTAINER],
    autoRemediateModes: [RECOVERY_MODES.SAFE, RECOVERY_MODES.STANDARD],
    maxAttempts: 2,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'Retry health probe, restart container if persistent, and verify HTTP 200'
  },
  [INCIDENT_TYPES.HEALTH_CHECK_5XX]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.RETRY_HEALTH_PROBE, ACTION_TYPES.RESTART_CONTAINER],
    autoRemediateModes: [RECOVERY_MODES.SAFE, RECOVERY_MODES.STANDARD],
    maxAttempts: 2,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'Application returning HTTP 5xx error; execute safe restart & re-probe'
  },
  [INCIDENT_TYPES.DEPLOYMENT_HEALTH_FAILURE]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ROLLBACK_DEPLOYMENT],
    autoRemediateModes: [RECOVERY_MODES.STANDARD],
    maxAttempts: 1,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'New deployment failed health checks; rollback to previous known-good ECR image'
  },
  [INCIDENT_TYPES.DOCKER_DAEMON_STOPPED]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.RESTART_DOCKER_DAEMON],
    autoRemediateModes: [RECOVERY_MODES.SAFE, RECOVERY_MODES.STANDARD],
    maxAttempts: 1,
    cooldownSeconds: 300,
    requiresHealthVerification: true,
    description: 'Restart system Docker daemon via SSM and verify container readiness'
  },
  [INCIDENT_TYPES.EC2_STOPPED]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ALERT_ONLY, ACTION_TYPES.ESCALATE_TO_HUMAN],
    autoRemediateModes: [], // Do not blindly recreate or restart without confirmation
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'EC2 instance is stopped; alert and require human intervention'
  },
  [INCIDENT_TYPES.EC2_UNAVAILABLE]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ALERT_ONLY, ACTION_TYPES.ESCALATE_TO_HUMAN],
    autoRemediateModes: [],
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'EC2 instance unreachable; alert and escalate'
  },
  [INCIDENT_TYPES.SSM_OFFLINE]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ALERT_ONLY],
    autoRemediateModes: [], // Do not send SSM commands when SSM is offline
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'SSM Agent offline; wait and alert'
  },
  [INCIDENT_TYPES.HIGH_CPU_UTILIZATION]: {
    severity: INCIDENT_SEVERITIES.WARNING,
    allowedActions: [ACTION_TYPES.ALERT_ONLY],
    autoRemediateModes: [], // Do not auto-resize EC2 instances
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'High CPU utilization detected; notify operator'
  },
  [INCIDENT_TYPES.HIGH_MEMORY_UTILIZATION]: {
    severity: INCIDENT_SEVERITIES.WARNING,
    allowedActions: [ACTION_TYPES.ALERT_ONLY],
    autoRemediateModes: [], // Do not kill processes or delete files
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'High memory utilization detected; notify operator'
  },
  [INCIDENT_TYPES.HIGH_DISK_UTILIZATION]: {
    severity: INCIDENT_SEVERITIES.WARNING,
    allowedActions: [ACTION_TYPES.ALERT_ONLY],
    autoRemediateModes: [], // Do not delete files automatically
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'High disk utilization detected; notify operator'
  },
  [INCIDENT_TYPES.TERRAFORM_DRIFT]: {
    severity: INCIDENT_SEVERITIES.WARNING,
    allowedActions: [ACTION_TYPES.TERRAFORM_PLAN_DRIFT],
    autoRemediateModes: [], // Never auto-apply destructive drift changes
    maxAttempts: 0,
    cooldownSeconds: 600,
    requiresHealthVerification: false,
    description: 'Terraform configuration drift detected; plan generated for human review'
  },
  [INCIDENT_TYPES.ECR_PULL_FAILURE]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ALERT_ONLY, ACTION_TYPES.ESCALATE_TO_HUMAN],
    autoRemediateModes: [],
    maxAttempts: 0,
    cooldownSeconds: 300,
    requiresHealthVerification: false,
    description: 'ECR image pull failed; authenticate and escalate'
  },
  [INCIDENT_TYPES.IAM_PERMISSION_FAILURE]: {
    severity: INCIDENT_SEVERITIES.CRITICAL,
    allowedActions: [ACTION_TYPES.ESCALATE_TO_HUMAN],
    autoRemediateModes: [], // NEVER auto-modify IAM
    maxAttempts: 0,
    cooldownSeconds: 600,
    requiresHealthVerification: false,
    description: 'IAM permission authorization error; require human intervention'
  }
};

class RemediationPolicyService {
  constructor(customPolicies = {}) {
    this.policies = {
      ...DEFAULT_POLICIES,
      ...customPolicies
    };
  }

  getPolicy(incidentType) {
    return this.policies[incidentType] || {
      severity: INCIDENT_SEVERITIES.WARNING,
      allowedActions: [ACTION_TYPES.ALERT_ONLY],
      autoRemediateModes: [],
      maxAttempts: 0,
      cooldownSeconds: 300,
      requiresHealthVerification: false,
      description: 'Default fallback policy'
    };
  }

  /**
   * Determines if automated remediation is permitted for a given incident and project settings.
   * @param {object} incident Incident instance
   * @param {object} projectSettings Project recovery settings
   * @param {boolean} globalAutoRecoveryEnabled Global safety switch
   * @returns {object} { allowed, reason, actionType, maxAttempts, cooldownSeconds }
   */
  evaluateRemediationPermission(incident, projectSettings = {}, globalAutoRecoveryEnabled = true) {
    const policy = this.getPolicy(incident.type);
    const recoveryMode = projectSettings.recoveryMode || RECOVERY_MODES.SAFE;
    const projectAutoEnabled = projectSettings.autoRecovery !== false;

    // 1. Check Global Switch
    if (!globalAutoRecoveryEnabled) {
      return {
        allowed: false,
        reason: 'Global automatic recovery is disabled (SAFETY_LOCK)',
        actionType: ACTION_TYPES.ALERT_ONLY,
        policy
      };
    }

    // 2. Check Project-Level Switch & Mode
    if (!projectAutoEnabled || recoveryMode === RECOVERY_MODES.DISABLED) {
      return {
        allowed: false,
        reason: `Project automated recovery is disabled (Mode: ${recoveryMode})`,
        actionType: ACTION_TYPES.ALERT_ONLY,
        policy
      };
    }

    // 3. Check Policy Mode Compatibility
    if (!policy.autoRemediateModes.includes(recoveryMode)) {
      return {
        allowed: false,
        reason: `Incident type '${incident.type}' is not eligible for auto-remediation in '${recoveryMode}' mode`,
        actionType: policy.allowedActions[0] || ACTION_TYPES.ALERT_ONLY,
        policy
      };
    }

    // 4. Check Attempt Limits (Circuit Breaker)
    const maxAttempts = projectSettings.maxAttempts || policy.maxAttempts;
    if (incident.remediationAttempts >= maxAttempts) {
      return {
        allowed: false,
        reason: `Maximum remediation attempts reached (${incident.remediationAttempts}/${maxAttempts}); escalating`,
        actionType: ACTION_TYPES.ESCALATE_TO_HUMAN,
        policy,
        escalate: true
      };
    }

    // 5. Check Cooldown Window
    const cooldownSec = projectSettings.cooldownSeconds || policy.cooldownSeconds;
    if (incident.lastRemediatedAt) {
      const elapsedSec = (Date.now() - new Date(incident.lastRemediatedAt).getTime()) / 1000;
      if (elapsedSec < cooldownSec) {
        return {
          allowed: false,
          reason: `Remediation cooldown in effect (${Math.round(cooldownSec - elapsedSec)}s remaining)`,
          actionType: ACTION_TYPES.ALERT_ONLY,
          policy
        };
      }
    }

    // Safe action permitted
    const chosenAction = policy.allowedActions[0] || ACTION_TYPES.RESTART_CONTAINER;
    return {
      allowed: true,
      reason: `Policy approved automated remediation: ${chosenAction}`,
      actionType: chosenAction,
      maxAttempts,
      cooldownSeconds: cooldownSec,
      requiresHealthVerification: policy.requiresHealthVerification,
      policy
    };
  }
}

module.exports = new RemediationPolicyService();
module.exports.RemediationPolicyService = RemediationPolicyService;
module.exports.RECOVERY_MODES = RECOVERY_MODES;
module.exports.DEFAULT_POLICIES = DEFAULT_POLICIES;
