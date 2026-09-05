const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');
const config = require('../../config');

class GoogleAuthService {
  constructor() {
    this.clientId = config.google?.clientId || process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = config.google?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
    this.callbackUrl = config.google?.callbackUrl || process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/auth/google/callback';
    this.client = new OAuth2Client(this.clientId, this.clientSecret, this.callbackUrl);
  }

  /**
   * Re-evaluates client credentials dynamically in case environment variables change
   */
  _getClient() {
    const currentId = config.google?.clientId || process.env.GOOGLE_CLIENT_ID || '';
    const currentSecret = config.google?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
    const currentCallback = config.google?.callbackUrl || process.env.GOOGLE_CALLBACK_URL || this.callbackUrl;

    if (currentId !== this.clientId || currentSecret !== this.clientSecret || currentCallback !== this.callbackUrl) {
      this.clientId = currentId;
      this.clientSecret = currentSecret;
      this.callbackUrl = currentCallback;
      this.client = new OAuth2Client(this.clientId, this.clientSecret, this.callbackUrl);
    }
    return this.client;
  }

  /**
   * Returns whether Google Auth is configured with at least a client ID
   */
  isConfigured() {
    const id = config.google?.clientId || process.env.GOOGLE_CLIENT_ID || '';
    return !!(id && id.trim().length > 0);
  }

  /**
   * Gets the public client ID (safe to share with frontend)
   */
  getClientId() {
    return config.google?.clientId || process.env.GOOGLE_CLIENT_ID || '';
  }

  /**
   * Generates Google OAuth 2.0 authorization URL
   */
  getAuthorizationUrl(state) {
    if (!this.isConfigured()) {
      throw new Error('Google OAuth is not configured on this server (GOOGLE_CLIENT_ID is missing)');
    }

    const client = this._getClient();
    return client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      prompt: 'select_account',
      state: state || crypto.randomBytes(16).toString('hex')
    });
  }

  /**
   * Verifies Google OpenID Connect ID Token and returns sanitized profile
   * @param {string} idToken
   */
  async verifyIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string') {
      throw new Error('Missing Google ID token');
    }

    const client = this._getClient();
    const clientId = this.getClientId();

    if (!clientId) {
      throw new Error('Google Client ID is not configured on the server');
    }

    try {
      const ticket = await client.verifyIdToken({
        idToken: idToken.trim(),
        audience: clientId
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new Error('Empty payload returned from Google authentication');
      }

      if (!payload.sub) {
        throw new Error('Google token payload missing subject (sub) identifier');
      }

      if (!payload.email) {
        throw new Error('Google account must provide a verified email address');
      }

      return {
        googleId: payload.sub,
        email: payload.email.toLowerCase().trim(),
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: (payload.name && payload.name.trim()) || payload.email.split('@')[0],
        givenName: payload.given_name || '',
        familyName: payload.family_name || '',
        avatar: payload.picture || null
      };
    } catch (err) {
      // Re-throw with clear message, avoiding token leaks
      if (err.message.includes('Token used too late') || err.message.includes('expired')) {
        throw new Error('Google authentication token has expired. Please sign in again.');
      }
      if (err.message.includes('Wrong recipient') || err.message.includes('audience')) {
        throw new Error('Google token client ID does not match server configuration.');
      }
      throw new Error(`Google identity verification failed: ${err.message}`);
    }
  }

  /**
   * Exchanges authorization code for tokens and verifies identity
   * @param {string} code
   */
  async exchangeCode(code) {
    if (!code || typeof code !== 'string') {
      throw new Error('Missing Google authorization code');
    }

    const client = this._getClient();
    try {
      const { tokens } = await client.getToken(code.trim());
      if (tokens.id_token) {
        return await this.verifyIdToken(tokens.id_token);
      }

      // Fallback: If no id_token in response, verify with access_token via Google UserInfo API
      if (tokens.access_token) {
        client.setCredentials(tokens);
        const userInfoRes = await client.request({
          url: 'https://www.googleapis.com/oauth2/v3/userinfo'
        });
        const data = userInfoRes.data;
        if (!data || !data.sub) {
          throw new Error('Failed to retrieve user information from Google');
        }
        return {
          googleId: data.sub,
          email: data.email?.toLowerCase()?.trim(),
          emailVerified: data.email_verified === true,
          name: (data.name && data.name.trim()) || data.email?.split('@')[0],
          givenName: data.given_name || '',
          familyName: data.family_name || '',
          avatar: data.picture || null
        };
      }

      throw new Error('No authentication token received from Google exchange');
    } catch (err) {
      throw new Error(`Google OAuth code exchange failed: ${err.message}`);
    }
  }
}

module.exports = new GoogleAuthService();
module.exports.GoogleAuthService = GoogleAuthService;
