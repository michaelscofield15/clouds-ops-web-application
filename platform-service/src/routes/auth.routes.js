const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');

router.post('/signup', authLimiter, authController.signup);
router.post('/login', authLimiter, authController.login);
router.post('/google', authLimiter, authController.googleAuth);
router.get('/google', authController.googleRedirect);
router.get('/google/callback', authController.googleCallback);
router.get('/config', authController.getAuthConfig);
router.post('/logout', requireAuth, authController.logout);
router.get('/me', requireAuth, authController.getCurrentUser);

module.exports = router;
