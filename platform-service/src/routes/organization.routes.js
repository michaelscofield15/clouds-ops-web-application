const express = require('express');
const router = express.Router();
const organizationController = require('../controllers/organization.controller');
const { requireAuth, requireOrgRole } = require('../middleware/auth.middleware');

router.use(requireAuth);

router.get('/current', organizationController.getCurrentOrg);
router.get('/current/members', organizationController.listMembers);
router.post('/current/members', requireOrgRole(['OWNER', 'ADMIN']), organizationController.addMember);
router.delete('/current/members/:userId', requireOrgRole(['OWNER', 'ADMIN']), organizationController.removeMember);
router.get('/current/audit', organizationController.getAuditLogs);

module.exports = router;
