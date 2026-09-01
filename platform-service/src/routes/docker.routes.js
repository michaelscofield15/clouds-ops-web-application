const express = require('express');
const {
  dockerizeProject,
  getDockerStatus,
  getDockerLogs,
  stopDockerContainer
} = require('../controllers/docker.controller');

const router = express.Router({ mergeParams: true });

router.post('/dockerize', dockerizeProject);
router.get('/docker', getDockerStatus);
router.get('/docker/logs', getDockerLogs);
router.delete('/docker', stopDockerContainer);

module.exports = router;
