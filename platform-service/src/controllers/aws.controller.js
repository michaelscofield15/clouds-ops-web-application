const awsClient = require('../services/aws/aws.client');
const awsDeploymentService = require('../services/aws/aws.deployment.service');
const ecrService = require('../services/aws/ecr.service');
const auditService = require('../services/audit.service');
const providerConnectionService = require('../services/connections/provider.connection.service');

class AWSController {
  /**
   * GET /api/aws/status (Tenant-Scoped)
   */
  async getStatus(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        const config = require('../config');
        return res.status(200).json({ connected: false, status: 'NOT_CONNECTED', region: config.aws?.region || 'ap-south-1', message: 'Authentication required' });
      }

      try {
        const preflight = await providerConnectionService.checkAWSPermissions(orgId);
        return res.status(200).json({
          connected: true,
          status: 'CONNECTED',
          accountId: preflight.accountId,
          arn: preflight.arn,
          region: preflight.region,
          verifiedAt: preflight.verifiedAt
        });
      } catch (err) {
        const config = require('../config');
        return res.status(200).json({
          connected: false,
          status: 'NOT_CONNECTED',
          region: config.aws?.region || 'ap-south-1',
          message: err.message
        });
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/aws/preflight (Preflight Permission & Quota Verification)
   */
  async preflightCheck(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const result = await providerConnectionService.checkAWSPermissions(orgId);
      return res.status(200).json({
        valid: true,
        ...result
      });
    } catch (err) {
      return res.status(400).json({
        valid: false,
        error: 'Preflight Check Failed',
        message: err.message
      });
    }
  }

  /**
   * GET /api/aws/ec2 (List live EC2 instances in tenant account)
   */
  async getEC2Instances(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(200).json({ connected: false, instances: [], message: 'Authentication required' });
      }

      let activeClient;
      try {
        activeClient = providerConnectionService.getAWSClientForOrg(orgId);
      } catch (err) {
        return res.status(200).json({ connected: false, instances: [], message: err.message });
      }

