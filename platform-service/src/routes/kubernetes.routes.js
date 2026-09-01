const express = require('express');
const router = express.Router();
const kubernetesController = require('../controllers/kubernetes.controller');

// Global Kubernetes status & cluster management
router.get('/status', kubernetesController.getPrerequisitesStatus);
router.post('/cluster', kubernetesController.createCluster);

module.exports = router;
