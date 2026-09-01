const config = require('../../config');

class GitHubAuthService {
  constructor() {
    this.runtimeToken = null;
  }

  /**
   * Sets the active GitHub token dynamically (e.g. from connect API or OAuth)
   */
  setToken(token) {
    if (!token || typeof token !== 'string') {
      this.runtimeToken = null;
    } else {
      this.runtimeToken = token.trim();
    }
  }

  /**
   * Gets the active GitHub token from runtime state or environment config
   */
  getToken() {
    return this.runtimeToken || config.github.token || null;
  }

  /**
   * Clears the active GitHub token
   */
  clearToken() {
    this.runtimeToken = null;
  }

  /**
   * Checks if a GitHub token is configured
   */
  hasToken() {
    return Boolean(this.getToken());
  }
}

module.exports = new GitHubAuthService();
