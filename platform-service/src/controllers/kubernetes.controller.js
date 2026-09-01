const kubernetesEngine = require('../services/kubernetes');
const prereqService = require('../services/kubernetes/prereq.service');

async function getPrerequisitesStatus(req, res, next) {
  try {
    const status = await prereqService.checkPrerequisites();
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

async function createCluster(req, res, next) {
  try {
    const { clusterName } = req.body || {};
    const result = await prereqService.ensureCluster(clusterName);
    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function deployProject(req, res, next) {
  try {
    const { projectId } = req.params;
    const result = await kubernetesEngine.deploy(projectId, req.body);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

async function getProjectDeploymentStatus(req, res, next) {
  try {
    const { projectId } = req.params;
    const status = await kubernetesEngine.getStatus(projectId);
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

async function getProjectPods(req, res, next) {
  try {
    const { projectId } = req.params;
    const status = await kubernetesEngine.getStatus(projectId);
    return res.status(200).json(status.pods || []);
  } catch (err) {
    next(err);
  }
}

async function getProjectService(req, res, next) {
  try {
    const { projectId } = req.params;
    const status = await kubernetesEngine.getStatus(projectId);
    return res.status(200).json(status.service || null);
  } catch (err) {
    next(err);
  }
}

async function getProjectLogs(req, res, next) {
  try {
    const { projectId } = req.params;
    const lines = parseInt(req.query.lines, 10) || 200;
    const logs = await kubernetesEngine.getLogs(projectId, lines);
    return res.status(200).json(logs);
  } catch (err) {
    next(err);
  }
}

async function getProjectEvents(req, res, next) {
  try {
    const { projectId } = req.params;
    const events = await kubernetesEngine.getEvents(projectId);
    return res.status(200).json(events);
  } catch (err) {
    next(err);
  }
}

async function deleteProjectDeployment(req, res, next) {
  try {
    const { projectId } = req.params;
    const result = await kubernetesEngine.deleteDeployment(projectId);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPrerequisitesStatus,
  createCluster,
  deployProject,
  getProjectDeploymentStatus,
  getProjectPods,
  getProjectService,
  getProjectLogs,
  getProjectEvents,
  deleteProjectDeployment
};
