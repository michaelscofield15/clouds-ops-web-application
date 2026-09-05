const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');

router.post('/signup', authLimiter, (req, res) => authController.signup(req, res));
router.post('/login', authLimiter, (req, res) => authController.login(req, res));
router.post('/google', authLimiter, (req, res) => authController.googleAuth(req, res));
router.get('/google', (req, res) => authController.googleRedirect(req, res));
router.get('/google/callback', (req, res) => authController.googleCallback(req, res));
router.get('/config', (req, res) => authController.getAuthConfig(req, res));
router.post('/logout', requireAuth, (req, res) => authController.logout(req, res));
router.get('/me', requireAuth, (req, res) => authController.getCurrentUser(req, res));

module.exports = router;
