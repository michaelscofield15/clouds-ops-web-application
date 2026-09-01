const dockerEngine = require('../services/docker');

/**
 * Trigger automated Dockerization for an analyzed project
 */
const dockerizeProject = async (req, res, next) => {
  const { projectId } = req.params;

  try {
    const result = await dockerEngine.dockerize(projectId);

    if (result.status === 'blocked') {
      return res.status(503).json(result);
    }

    if (result.status === 'failed') {
      return res.status(422).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

/**
 * Get current Dockerization status
 */
const getDockerStatus = async (req, res, next) => {
  const { projectId } = req.params;

  try {
    const status = await dockerEngine.getStatus(projectId);
    return res.status(200).json(status);
  } catch (err) {
    return next(err);
  }
};

/**
 * Retrieve container logs
 */
const getDockerLogs = async (req, res, next) => {
  const { projectId } = req.params;
  const tail = parseInt(req.query.tail, 10) || 100;

  try {
    const logs = await dockerEngine.getLogs(projectId, tail);
    return res.status(200).json(logs);
  } catch (err) {
    return next(err);
  }
};

/**
 * Stop and clean up active container
 */
const stopDockerContainer = async (req, res, next) => {
  const { projectId } = req.params;

  try {
    const result = await dockerEngine.stopContainer(projectId);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  dockerizeProject,
  getDockerStatus,
  getDockerLogs,
  stopDockerContainer
};
