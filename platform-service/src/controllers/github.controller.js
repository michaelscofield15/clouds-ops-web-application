const githubClient = require('../services/github/github.client');
const githubAuth = require('../services/github/github.auth');
const auditService = require('../services/audit.service');
const providerConnectionService = require('../services/connections/provider.connection.service');

function resolveToken(req) {
  if (req.organization?.id) {
    try {
      return providerConnectionService.getGitHubTokenForOrg(req.organization.id);
    } catch {
      return null;
    }
  }
  return githubAuth.getToken();
}

async function getAccount(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) {
      return res.status(200).json({ connected: false, status: 'NOT_CONNECTED', message: 'GitHub account not connected.' });
    }

    try {
      const account = await githubClient.getAccount(token);
      return res.status(200).json({ ...account, connected: true, status: 'CONNECTED' });
    } catch (err) {
      if (err.status === 401 || err.code === 'GITHUB_AUTH_FAILED') {
        return res.status(200).json({ connected: false, status: 'ERROR', error: 'GitHub authentication token is invalid or expired' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

async function connectAccount(req, res, next) {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'GitHub token is required' });
    }

    const trimmedToken = token.trim();
    // Validate token with real GitHub API
    const account = await githubClient.getAccount(trimmedToken);

    // Save in tenant provider connections if authenticated
    if (req.organization?.id) {
      await providerConnectionService.createConnection({
        organizationId: req.organization.id,
        userId: req.user?.id || 'usr-default',
        provider: 'GITHUB',
        name: `GitHub (${account.username})`,
        credentials: { token: trimmedToken },
        metadata: { username: account.username }
      });
    } else {
      githubAuth.setToken(trimmedToken);
    }

    auditService.log('system', 'GITHUB_CONNECTED', 'SUCCESS', {
      username: account.username,
      organizationId: req.organization?.id
    });

    return res.status(200).json({
      connected: true,
      status: 'CONNECTED',
      username: account.username,
      name: account.name,
      avatarUrl: account.avatarUrl,
      htmlUrl: account.htmlUrl
    });
  } catch (err) {
    auditService.log('system', 'GITHUB_CONNECT_FAILED', 'FAILED', { error: err.message });
    res.status(err.status || 400).json({
      error: 'GitHub Connection Failed',
      message: err.message,
      code: err.code || 'GITHUB_ERROR'
    });
  }
}

async function disconnectAccount(req, res, next) {
  try {
    if (req.organization?.id) {
      const connections = providerConnectionService.listConnections(req.organization.id);
      const ghConn = connections.find(c => c.provider === 'GITHUB');
      if (ghConn) {
        providerConnectionService.deleteConnection(ghConn.id, req.organization.id);
      }
    }
    githubAuth.clearToken();
    auditService.log('system', 'GITHUB_DISCONNECTED', 'SUCCESS', { organizationId: req.organization?.id });
    return res.status(200).json({ connected: false, message: 'GitHub account disconnected successfully' });
  } catch (err) {
    next(err);
  }
}

async function listRepositories(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) {
      return res.status(401).json({ error: 'GitHub is not connected for this organization' });
    }

    const repositories = await githubClient.listRepositories(token);
    return res.status(200).json({ repositories });
  } catch (err) {
    next(err);
  }
}

async function createRepository(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) {
      return res.status(401).json({ error: 'GitHub is not connected for this organization' });
    }

    const { name, private: isPrivate, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Repository name is required' });
    }

    const repo = await githubClient.createRepository(token, {
      name,
      private: isPrivate !== false,
      description
    });

    auditService.log('system', 'GITHUB_REPO_CREATED', 'SUCCESS', {
      fullName: repo.fullName,
      organizationId: req.organization?.id
    });
    return res.status(201).json({ repository: repo });
  } catch (err) {
    next(err);
  }
}

async function listBranches(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) {
      return res.status(401).json({ error: 'GitHub is not connected for this organization' });
    }

    const { owner, repo } = req.params;
    if (!owner || !repo) {
      return res.status(400).json({ error: 'Owner and repository name are required' });
    }

    const branches = await githubClient.listBranches(token, owner, repo);
    return res.status(200).json({ branches });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAccount,
  connectAccount,
  disconnectAccount,
  listRepositories,
  createRepository,
  listBranches
};
