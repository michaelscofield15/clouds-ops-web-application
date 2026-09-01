const express = require('express');
const router = express.Router({ mergeParams: true });
const terraformController = require('../controllers/terraform.controller');

// Project-level Terraform routes (mounted under /api/projects/:projectId/terraform)
router.post('/generate', terraformController.generateConfig);
router.post('/init', terraformController.initProject);
router.post('/validate', terraformController.validateProject);
router.post('/plan', terraformController.planProject);
router.post('/apply', terraformController.applyProject);
router.post('/destroy', terraformController.destroyProject);

router.get('/status', terraformController.getProjectStatus);
router.get('/plan', terraformController.getProjectPlan);
router.get('/logs', terraformController.getProjectLogs);
router.get('/resources', terraformController.discoverResources);
router.post('/import', terraformController.importResource);

module.exports = router;
