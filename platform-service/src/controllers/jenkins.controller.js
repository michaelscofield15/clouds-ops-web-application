const defaultJenkinsClient = require('../services/jenkins/jenkins.client');
const storageService = require('../services/storage.service');
const auditService = require('../services/audit.service');
const providerConnectionService = require('../services/connections/provider.connection.service');

function resolveJenkinsClient(req) {
  if (req.organization?.id) {
    try {
      return providerConnectionService.getJenkinsClientForOrg(req.organization.id);
    } catch {
      return null;
    }
  }
  return defaultJenkinsClient;
}

async function getStatus(req, res, next) {
  try {
    const client = resolveJenkinsClient(req);
    if (!client) {
      return res.status(200).json({ connected: false, status: 'NOT_CONNECTED', message: 'Jenkins server not connected for this organization.' });
    }
    const status = await client.getStatus();
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

async function createPipelineJob(req, res, next) {
  try {
    const { projectId } = req.params;
    const metadata = storageService.getProject(projectId);
    const integration = metadata?.integration || {};

    const client = resolveJenkinsClient(req);
    if (!client) {
      return res.status(400).json({
        error: 'Jenkins Not Connected',
        message: 'Please connect your Jenkins server in Settings -> Provider Connections first.'
      });
    }

    let {
      gitRepoUrl = integration.githubUrl ? `${integration.githubUrl.replace(/\/tree\/.*$/, '')}.git` : null,
      branchName = integration.githubBranch || 'main',
      jobName: customJobName,
      credentialsId = ''
    } = req.body || {};

    if (!gitRepoUrl && (!integration.githubOwner || !integration.githubRepository)) {
      return res.status(400).json({
        error: 'Missing Repository',
        message: 'No GitHub repository associated with this project. Please push to GitHub first or provide gitRepoUrl.'
      });
    }

    const finalGitRepoUrl = gitRepoUrl || `https://github.com/${integration.githubOwner}/${integration.githubRepository}.git`;
    const shortId = projectId.substring(0, 8);
    const sanitizedRepoName = (integration.githubRepository || 'app').replace(/[^a-zA-Z0-9_-]/g, '-');
    const jobName = customJobName || `cloudops-${sanitizedRepoName}-${shortId}`;

    // Auto-provision GitHub credentials in Jenkins if available
    let activeToken = null;
    if (req.organization?.id) {
      try { activeToken = providerConnectionService.getGitHubTokenForOrg(req.organization.id); } catch {}
    }
    if (!credentialsId && activeToken) {
      try {
        await client.ensureGitHubCredentials('cloudops-github-token', activeToken);
        credentialsId = 'cloudops-github-token';
      } catch (err) {
        console.warn('[JenkinsController] Failed to auto-provision GitHub credentials:', err.message);
      }
    }

    const result = await client.createOrUpdateJob(jobName, {
      gitRepoUrl: finalGitRepoUrl,
      branchName,
      credentialsId
    });

    // Persist Jenkins metadata
    storageService.updateProject(projectId, {
      integration: {
        ...integration,
        jenkinsJobName: jobName,
        jenkinsJobUrl: result.url,
        lastJobAction: result.action
      }
    });

    auditService.log(projectId, 'JENKINS_JOB_CREATED', 'SUCCESS', {
      jobName,
      action: result.action,
      url: result.url
    });

    return res.status(200).json({
      status: 'success',
      jobName,
      url: result.url,
      action: result.action,
      gitRepoUrl: finalGitRepoUrl,
      branchName
    });
  } catch (err) {
    next(err);
  }
}

async function triggerBuild(req, res, next) {
  try {
    const { projectId } = req.params;
    const metadata = storageService.getProject(projectId);
    const integration = metadata?.integration || {};

    let jobName = req.body?.jobName || integration.jenkinsJobName;
    if (!jobName) {
      if (integration.githubOwner && integration.githubRepository) {
        // Auto-create the job if GitHub integration is linked
        const sanitizedRepoName = (integration.githubRepository || 'app').replace(/[^a-zA-Z0-9_-]/g, '-');
        jobName = `cloudops-${sanitizedRepoName}-${projectId.substring(0, 8)}`;
        try {
          await client.createOrUpdateJob(jobName, {
            gitRepoUrl: `https://github.com/${integration.githubOwner}/${integration.githubRepository}.git`,
            branchName: 'main'
          });
          storageService.updateProject(projectId, {
            integration: { ...integration, jenkinsJobName: jobName }
          });
        } catch (jobErr) {
          return res.status(200).json({
            status: 'skipped',
            configured: false,
            message: `Jenkins job auto-creation skipped: ${jobErr.message}`
          });
        }
      } else {
        return res.status(200).json({
          status: 'skipped',
          configured: false,
          message: 'No Jenkins job specified or configured for this project. Push to GitHub first to enable automated Jenkins CI builds.'
        });
      }
    }

    const triggerResult = await jenkinsClient.triggerBuild(jobName);

    // Wait briefly (up to 3s) for the build number to be assigned in queue
    let buildNumber = null;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      buildNumber = await jenkinsClient.getLatestBuildNumber(jobName);
      if (buildNumber) break;
    }

    // Default to 1 if first build
    buildNumber = buildNumber || 1;

    storageService.updateProject(projectId, {
      integration: {
        ...integration,
        lastBuildNumber: buildNumber,
        lastBuildStatus: 'triggered',
        lastBuildTriggeredAt: new Date().toISOString()
      }
    });

    auditService.log(projectId, 'JENKINS_BUILD_TRIGGERED', 'SUCCESS', {
      jobName,
      buildNumber
    });

    return res.status(200).json({
      status: 'triggered',
      job: jobName,
      buildNumber,
      queueLocation: triggerResult.queueLocation
    });
  } catch (err) {
    next(err);
  }
}

async function getBuildInfo(req, res, next) {
  try {
    const { projectId, buildNumber } = req.params;
    const metadata = storageService.getProject(projectId);
    const integration = metadata?.integration || {};

    const jobName = req.query.jobName || integration.jenkinsJobName;
    if (!jobName) {
      return res.status(400).json({
        error: 'Missing Jenkins Job',
        message: 'No Jenkins job specified or found in project metadata'
      });
    }

    const info = await jenkinsClient.getBuildInfo(jobName, buildNumber);

    if (info.result) {
      storageService.updateProject(projectId, {
        integration: {
          ...integration,
          lastBuildStatus: info.result,
          lastBuildDurationMs: info.durationMs
        }
      });
    }

    return res.status(200).json(info);
  } catch (err) {
    next(err);
  }
}

async function getBuildLogs(req, res, next) {
  try {
    const { projectId, buildNumber } = req.params;
    const metadata = storageService.getProject(projectId);
    const integration = metadata?.integration || {};

    const jobName = req.query.jobName || integration.jenkinsJobName;
    if (!jobName) {
      return res.status(400).json({
        error: 'Missing Jenkins Job',
        message: 'No Jenkins job specified or found in project metadata'
      });
    }

    const logsData = await jenkinsClient.getBuildLogs(jobName, buildNumber);
    return res.status(200).json(logsData);
  } catch (err) {
    next(err);
  }
}

async function getAuditLogs(req, res, next) {
  try {
    const { projectId } = req.params;
    const logs = auditService.getProjectLogs(projectId);
    return res.status(200).json({ projectId, logs });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStatus,
  createPipelineJob,
  triggerBuild,
  getBuildInfo,
  getBuildLogs,
  getAuditLogs
};
