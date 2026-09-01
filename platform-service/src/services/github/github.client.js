const githubAuth = require('./github.auth');

class GitHubClient {
  constructor(apiBaseUrl = 'https://api.github.com') {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Helper to perform authenticated GitHub API requests
   */
  async _request(endpoint, options = {}) {
    const token = options.token || githubAuth.getToken();
    if (!token) {
      const err = new Error('GitHub is not connected. Please provide a valid GitHub authentication token.');
      err.status = 401;
      err.code = 'GITHUB_NOT_CONNECTED';
      throw err;
    }

    const url = `${this.apiBaseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Autonomous-DevOps-Platform',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    };

    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 6000);

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (response.status === 204) {
      return null;
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = data.message || `GitHub API error: ${response.status} ${response.statusText}`;
      const err = new Error(errorMsg);
      err.status = response.status;
      err.code = response.status === 401 ? 'GITHUB_AUTH_FAILED' : response.status === 403 ? 'GITHUB_FORBIDDEN' : 'GITHUB_API_ERROR';
      err.details = data;
      throw err;
    }

    return data;
  }

  /**
   * Retrieves authenticated user account info
   */
  async getAccount(token) {
    const user = await this._request('/user', { method: 'GET', token });
    return {
      connected: true,
      username: user.login,
      name: user.name || user.login,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url
    };
  }

  /**
   * Lists repositories for the authenticated user
   */
  async listRepositories(token) {
    const repos = await this._request('/user/repos?sort=updated&per_page=100', { method: 'GET', token });
    return repos.map(repo => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login,
      private: repo.private,
      defaultBranch: repo.default_branch,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      permissions: repo.permissions
    }));
  }

  /**
   * Creates a new GitHub repository for the authenticated user
   */
  async createRepository(token, { name, private: isPrivate = true, description = 'Application managed by Autonomous CloudOps' }) {
    if (!name || typeof name !== 'string') {
      throw new Error('Repository name is required');
    }

    const sanitizedName = name.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
    const repo = await this._request('/user/repos', {
      method: 'POST',
      token,
      body: {
        name: sanitizedName,
        private: Boolean(isPrivate),
        description,
        auto_init: false
      }
    });

    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login,
      private: repo.private,
      defaultBranch: repo.default_branch || 'main',
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url
    };
  }

  /**
   * Lists branches for a given repository
   */
  async listBranches(token, owner, repo) {
    if (!owner || !repo) {
      throw new Error('Repository owner and name are required to list branches');
    }

    const branches = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`, {
      method: 'GET',
      token
    });

    return branches.map(b => ({
      name: b.name,
      commitSha: b.commit?.sha,
      protected: Boolean(b.protected)
    }));
  }

  /**
   * Verifies a specific commit ref on GitHub
   */
  async verifyCommit(token, owner, repo, ref) {
    if (!owner || !repo || !ref) {
      throw new Error('Repository owner, name, and ref are required to verify commit');
    }

    const commit = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`, {
      method: 'GET',
      token
    });

    return {
      sha: commit.sha,
      message: commit.commit?.message,
      author: commit.commit?.author,
      htmlUrl: commit.html_url,
      filesCount: commit.files?.length || 0
    };
  }
}

module.exports = new GitHubClient();
module.exports.GitHubClient = GitHubClient;
