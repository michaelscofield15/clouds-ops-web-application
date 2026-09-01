const express = require('express');
const agentController = require('../controllers/agent.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// Agent CLI pairing exchange & heartbeat (Public/Agent authenticated)
router.post('/pair/exchange', (req, res, next) => agentController.exchangePairing(req, res, next));
router.post('/heartbeat', (req, res, next) => agentController.heartbeat(req, res, next));

// Tenant-authenticated Agent controls
router.post('/pair/request', requireAuth, (req, res, next) => agentController.requestPairing(req, res, next));
router.get('/status', requireAuth, (req, res, next) => agentController.getStatus(req, res, next));
router.post('/disconnect', requireAuth, (req, res, next) => agentController.disconnect(req, res, next));

module.exports = router;
