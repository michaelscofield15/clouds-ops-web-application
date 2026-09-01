const express = require('express');
const jenkinsController = require('../controllers/jenkins.controller');

const router = express.Router();

// Jenkins Status
router.get('/status', jenkinsController.getStatus);

module.exports = router;
