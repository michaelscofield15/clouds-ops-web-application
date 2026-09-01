const db = require('../services/db/db.service');
const auditService = require('../services/audit.service');
const authService = require('../services/auth/auth.service');

class OrganizationController {
  async getCurrentOrg(req, res) {
    try {
      const org = req.organization;
      const memberCount = db.count('memberships', { organizationId: org.id });
      const projectCount = db.count('projects', { organizationId: org.id });
      const connectionCount = db.count('connections', { organizationId: org.id });

      res.status(200).json({
        organization: org,
        stats: {
          members: memberCount,
          projects: projectCount,
          connections: connectionCount
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'OrgError', message: err.message });
    }
  }

  async listMembers(req, res) {
    try {
      const orgId = req.organization?.id;
      const memberships = db.find('memberships', { organizationId: orgId });
      const members = memberships.map(m => {
        const user = db.findById('users', m.userId);
        return {
          id: m.id,
          userId: m.userId,
          role: m.role,
          user: authService.sanitizeUser(user),
          createdAt: m.createdAt
        };
      });

      res.status(200).json({ members });
    } catch (err) {
      res.status(500).json({ error: 'OrgError', message: err.message });
    }
  }

  async addMember(req, res) {
    try {
      const orgId = req.organization?.id;
      const { email, role = 'MEMBER' } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'ValidationError', message: 'User email is required' });
      }

      const validRoles = ['OWNER', 'ADMIN', 'MEMBER'];
      if (!validRoles.includes(role.toUpperCase())) {
        return res.status(400).json({ error: 'ValidationError', message: `Invalid role. Allowed: ${validRoles.join(', ')}` });
      }

      const normalizedEmail = authService.normalizeEmail(email);
      let targetUser = db.findOne('users', { email: normalizedEmail });

      if (!targetUser) {
        // Create user placeholder / invited account
        const signupRes = await authService.signup({
          email: normalizedEmail,
          password: 'Password123!',
          name: normalizedEmail.split('@')[0],
          organizationName: `${normalizedEmail.split('@')[0]}'s Workspace`
        });
        targetUser = signupRes.user;
      }

      // Check existing membership
      const existingMembership = db.findOne('memberships', { organizationId: orgId, userId: targetUser.id });
      if (existingMembership) {
        return res.status(409).json({ error: 'Conflict', message: 'User is already a member of this organization' });
      }

      const membership = db.insert('memberships', {
        organizationId: orgId,
        userId: targetUser.id,
        role: role.toUpperCase()
      });

      auditService.log(null, 'MEMBER_ADDED', 'SUCCESS', {
        organizationId: orgId,
        addedUserId: targetUser.id,
        role: role.toUpperCase()
      });

      res.status(201).json({
        success: true,
        message: `User '${normalizedEmail}' added to organization as ${role.toUpperCase()}.`,
        membership: {
          id: membership.id,
          userId: targetUser.id,
          role: membership.role,
          user: authService.sanitizeUser(targetUser)
        }
      });
    } catch (err) {
      res.status(500).json({ error: 'OrgError', message: err.message });
    }
  }

  async removeMember(req, res) {
    try {
      const orgId = req.organization?.id;
      const { userId } = req.params;

      if (userId === req.user?.id) {
        return res.status(400).json({ error: 'InvalidAction', message: 'You cannot remove yourself from the organization' });
      }

      const membership = db.findOne('memberships', { organizationId: orgId, userId });
      if (!membership) {
        return res.status(404).json({ error: 'NotFound', message: 'Member not found in this organization' });
      }

      db.delete('memberships', membership.id);

      auditService.log(null, 'MEMBER_REMOVED', 'SUCCESS', {
        organizationId: orgId,
        removedUserId: userId
      });

      res.status(200).json({
        success: true,
        message: 'Member removed from organization successfully.'
      });
    } catch (err) {
      res.status(500).json({ error: 'OrgError', message: err.message });
    }
  }

  async getAuditLogs(req, res) {
    try {
      const orgId = req.organization?.id;
      const logs = auditService.getTenantLogs(orgId);
      res.status(200).json({ logs });
    } catch (err) {
      res.status(500).json({ error: 'AuditError', message: err.message });
    }
  }
}

module.exports = new OrganizationController();