      try {
        const ec2Service = require('../services/aws/ec2.service');
        const instances = await ec2Service.listInstances(activeClient.region, activeClient);
        return res.status(200).json({
          connected: true,
          region: activeClient.region,
          instances
        });
      } finally {
        activeClient.destroy();
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/aws/ecr (List live ECR repositories in tenant account)
   */
  async getECRRepositories(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(200).json({ connected: false, repositories: [], message: 'Authentication required' });
      }

      let activeClient;
      try {
        activeClient = providerConnectionService.getAWSClientForOrg(orgId);
      } catch (err) {
        return res.status(200).json({ connected: false, repositories: [], message: err.message });
      }

      try {
        const ecrService = require('../services/aws/ecr.service');
        const repositories = await ecrService.listRepositories(activeClient.region, activeClient);
        return res.status(200).json({
          connected: true,
          region: activeClient.region,
          repositories
        });
      } finally {
        activeClient.destroy();
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/aws/resources (List all live EC2 and ECR resources in tenant account)
   */
  async getInfrastructureResources(req, res, next) {
    try {
      const orgId = req.organization?.id;
      if (!orgId) {
        return res.status(200).json({ connected: false, ec2: [], ecr: [], message: 'Authentication required' });
      }

      let activeClient;
      try {
        activeClient = providerConnectionService.getAWSClientForOrg(orgId);
      } catch (err) {
        return res.status(200).json({ connected: false, ec2: [], ecr: [], message: err.message });
      }

      try {
        const ec2Service = require('../services/aws/ec2.service');
        const ecrService = require('../services/aws/ecr.service');

        const [instances, repositories] = await Promise.all([
          ec2Service.listInstances(activeClient.region, activeClient).catch(() => []),
          ecrService.listRepositories(activeClient.region, activeClient).catch(() => [])
        ]);

        return res.status(200).json({
          connected: true,
          region: activeClient.region,
          ec2: instances,
          ecr: repositories
        });
      } finally {
        activeClient.destroy();
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/aws/validate
   */
  async validateProject(req, res, next) {
    try {
      const { projectId } = req.params;
      const validation = awsDeploymentService.validateProject(projectId);
      res.status(200).json({
        valid: true,
        projectId,
        projectName: validation.projectName,
        localImageTag: validation.localImageTag,
        port: validation.port
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/aws/ecr
   */
  async publishECR(req, res, next) {
    try {
      const { projectId } = req.params;
      const { region } = req.body;
      const { localImageTag, projectName } = awsDeploymentService.validateProject(projectId);

      const ecrResult = await ecrService.publishImageToECR({
        localImageTag,
        projectName,
        projectId,
        region
      });

      auditService.record(projectId, 'AWS_ECR_PUSH', {
        repositoryUri: ecrResult.repositoryUri,
        imageTag: ecrResult.imageTag,
        digest: ecrResult.imageDigest
      });

      res.status(200).json({
        status: 'success',
        ...ecrResult
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/aws/deploy
   */
  async deployProject(req, res, next) {
    try {
      const { projectId } = req.params;
      const orgId = req.organization?.id;
      const options = {
        ...(req.body || {}),
        organizationId: orgId
      };

      const result = await awsDeploymentService.deploy(projectId, options);

      auditService.record(projectId, 'AWS_DEPLOY_SUCCESS', {
        organizationId: orgId,
        endpoint: result.endpoint,
        instanceId: result.ec2?.instanceId,
        repository: result.ecr?.repositoryUri,
        digest: result.ecr?.imageDigest
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/deployments
   * Returns all historical deployment records for project
   */
  async listDeployments(req, res, next) {
    try {
      const { projectId } = req.params;
      const deployments = awsDeploymentService.getDeployments(projectId);
      res.status(200).json({
        projectId,
        deployments,
        total: deployments.length
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/deployments/live
   * Returns the current active live deployment record
   */
  async getLiveDeployment(req, res, next) {
    try {
      const { projectId } = req.params;
      const liveDeployment = awsDeploymentService.getLiveDeployment(projectId);
      if (!liveDeployment) {
        return res.status(200).json({
          projectId,
          live: false,
          deployment: null,
          message: 'No live deployment currently active for this project'
        });
      }
      res.status(200).json({
        projectId,
        live: true,
        deployment: liveDeployment
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/aws/status
   */
  async getDeploymentStatus(req, res, next) {
    try {
      const { projectId } = req.params;
      const status = awsDeploymentService.getStatus(projectId);
      res.status(200).json(status);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/aws/logs
   */
  async getDeploymentLogs(req, res, next) {
    try {
      const { projectId } = req.params;
      const logs = awsDeploymentService.getLogs(projectId);
      res.status(200).json(logs);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/projects/:projectId/aws/resources
   */
  async getDeploymentResources(req, res, next) {
    try {
      const { projectId } = req.params;
      const state = awsDeploymentService.getStatus(projectId);

      res.status(200).json({
        projectId,
        status: state.status,
        region: state.region,
        ecr: state.ecr || null,
        ec2: state.ec2 || null,
        container: state.container || null,
        endpoint: state.endpoint || null
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/projects/:projectId/aws/rollback
   */
  async rollbackDeployment(req, res, next) {
    try {
      const { projectId } = req.params;
      const result = await awsDeploymentService.rollback(projectId, req.body);

      auditService.record(projectId, 'AWS_ROLLBACK_SUCCESS', {
        endpoint: result.endpoint
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/projects/:projectId/aws/deployment
   */
  async deleteDeployment(req, res, next) {
    try {
      const { projectId } = req.params;
      const result = await awsDeploymentService.cleanup(projectId, req.body);

      auditService.record(projectId, 'AWS_CLEANUP', {
        status: 'cleaned_up'
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AWSController();
