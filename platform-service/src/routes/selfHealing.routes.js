const express = require('express');
const selfHealingController = require('../controllers/selfHealing.controller');

const globalRouter = express.Router();
const projectRouter = express.Router({ mergeParams: true });

// Global Recovery Endpoints (/api/recovery/*)
globalRouter.get('/status', selfHealingController.getGlobalStatus);
globalRouter.post('/pause', selfHealingController.pauseGlobalRecovery);
globalRouter.post('/resume', selfHealingController.resumeGlobalRecovery);

// Project-Scoped Recovery Endpoints (/api/projects/:projectId/recovery/*)
projectRouter.get('/status', selfHealingController.getProjectRecoveryStatus);
projectRouter.post('/settings', selfHealingController.updateProjectSettings);
projectRouter.post('/check', selfHealingController.triggerRecoveryCheck);
projectRouter.get('/remediations', selfHealingController.getProjectRemediations);

// Project-Scoped Incidents Endpoints (/api/projects/:projectId/incidents/*)
const incidentRouter = express.Router({ mergeParams: true });
incidentRouter.get('/', selfHealingController.getProjectIncidents);
incidentRouter.get('/:incidentId', selfHealingController.getIncidentDetail);
incidentRouter.post('/:incidentId/acknowledge', selfHealingController.acknowledgeIncident);
incidentRouter.post('/:incidentId/approve', selfHealingController.approveRemediation);
incidentRouter.post('/:incidentId/resolve', selfHealingController.resolveIncident);

module.exports = {
  globalRouter,
  projectRouter,
  incidentRouter
};
