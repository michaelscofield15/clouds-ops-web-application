const express = require('express');
const router = express.Router({ mergeParams: true });
const monitoringController = require('../controllers/monitoring.controller');

// Monitoring routes scoped to :projectId
router.get('/status', (req, res, next) => monitoringController.getStatus(req, res, next));
router.get('/metrics', (req, res, next) => monitoringController.getMetrics(req, res, next));
router.get('/health', (req, res, next) => monitoringController.getHealth(req, res, next));
router.get('/logs', (req, res, next) => monitoringController.getLogs(req, res, next));
router.get('/alerts', (req, res, next) => monitoringController.getAlerts(req, res, next));

router.post('/check', (req, res, next) => monitoringController.triggerManualCheck(req, res, next));
router.post('/start', (req, res, next) => monitoringController.startMonitoring(req, res, next));
router.post('/stop', (req, res, next) => monitoringController.stopMonitoring(req, res, next));
router.post('/alerts/:alertId/acknowledge', (req, res, next) => monitoringController.acknowledgeAlert(req, res, next));

module.exports = router;
