const storageService = require('../services/storage.service');
const gitClient = require('../services/git/git.client');
const secretScanner = require('../services/git/secret.scanner');
const githubAuth = require('../services/github/github.auth');
const githubClient = require('../services/github/github.client');
const pipelineGenerator = require('../services/jenkins/pipeline.generator');
const dockerfileGenerator = require('../services/docker/dockerfile.generator');
const connectionFactory = require('../services/connections/connection.factory');
const db = require('../services/db/db.service');
const auditService = require('../services/audit.service');

async function pushToGitHub(req, res, next) {
  try {
    const { projectId } = req.params;
    let { repository, branch, message } = req.body;

    const orgId = req.organization?.id;
    let token = null;
    if (orgId) {
      const conn = db.findOne('connections', { organizationId: orgId, provider: 'GITHUB' });
      if (conn) {
        try {
          token = connectionFactory.getGitHubToken(conn.id, orgId);
        } catch {}
      }
    }
    if (!token) {
      token = githubAuth.getToken();
    }

    if (!token) {
      return res.status(401).json({
        error: 'GitHub Not Connected',
        message: 'Please connect your GitHub account before pushing'
      });
    }

    if (!repository || typeof repository !== 'string') {
      return res.status(400).json({
        error: 'Missing Repository',
        message: 'Target GitHub repository (e.g. owner/repo) is required'
      });
    }

    // Parse owner and repo
    const parts = repository.trim().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return res.status(400).json({
        error: 'Invalid Repository Format',
        message: 'Repository must be in the format "owner/repo"'
      });
    }
    const [owner, repoName] = parts;

    // 1. Retrieve project workspace
    const projectDir = storageService.getWorkspaceDir(projectId);
    if (!projectDir) {
      return res.status(404).json({
        error: 'Project Workspace Not Found',
        message: `Workspace for project ID '${projectId}' not found`
      });
    }

    const metadata = storageService.getProject(projectId);
    const analysis = metadata?.analysis || {};

    // 2. Pre-Push Secret Scanning
    const scanResult = secretScanner.scanDirectory(projectDir);
    if (!scanResult.passed) {
      auditService.log(projectId, 'PRE_PUSH_SECRET_SCAN', 'BLOCKED', { findingsCount: scanResult.findingsCount });
      return res.status(400).json({
        status: 'blocked',
        reason: 'Potential secret detected',
        findingsCount: scanResult.findingsCount,
        findings: scanResult.findings
      });
    }

    // 3. Ensure Dockerfile and Jenkinsfile are present
    dockerfileGenerator.prepareDockerfile(projectDir, analysis);
    pipelineGenerator.writeJenkinsfile(projectDir, analysis);

    // 4. Default branch strategy: cloudops/provision/<shortId> unless specified
    const shortId = projectId.substring(0, 8);
    const targetBranch = (branch && typeof branch === 'string' && branch.trim())
      ? branch.trim()
      : `cloudops/provision/${shortId}`;

    // 5. Initialize Git and prepare branch
    await gitClient.init(projectDir);
    const actualBranch = await gitClient.checkoutBranch(projectDir, targetBranch);

    // 6. Commit changes
    const commitMsg = message || `chore: provision application for CloudOps (project ${shortId})`;
    const commitResult = await gitClient.addAndCommit(projectDir, commitMsg);

    // 7. Configure authenticated remote URL and push
    // Construct authenticated URL: https://x-access-token:<token>@github.com/<owner>/<repo>.git
    const authenticatedUrl = `https://x-access-token:${token}@github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}.git`;
    await gitClient.setRemote(projectDir, authenticatedUrl);

    try {
      await gitClient.push(projectDir, authenticatedUrl, actualBranch, true);
    } catch (pushErr) {
      auditService.log(projectId, 'GIT_PUSH_FAILED', 'FAILED', { repository, branch: actualBranch, error: pushErr.message });
      return res.status(400).json({
        error: 'Git Push Failed',
        message: pushErr.message
      });
    }

    // 8. Verify commit exists on GitHub
    let verifiedCommit = null;
    try {
      verifiedCommit = await githubClient.verifyCommit(token, owner, repoName, commitResult.hash);
    } catch {
      // If direct hash lookup isn't indexed instantly, query the branch ref
      try {
        verifiedCommit = await githubClient.verifyCommit(token, owner, repoName, actualBranch);
      } catch {
        // commit pushed, continuing
      }
    }

    const githubUrl = `https://github.com/${owner}/${repoName}/tree/${actualBranch}`;

    // 9. Persist integration metadata
    const integrationData = {
      githubOwner: owner,
      githubRepository: repoName,
      githubBranch: actualBranch,
      lastCommitHash: commitResult.hash,
      lastCommitMessage: commitMsg,
      githubUrl,
      pushedAt: new Date().toISOString()
    };

    storageService.updateProject(projectId, {
      integration: {
        ...(metadata.integration || {}),
        ...integrationData
      }
    });

    auditService.log(projectId, 'GIT_PUSH_SUCCESS', 'SUCCESS', {
      repository: `${owner}/${repoName}`,
      branch: actualBranch,
      commitHash: commitResult.hash
    });

    return res.status(200).json({
      status: 'success',
      repository: {
        owner,
        name: repoName,
        branch: actualBranch,
        fullName: `${owner}/${repoName}`
      },
      commit: {
        hash: commitResult.hash,
        message: commitMsg,
        author: commitResult.author
      },
      url: githubUrl,
      verifiedOnGitHub: Boolean(verifiedCommit)
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  pushToGitHub
};
