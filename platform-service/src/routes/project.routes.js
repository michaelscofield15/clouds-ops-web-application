const express = require('express');
const multer = require('multer');
const config = require('../config');
const {
  uploadProject,
  listTenantProjects,
  getProjectAnalysis,
  deleteProject
} = require('../controllers/project.controller');
const { requireAuth, requireProjectAccess } = require('../middleware/auth.middleware');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

// Configure multer memory storage with size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadSizeBytes,
    files: 1
  }
});

// Middleware wrapper to catch multer limit errors
const uploadMiddleware = (req, res, next) => {
  upload.single('project')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: 'File too large',
            message: `Uploaded file exceeds maximum allowed size of ${config.maxUploadSizeBytes / (1024 * 1024)}MB`
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({
            error: 'Too many files',
            message: 'Only one ZIP application archive may be uploaded at a time.'
          });
        }
        return res.status(400).json({
          error: 'Upload error',
          message: err.message
        });
      }
      return next(err);
    }
    next();
  });
};

const dockerRoutes = require('./docker.routes');
const gitController = require('../controllers/git.controller');
const jenkinsController = require('../controllers/jenkins.controller');
const kubernetesController = require('../controllers/kubernetes.controller');
const awsController = require('../controllers/aws.controller');
const monitoringRoutes = require('./monitoring.routes');
const terraformRoutes = require('./terraform.routes');
const orchestratorRoutes = require('./orchestrator.routes');
const { projectRouter: selfHealingProjectRouter, incidentRouter } = require('./selfHealing.routes');

// In development, requireAuth supports anonymous dev mode if configured
router.use(requireAuth);

router.get('/', listTenantProjects);
router.post('/upload', uploadLimiter, uploadMiddleware, uploadProject);
router.get('/:projectId', requireProjectAccess, getProjectAnalysis);
router.delete('/:projectId', requireProjectAccess, deleteProject);

// Mount Docker engine routes under /:projectId
router.use('/:projectId', requireProjectAccess, dockerRoutes);

// Phase 4: Git & GitHub Push
router.post('/:projectId/github/push', requireProjectAccess, gitController.pushToGitHub);

// Phase 4: Jenkins Job, Build & Logs
router.post('/:projectId/jenkins/job', requireProjectAccess, jenkinsController.createPipelineJob);
router.post('/:projectId/jenkins/build', requireProjectAccess, jenkinsController.triggerBuild);
router.get('/:projectId/jenkins/build/:buildNumber', requireProjectAccess, jenkinsController.getBuildInfo);
router.get('/:projectId/jenkins/build/:buildNumber/logs', requireProjectAccess, jenkinsController.getBuildLogs);

// Phase 4: Project Audit Trail
router.get('/:projectId/audit', requireProjectAccess, jenkinsController.getAuditLogs);

// Phase 5: Kubernetes Automation Engine Routes
router.post('/:projectId/kubernetes/deploy', requireProjectAccess, kubernetesController.deployProject);
router.get('/:projectId/kubernetes/status', requireProjectAccess, kubernetesController.getProjectDeploymentStatus);
router.get('/:projectId/kubernetes/pods', requireProjectAccess, kubernetesController.getProjectPods);
router.get('/:projectId/kubernetes/service', requireProjectAccess, kubernetesController.getProjectService);
router.get('/:projectId/kubernetes/logs', requireProjectAccess, kubernetesController.getProjectLogs);
router.get('/:projectId/kubernetes/events', requireProjectAccess, kubernetesController.getProjectEvents);
router.delete('/:projectId/kubernetes', requireProjectAccess, kubernetesController.deleteProjectDeployment);

// Deployment History & Lifecycle Routes
router.get('/:projectId/deployments', requireProjectAccess, awsController.listDeployments);
router.get('/:projectId/deployments/live', requireProjectAccess, awsController.getLiveDeployment);

// Phase 6: Real AWS Cloud Deployment Engine Routes
router.post('/:projectId/aws/validate', requireProjectAccess, awsController.validateProject);
router.post('/:projectId/aws/ecr', requireProjectAccess, awsController.publishECR);
router.post('/:projectId/aws/deploy', requireProjectAccess, awsController.deployProject);
router.get('/:projectId/aws/status', requireProjectAccess, awsController.getDeploymentStatus);
router.get('/:projectId/aws/logs', requireProjectAccess, awsController.getDeploymentLogs);
router.get('/:projectId/aws/resources', requireProjectAccess, awsController.getDeploymentResources);
router.post('/:projectId/aws/rollback', requireProjectAccess, awsController.rollbackDeployment);
router.delete('/:projectId/aws/deployment', requireProjectAccess, awsController.deleteDeployment);

// Phase 7: Real-Time Monitoring & Observability Engine Routes
router.use('/:projectId/monitoring', requireProjectAccess, monitoringRoutes);

// Phase 8: Real Terraform Infrastructure-as-Code Engine Routes
router.use('/:projectId/terraform', requireProjectAccess, terraformRoutes);

// Phase 9: Real Autonomous Self-Healing & Automatic Recovery Engine Routes
router.use('/:projectId/recovery', requireProjectAccess, selfHealingProjectRouter);
router.use('/:projectId/incidents', requireProjectAccess, incidentRouter);

// Phase 10: Intelligent Deployment Orchestrator Routes
router.use('/:projectId/orchestrate', requireProjectAccess, orchestratorRoutes);

module.exports = router;
