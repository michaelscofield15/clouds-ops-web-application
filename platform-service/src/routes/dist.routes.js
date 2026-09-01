const express = require('express');
const distController = require('../controllers/dist.controller');

const router = express.Router();

// Public release metadata and binary download endpoints
router.get('/api/agent/dist/version', (req, res) => distController.getReleaseVersion(req, res));
router.get('/api/agent/dist/cloudops-agent', (req, res) => distController.downloadAgentBinary(req, res));

// Public installer scripts (macOS/Linux and Windows)
router.get('/install.sh', (req, res) => distController.serveUnixInstaller(req, res));
router.get('/install.ps1', (req, res) => distController.serveWindowsInstaller(req, res));

module.exports = router;
