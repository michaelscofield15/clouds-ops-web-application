const db = require('./db/db.service');

const AUDIT_ACTIONS = {
  // Authentication & Tenant
  AUTH_SIGNUP: 'AUTH_SIGNUP',
  AUTH_LOGIN: 'AUTH_LOGIN',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  ORG_CREATE: 'ORG_CREATE',
  ORG_UPDATE: 'ORG_UPDATE',
  MEMBER_INVITE: 'MEMBER_INVITE',
  MEMBER_ROLE_CHANGE: 'MEMBER_ROLE_CHANGE',
  MEMBER_REMOVE: 'MEMBER_REMOVE',

  // Provider Connections
  CONNECTION_CREATE: 'CONNECTION_CREATE',
  CONNECTION_TEST: 'CONNECTION_TEST',
  CONNECTION_UPDATE: 'CONNECTION_UPDATE',
  CONNECTION_DELETE: 'CONNECTION_DELETE',

  // Application & Ingestion
  PROJECT_UPLOAD: 'PROJECT_UPLOAD',
  PROJECT_ANALYZE: 'PROJECT_ANALYZE',
  PROJECT_DELETE: 'PROJECT_DELETE',

  // Deployment Lifecycle
  DEPLOYMENT_PLAN: 'DEPLOYMENT_PLAN',
  DEPLOYMENT_PREFLIGHT: 'DEPLOYMENT_PREFLIGHT',
  DEPLOYMENT_START: 'DEPLOYMENT_START',
  DEPLOYMENT_STAGE_CHANGE: 'DEPLOYMENT_STAGE_CHANGE',
  DEPLOYMENT_SUCCESS: 'DEPLOYMENT_SUCCESS',
  DEPLOYMENT_FAIL: 'DEPLOYMENT_FAIL',
  DEPLOYMENT_CANCEL: 'DEPLOYMENT_CANCEL',

  // Infrastructure & IaC
  TERRAFORM_PLAN: 'TERRAFORM_PLAN',
  TERRAFORM_APPLY: 'TERRAFORM_APPLY',
  TERRAFORM_DESTROY: 'TERRAFORM_DESTROY',
  DOCKER_BUILD: 'DOCKER_BUILD',
  ECR_PUSH: 'ECR_PUSH',
  EC2_DEPLOY: 'EC2_DEPLOY',
  K8S_APPLY: 'K8S_APPLY',

  // Self-Healing & Incidents
  INCIDENT_DETECT: 'INCIDENT_DETECT',
  SELF_HEAL_TRIGGER: 'SELF_HEAL_TRIGGER',
  SELF_HEAL_SUCCESS: 'SELF_HEAL_SUCCESS',
  SELF_HEAL_FAIL: 'SELF_HEAL_FAIL',
  ROLLBACK_TRIGGER: 'ROLLBACK_TRIGGER'
};

class AuditService {
  constructor() {
    this.inMemoryFallback = [];
  }

  /**
   * Records a security-sensitive audit event
   */
  log(projectIdOrOptions, action, status, details = {}) {
    let entry = {};
    if (typeof projectIdOrOptions === 'object' && projectIdOrOptions !== null) {
      const opts = projectIdOrOptions;
      entry = {
        organizationId: opts.organizationId || null,
        userId: opts.userId || null,
        projectId: opts.projectId || 'system',
        deploymentId: opts.deploymentId || null,
        action: opts.action || action || 'UNKNOWN_ACTION',
        status: opts.status || status || 'SUCCESS',
        ipAddress: opts.ipAddress || null,
        timestamp: new Date().toISOString(),
        details: this._sanitize(opts.details || details || {})
      };
    } else {
      entry = {
        organizationId: details.organizationId || null,
        userId: details.userId || null,
        projectId: projectIdOrOptions || 'system',
        deploymentId: details.deploymentId || null,
        action: action || 'UNKNOWN_ACTION',
        status: status || 'SUCCESS',
        ipAddress: details.ipAddress || null,
        timestamp: new Date().toISOString(),
        details: this._sanitize(details)
      };
    }

    try {
      const saved = db.insert('audit_events', entry);
      return saved;
    } catch {
      entry.id = `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      this.inMemoryFallback.push(entry);
      if (this.inMemoryFallback.length > 500) {
        this.inMemoryFallback.shift();
      }
      return entry;
    }
  }

  record(projectId, action, details = {}) {
    return this.log(projectId, action, 'SUCCESS', details);
  }

  /**
   * Retrieves paginated audit logs for a tenant organization
   */
  getTenantLogs(organizationId, options = {}) {
    if (!organizationId) return [];

    let events = [];
    try {
      events = db.find('audit_events', (ev) => ev.organizationId === organizationId);
    } catch {
      events = this.inMemoryFallback.filter((ev) => ev.organizationId === organizationId);
    }

    // Apply optional filters
    if (options.projectId) {
      events = events.filter((ev) => ev.projectId === options.projectId);
    }
    if (options.action) {
      events = events.filter((ev) => ev.action === options.action);
    }
    if (options.status) {
      events = events.filter((ev) => ev.status === options.status);
    }

    // Sort descending by timestamp
    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const limit = parseInt(options.limit, 10) || 50;
    const offset = parseInt(options.offset, 10) || 0;

    return events.slice(offset, offset + limit);
  }

  /**
   * Retrieves audit logs for a specific project
   */
  getProjectLogs(projectId, organizationId = null) {
    try {
      return db.find('audit_events', (ev) => {
        if (organizationId && ev.organizationId !== organizationId) return false;
        return ev.projectId === projectId;
      }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch {
      return this.inMemoryFallback.filter((ev) => {
        if (organizationId && ev.organizationId !== organizationId) return false;
        return ev.projectId === projectId;
      });
    }
  }

  /**
   * Strips and redacts any sensitive credential fields
   */
  _sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = Array.isArray(obj) ? [] : {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (/token|password|secret|key|authorization|cookie|credential/i.test(key)) {
        sanitized[key] = '***REDACTED***';
      } else if (typeof val === 'object' && val !== null) {
        sanitized[key] = this._sanitize(val);
      } else {
        sanitized[key] = val;
      }
    }
    return sanitized;
  }
}

module.exports = new AuditService();
module.exports.AuditService = AuditService;
module.exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
