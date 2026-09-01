const authService = require('../services/auth/auth.service');
const { extractToken } = require('../middleware/auth.middleware');

class AuthController {
  async signup(req, res) {
    try {
      const { email, password, name, organizationName } = req.body;
      const result = await authService.signup({ email, password, name, organizationName });

      res.status(201).json({
        success: true,
        message: 'Account and organization created successfully.',
        ...result
      });
    } catch (err) {
      const status = err.message.includes('already exists') ? 409 : 400;
      res.status(status).json({
        error: 'SignupError',
        message: err.message
      });
    }
  }

  async login(req, res) {
    try {
      const { email, password, organizationId } = req.body;
      const result = await authService.login({ email, password, organizationId });

      res.status(200).json({
        success: true,
        message: 'Authentication successful.',
        ...result
      });
    } catch (err) {
      res.status(401).json({
        error: 'AuthenticationError',
        message: err.message
      });
    }
  }

  async logout(req, res) {
    try {
      const rawToken = extractToken(req);
      if (rawToken) {
        await authService.revokeToken(rawToken);
      }
      res.status(200).json({
        success: true,
        message: 'Logged out successfully. Session revoked.'
      });
    } catch (err) {
      res.status(500).json({
        error: 'LogoutError',
        message: err.message
      });
    }
  }

  async getCurrentUser(req, res) {
    try {
      res.status(200).json({
        user: req.user,
        organization: req.organization,
        membership: req.membership
      });
    } catch (err) {
      res.status(500).json({
        error: 'ProfileError',
        message: err.message
      });
    }
  }
}

module.exports = new AuthController();
