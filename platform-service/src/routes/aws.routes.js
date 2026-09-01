const express = require('express');
const awsController = require('../controllers/aws.controller');
const { optionalAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// Apply optionalAuth so tenant identity is resolved from JWT if provided
router.use(optionalAuth);

// AWS Status & Preflight Check
router.get('/status', (req, res, next) => awsController.getStatus(req, res, next));
router.get('/preflight', (req, res, next) => awsController.preflightCheck(req, res, next));

// Tenant-Scoped Infrastructure Discovery
router.get('/ec2', (req, res, next) => awsController.getEC2Instances(req, res, next));
router.get('/ecr', (req, res, next) => awsController.getECRRepositories(req, res, next));
router.get('/resources', (req, res, next) => awsController.getInfrastructureResources(req, res, next));

module.exports = router;


