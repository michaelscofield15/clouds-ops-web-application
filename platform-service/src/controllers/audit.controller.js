const auditService = require('../services/audit.service');

class AuditController {
  /**
   * GET /api/audit
   * Retrieves paginated audit logs for the authenticated organization
   */
  async getAuditLogs(req, res, next) {
    try {
      const organizationId = req.organization?.id;
      if (!organizationId) {
        return res.status(401).json({ error: 'Tenant organization context required' });
      }

      const { projectId, action, status, limit, offset } = req.query;
      const logs = auditService.getTenantLogs(organizationId, {
        projectId,
        action,
        status,
        limit,
        offset
      });

      return res.status(200).json({
        success: true,
        organizationId,
        count: logs.length,
        logs
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/audit/projects/:projectId
   * Retrieves audit logs for a specific project
   */
  async getProjectAuditLogs(req, res, next) {
    try {
      const organizationId = req.organization?.id;
      const { projectId } = req.params;

      const logs = auditService.getProjectLogs(projectId, organizationId);
      return res.status(200).json({
        success: true,
        projectId,
        organizationId,
        count: logs.length,
        logs
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AuditController();
