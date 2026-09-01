const express = require('express');
const githubController = require('../controllers/github.controller');

const router = express.Router();

// GitHub Account & Auth
router.get('/account', githubController.getAccount);
router.post('/connect', githubController.connectAccount);
router.post('/disconnect', githubController.disconnectAccount);

// Repository Management
router.get('/repos', githubController.listRepositories);
router.post('/repos', githubController.createRepository);
router.get('/repos/:owner/:repo/branches', githubController.listBranches);

module.exports = router;
