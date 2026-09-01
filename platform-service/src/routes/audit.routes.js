const express = require('express');
const router = express.Router();
const auditController = require('../controllers/audit.controller');
const { requireAuth, requireProjectAccess } = require('../middleware/auth.middleware');

router.use(requireAuth);

router.get('/', (req, res, next) => auditController.getAuditLogs(req, res, next));
router.get('/projects/:projectId', requireProjectAccess, (req, res, next) =>
  auditController.getProjectAuditLogs(req, res, next)
);

module.exports = router;
