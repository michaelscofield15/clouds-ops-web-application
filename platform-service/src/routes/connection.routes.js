const express = require('express');
const router = express.Router();
const connectionController = require('../controllers/connection.controller');
const { requireAuth, requireOrgRole, requireConnectionAccess } = require('../middleware/auth.middleware');

router.use(requireAuth);

router.get('/', connectionController.listConnections);
router.post('/', requireOrgRole(['OWNER', 'ADMIN']), connectionController.createConnection);
router.get('/:id', requireConnectionAccess, connectionController.getConnection);
router.post('/:id/test', requireConnectionAccess, connectionController.testConnection);
router.delete('/:id', requireOrgRole(['OWNER', 'ADMIN']), requireConnectionAccess, connectionController.deleteConnection);

module.exports = router;
