const express = require('express');
const router = express.Router({ mergeParams: true });
const controller = require('../controllers/orchestrator.controller');

// Project-scoped orchestration endpoints: /api/projects/:projectId/orchestrate/*
router.post('/analyze', controller.analyze);
router.get('/requirements', controller.getRequirements);
router.post('/requirements/resolve', controller.resolveRequirements);
router.post('/plan', controller.generatePlan);
router.get('/plan', controller.getPlan);
router.post('/preflight', controller.runPreflight);
router.post('/deploy', controller.deploy);
router.get('/status', controller.getStatus);
router.get('/logs', controller.getLogs);
router.get('/failure', controller.getFailure);
router.post('/cancel', controller.cancel);
router.post('/retry', controller.deploy);

module.exports = router;
