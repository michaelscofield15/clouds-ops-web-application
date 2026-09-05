const authService = require('../services/auth/auth.service');
const { extractToken } = require('../middleware/auth.middleware');
const config = require('../config');

class AuthController {
  constructor() {
    this.signup = this.signup.bind(this);
    this.login = this.login.bind(this);
    this.logout = this.logout.bind(this);
    this.googleAuth = this.googleAuth.bind(this);
    this.googleRedirect = this.googleRedirect.bind(this);
    this.googleCallback = this.googleCallback.bind(this);
    this.getCurrentUser = this.getCurrentUser.bind(this);
    this.getAuthConfig = this.getAuthConfig.bind(this);
  }

  _setSessionCookie(req, res, token) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' && isHttps,
      sameSite: 'lax',
      maxAge: authService.getSessionTtlMs(),
      path: '/'
    });
  }

  async signup(req, res) {
    try {
      const { email, password, name, organizationName } = req.body;
      const result = await authService.signup({ email, password, name, organizationName });

      // Set 3-day persistent session cookie
      this._setSessionCookie(req, res, result.token);

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

      // Set 3-day persistent session cookie
      this._setSessionCookie(req, res, result.token);

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
      res.clearCookie('session_token', { path: '/' });
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

  /**
   * Handles Google OAuth / OpenID Connect token verification from frontend
   * POST /api/auth/google
   */
  async googleAuth(req, res) {
    try {
      const { idToken, credential, code } = req.body;
      // GIS returns 'credential' containing the ID token JWT
      const tokenToVerify = idToken || credential;

      if (!tokenToVerify && !code) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'Google authentication credential (idToken or code) is required'
        });
      }

      const result = await authService.authenticateWithGoogle({ idToken: tokenToVerify, code });

      // Set 3-day persistent session cookie
      this._setSessionCookie(req, res, result.token);

      res.status(200).json({
        success: true,
        message: 'Google authentication successful.',
        ...result
      });
    } catch (err) {
      const isAuthError = err.message.includes('expired') || err.message.includes('verification failed') || err.message.includes('client ID');
      res.status(isAuthError ? 401 : 400).json({
        error: 'GoogleAuthenticationError',
        message: err.message
      });
    }
  }

  /**
   * Initiates standard Google OAuth 2.0 redirect flow
   * GET /api/auth/google
   */
  async googleRedirect(req, res) {
    try {
      const googleService = require('../services/auth/google.service');
      if (!googleService.isConfigured()) {
        return res.status(503).json({
          error: 'ConfigurationError',
          message: 'Google authentication is not configured on this server (missing GOOGLE_CLIENT_ID)'
        });
      }

      const crypto = require('crypto');
      const state = crypto.randomBytes(16).toString('hex');
      res.cookie('oauth_state', state, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax', path: '/' });

      const authUrl = googleService.getAuthorizationUrl(state);
      res.redirect(authUrl);
    } catch (err) {
      res.status(500).json({
        error: 'OAuthRedirectError',
        message: err.message
      });
    }
  }

  /**
   * Handles Google OAuth 2.0 callback redirect
   * GET /api/auth/google/callback
   */
  async googleCallback(req, res) {
    try {
      const { code, state, error } = req.query;

      if (error) {
        return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
      }

      if (!code) {
        return res.redirect(`/?auth_error=${encodeURIComponent('No authorization code received from Google')}`);
      }

      const result = await authService.authenticateWithGoogle({ code });

      // Set 3-day persistent session cookie
      this._setSessionCookie(req, res, result.token);

      // Redirect user to dashboard with auth handoff token
      res.redirect(`/#auth_token=${encodeURIComponent(result.token)}`);
    } catch (err) {
      res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
    }
  }

  /**
   * Exposes public authentication client configuration and upload limits
   * GET /api/auth/config
   */
  async getAuthConfig(req, res) {
    const googleService = require('../services/auth/google.service');
    res.status(200).json({
      googleClientId: googleService.getClientId(),
      googleEnabled: googleService.isConfigured(),
      maxUploadSizeMb: config.maxUploadSizeMb || 1024,
      sessionTtlDays: authService.getSessionTtlDays()
    });
  }
}

module.exports = new AuthController();
