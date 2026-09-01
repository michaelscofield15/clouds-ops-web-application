const awsClient = require('./aws.client');
const ecrService = require('./ecr.service');
const ec2Service = require('./ec2.service');
const ssmService = require('./ssm.service');
const dockerClient = require('../docker/docker.client');
const storageService = require('../storage.service');
const providerConnectionService = require('../connections/provider.connection.service');
const db = require('../db/db.service');
const config = require('../../config');
const crypto = require('crypto');

class AWSDeploymentService {
  constructor() {
    this.deployments = new Map();
  }

  _formatLog(stage, message) {
    const time = new Date().toISOString().split('T')[1].slice(0, 8);
    return `[${time}] [${stage}] ${message}`;
  }

  _addLog(state, stage, message) {
    const logEntry = this._formatLog(stage, message);
    state.logs.push(logEntry);
    if (state.deploymentId) {
      try {
        const dbDep = db.findById('deployments', state.deploymentId);
        if (dbDep) {
          db.update('deployments', state.deploymentId, {
            logs: state.logs,
            stage: state.stage || stage,
            status: state.status || dbDep.status
          });
        }
      } catch {
        // Ignore async log persistence sync errors
      }
    }
    return logEntry;
  }

  /**
   * Validates project readiness for AWS deployment
   */
  validateProject(projectId) {
    const project = storageService.getProject(projectId);
    if (!project) {
      const err = new Error(`Project '${projectId}' not found`);
      err.statusCode = 404;
      throw err;
    }

    const analysis = project.analysis || project;
    if (!analysis || (!analysis.project && !analysis.runtime)) {
      const err = new Error(`Project '${projectId}' has not been analyzed (Phase 2 required)`);
      err.statusCode = 400;
      throw err;
    }

    const dockerState = project.dockerState;
    if (!dockerState || (!dockerState.image && !dockerState.imageTag)) {
      const err = new Error(`Project '${projectId}' must be dockerized before AWS deployment (Phase 3 required)`);
      err.statusCode = 400;
      throw err;
    }

    const localImageTag = dockerState.image?.tag || dockerState.imageTag;
    const rawPort = analysis.port?.value || analysis.port || (analysis.project && analysis.project.port) || 3000;
    const port = typeof rawPort === 'object' && rawPort !== null ? (parseInt(rawPort.value || rawPort.port, 10) || 3000) : (parseInt(rawPort, 10) || 3000);
    const projectName = analysis.project?.name || 'cloudops-app';

    return {
      project,
      localImageTag,
      port,
      projectName
    };
  }

  /**
   * Deploys project to AWS (ECR -> EC2 via SSM)
   */
  async deploy(projectId, options = {}) {
    const { project, localImageTag, port, projectName } = this.validateProject(projectId);
    const orgId = options.organizationId || (project && project.organizationId) || 'org-default-dev';
    let tenantAwsClient = null;

    if (orgId) {
      try {
        tenantAwsClient = providerConnectionService.getAWSClientForOrg(orgId);
      } catch (err) {
        tenantAwsClient = awsClient;
      }
    }

    const activeAwsClient = tenantAwsClient || awsClient;
    const region = options.region || (tenantAwsClient && tenantAwsClient.region) || config.aws.region || 'ap-south-1';
    const deploymentId = options.deploymentId || `dep-${projectId.slice(0, 8)}-${Date.now()}`;

    const state = {
      id: deploymentId,
      deploymentId,
      projectId,
      projectName,
      organizationId: orgId,
      tenantId: orgId,
      status: 'PENDING',
      stage: 'PENDING',
      isLive: false,
      region,
      awsRegion: region,
      awsAccountId: null,
      ecr: null,
      ecrRepository: null,
      imageTag: null,
      imageDigest: null,
      ec2: null,
      ec2InstanceId: null,
      ec2InstanceType: null,
      ec2Architecture: null,
      containerName: `cloudops-${projectId.slice(0, 8)}`,
      containerId: null,
      containerPort: port,
      hostPort: port,
      endpoint: null,
      host: null,
      publicIp: null,
      publicDns: null,
      publicUrl: null,
      port,
      protocol: 'http',
      health: { status: 'pending' },
      healthCheckStatus: 'pending',
      healthCheckUrl: null,
      healthCheckResponse: null,
      errorCode: null,
      errorMessage: null,
      previousDeployment: null,
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Check if there was an existing live deployment
    const existingLive = db.getLiveDeployment(projectId);
    if (existingLive) {
      state.previousDeployment = {
        deploymentId: existingLive.id,
        targetImageUri: existingLive.targetImageUri || existingLive.ecr?.targetImageUri,
        instanceId: existingLive.ec2InstanceId || existingLive.ec2?.instanceId,
        containerName: existingLive.containerName,
        endpoint: existingLive.publicUrl || existingLive.endpoint
      };
    }

    // Persist initial deployment record to database
    db.insert('deployments', state);
    this.deployments.set(projectId, state);

    // Track resources created by THIS deployment for safe cleanup on failure
    const resourcesCreated = {
      instanceId: null,
      newlyProvisioned: false
    };

    try {
      // 1. AWS Identity Validation
      state.status = 'AWS_VALIDATING';
      state.stage = 'AWS_VALIDATING';
      this._addLog(state, 'AWS_VALIDATE', `Validating AWS credentials and account identity in region '${region}'...`);
      const identity = await activeAwsClient.getCallerIdentity(region);

      if (!identity.connected) {
        throw new Error(`AWS Authentication failed: ${identity.error}`);
      }
      state.awsAccountId = identity.accountId;
      this._addLog(state, 'AWS_VALIDATE', `AWS verified: Account ${identity.accountId} (${identity.arn})`);

      // 2. EC2 Instance Resolution & Safe Reuse Strategy
      let instanceInfo = null;

      // 2a. Check if explicit instanceId requested
      if (options.instanceId) {
        state.status = 'EC2_VALIDATING';
        state.stage = 'EC2_VALIDATING';
        this._addLog(state, 'EC2_VALIDATE', `Validating specified EC2 instance '${options.instanceId}'...`);
        instanceInfo = await ec2Service.validateExistingInstance(options.instanceId, region, activeAwsClient);
        this._addLog(state, 'EC2_VALIDATE', `Specified instance verified: ${instanceInfo.instanceId} (${instanceInfo.state}, Arch: ${instanceInfo.architecture}, Public IP: ${instanceInfo.publicIp})`);
      }

      // 2b. Check if project already has a target instance assigned
      if (!instanceInfo && project && project.targetInstanceId && !options.forceNewInstance) {
        try {
          this._addLog(state, 'EC2_REUSE', `Checking project deployment target '${project.targetInstanceId}'...`);
          const targetValid = await ec2Service.validateExistingInstance(project.targetInstanceId, region, activeAwsClient);
          if (targetValid && targetValid.state === 'running' && targetValid.publicIp) {
            instanceInfo = targetValid;
            this._addLog(state, 'EC2_REUSE', `Reusing project deployment target '${instanceInfo.instanceId}' (Arch: ${instanceInfo.architecture}, Public IP: ${instanceInfo.publicIp})`);
          }
        } catch {
          // Fall through to discovery
        }
      }

      // 2c. Discover existing compatible running EC2 instance for this tenant/project
      if (!instanceInfo && !options.forceNewInstance) {
        const existingCompatible = await ec2Service.findCompatibleProjectInstance(projectId, orgId, region, activeAwsClient);
        if (existingCompatible && existingCompatible.state === 'running' && existingCompatible.publicIp) {
          state.status = 'EC2_VALIDATING';
          state.stage = 'EC2_VALIDATING';
          this._addLog(state, 'EC2_REUSE', `Reusing compatible running EC2 instance '${existingCompatible.instanceId}' (Arch: ${existingCompatible.architecture}, Public IP: ${existingCompatible.publicIp})...`);
          const network = await ec2Service.getDefaultVPCAndSubnet(region, activeAwsClient);
          await ec2Service.ensureSecurityGroup(network.vpcId, port, region, { ProjectId: projectId }, activeAwsClient);
          instanceInfo = existingCompatible;
        }
      }

      // 2d. If no instance found, validate vCPU quota before attempting RunInstances
      if (!instanceInfo) {
        state.status = 'EC2_PROVISIONING';
        state.stage = 'EC2_PROVISIONING';

        this._addLog(state, 'EC2_QUOTA', `Checking AWS EC2 vCPU capacity and quotas in region '${region}'...`);
        const quotaCheck = await ec2Service.checkVcpuQuota(region, 2, activeAwsClient);

        if (!quotaCheck.allowed) {
          const quotaErr = new Error(`AWS EC2 vCPU capacity/quota is insufficient for a new deployment target. Current usage: ${quotaCheck.currentUsage} vCPUs, Quota: ${quotaCheck.quota} vCPUs, Required: ${quotaCheck.required} vCPUs, Available: ${quotaCheck.available} vCPUs. Please clean up unused instances or contact AWS support.`);
          quotaErr.code = 'VCPU_LIMIT_EXCEEDED';
          throw quotaErr;
        }

        this._addLog(state, 'EC2_PROVISION', `vCPU quota check passed (Usage: ${quotaCheck.currentUsage}/${quotaCheck.quota} vCPUs). Auto-provisioning new EC2 target for application port ${port}...`);

        instanceInfo = await ec2Service.provisionInstance({
          port,
          arch: options.arch || 'x86_64',
          instanceType: options.instanceType,
          projectId,
          projectName,
          organizationId: orgId,
          region,
          awsClient: activeAwsClient,
          onLog: (msg) => this._addLog(state, 'EC2_PROVISION', msg)
        });

        resourcesCreated.instanceId = instanceInfo.instanceId;
        resourcesCreated.newlyProvisioned = true;
        this._addLog(state, 'EC2_PROVISION', `New EC2 instance ready: ${instanceInfo.instanceId} (Arch: ${instanceInfo.architecture}, Public IP: ${instanceInfo.publicIp})`);
      }

      state.ec2 = instanceInfo;
      state.ec2InstanceId = instanceInfo.instanceId;
      state.ec2InstanceType = instanceInfo.instanceType;
      state.ec2Architecture = instanceInfo.architecture || 'x86_64';
      state.ec2Platform = ec2Service.getPlatformForArchitecture(instanceInfo.architecture);

      // Determine Target EC2 Architecture and OCI Platform
      const targetPlatform = state.ec2Platform;
      const expectedDockerArch = targetPlatform.includes('arm64') ? 'arm64' : 'amd64';
      this._addLog(state, 'EC2_ARCH', `Target EC2 architecture: '${state.ec2Architecture}' -> Target OCI Platform: '${targetPlatform}'`);

      // 3. Architecture-Aware Local Image Verification & Dynamic Cross-Arch Rebuild
      const localImageInfo = await dockerClient.inspectImage(localImageTag).catch(() => null);
      if (localImageInfo) {
        this._addLog(state, 'DOCKER_INSPECT', `Local image '${localImageTag}' architecture: '${localImageInfo.architecture}' (${localImageInfo.platform})`);
      }

      if (!localImageInfo || (localImageInfo.architecture && localImageInfo.architecture !== 'unknown' && localImageInfo.architecture !== expectedDockerArch)) {
        const currentArch = localImageInfo ? localImageInfo.architecture : 'unknown';
        this._addLog(state, 'DOCKER_BUILD', `Architecture mismatch: Local image is '${currentArch}', but target EC2 instance '${instanceInfo.instanceId}' requires '${expectedDockerArch}' (${targetPlatform}). Rebuilding for target platform...`);

        const workspace = storageService.getWorkspacePath(projectId);
        if (workspace && workspace.extractDir) {
          const buildResult = await dockerClient.buildImage(workspace.extractDir, localImageTag, { platform: targetPlatform });
          this._addLog(state, 'DOCKER_BUILD', `Successfully built '${localImageTag}' for '${targetPlatform}' (Image ID: ${buildResult.imageId?.slice(0, 19)})`);

          storageService.updateProject(projectId, {
            dockerState: {
              ...(project.dockerState || {}),
              image: {
                ...(project.dockerState?.image || {}),
                architecture: buildResult.architecture || expectedDockerArch,
                platform: targetPlatform
              }
            }
          });
        }
      }

      // 4. Publish Immutable Docker image to AWS ECR with Target Platform Manifest
      state.status = 'ECR_PUSHING';
      state.stage = 'ECR_PUSHING';
      const immutableImageTag = `build-${deploymentId.slice(0, 16)}`;
      this._addLog(state, 'ECR_PUSH', `Publishing immutable Docker image tag '${immutableImageTag}' (${targetPlatform}) to AWS ECR...`);

      const ecrResult = await ecrService.publishImageToECR({
        localImageTag,
        imageTag: immutableImageTag,
        projectName,
        projectId,
        organizationId: orgId,
        targetPlatform,
        region,
        awsClient: activeAwsClient,
        onLog: (msg) => this._addLog(state, 'ECR_PUSH', msg)
      });

      state.ecr = ecrResult;
      state.ecrRepository = ecrResult.repositoryUri;
      state.imageTag = ecrResult.imageTag;
      state.imageDigest = ecrResult.imageDigest;
      state.status = 'ECR_VERIFIED';
      state.stage = 'ECR_VERIFIED';
      this._addLog(state, 'ECR_VERIFIED', `Image verified in ECR: ${ecrResult.targetImageUri} (Digest: ${ecrResult.imageDigest}, Platform: ${targetPlatform})`);

      // 5. AWS Systems Manager (SSM) Readiness Check
      state.status = 'SSM_WAITING';
      state.stage = 'SSM_WAITING';
      this._addLog(state, 'SSM', `Verifying SSM connectivity on instance '${instanceInfo.instanceId}'...`);

      await ssmService.waitForInstanceOnline(
        instanceInfo.instanceId,
        region,
        config.aws.ssmTimeoutMs,
        (msg) => this._addLog(state, 'SSM', msg),
        activeAwsClient
      );

      // 6. Deploy Container via SSM Run Command
      state.status = 'DEPLOYING';
      state.stage = 'DEPLOYING';
      this._addLog(state, 'DEPLOY', `Executing Docker deployment on EC2 instance via SSM...`);

      const registryHost = ecrResult.repositoryUri.split('/')[0];
      const ssmDeployRes = await ssmService.deployDockerContainer(instanceInfo.instanceId, {
        ecrRegistryHost: registryHost,
        targetImageUri: ecrResult.targetImageUri,
        containerName: state.containerName,
        port,
        region,
        awsClient: activeAwsClient,
        onLog: (msg) => this._addLog(state, 'DEPLOY', msg)
      });

      state.container = ssmDeployRes;
      state.containerId = ssmDeployRes.containerId;

      // 7. Application Remote HTTP Health Check
      state.status = 'HEALTH_CHECKING';
      state.stage = 'HEALTH_CHECKING';
      const targetHost = instanceInfo.publicIp || instanceInfo.publicDns;

      if (!targetHost) {
        throw new Error(`EC2 instance '${instanceInfo.instanceId}' does not have a public IP or DNS address. No publicly reachable endpoint is configured.`);
      }

      const publicEndpoint = `http://${targetHost}:${port}`;
      state.endpoint = publicEndpoint;
      state.publicUrl = publicEndpoint;
      state.publicIp = targetHost;
      state.publicDns = instanceInfo.publicDns;
      state.host = targetHost;
      state.port = port;
      state.protocol = 'http';
      state.healthCheckUrl = `${publicEndpoint}/health`;
      this._addLog(state, 'HEALTH', `Testing remote HTTP health check at ${publicEndpoint}/health...`);

      const healthRes = await this._verifyEndpointHealth(publicEndpoint, port);
      state.health = healthRes;
      state.healthCheckStatus = healthRes.status;
      state.healthCheckResponse = healthRes.body;

      if (healthRes.status !== 'healthy') {
        throw new Error(`Application health check failed on ${publicEndpoint}: ${healthRes.error || 'Non-200 response'}`);
      }

      this._addLog(state, 'HEALTH', `Health check PASSED: HTTP ${healthRes.statusCode} (${JSON.stringify(healthRes.body)})`);

      // 8. Mark SUCCESS & Promote to LIVE Deployment
      state.status = 'SUCCESS';
      state.stage = 'SUCCESS';
      state.isLive = true;
      state.updatedAt = new Date().toISOString();
      this._addLog(state, 'SUCCESS', `Phase 6 AWS Cloud Deployment SUCCESS! Live application running at ${publicEndpoint}`);

      // Update this deployment in DB
      db.update('deployments', deploymentId, {
        status: 'SUCCESS',
        stage: 'SUCCESS',
        isLive: true,
        endpoint: publicEndpoint,
        publicUrl: publicEndpoint,
        publicIp: targetHost,
        publicDns: instanceInfo.publicDns,
        ec2InstanceId: instanceInfo.instanceId,
        ec2InstanceType: instanceInfo.instanceType,
        ec2Architecture: state.ec2Architecture,
        ecrRepository: ecrResult.repositoryUri,
        imageTag: ecrResult.imageTag,
        imageDigest: ecrResult.imageDigest,
        containerId: state.containerId,
        healthCheckStatus: 'healthy',
        healthCheckUrl: state.healthCheckUrl,
        healthCheckResponse: healthRes.body,
        logs: state.logs,
        updatedAt: state.updatedAt
      });

      // Mark older deployments for this project as isLive = false
      const previousDeployments = db.find('deployments', (d) => d.projectId === projectId && d.id !== deploymentId && d.isLive === true);
      for (const prev of previousDeployments) {
        db.update('deployments', prev.id, { isLive: false });
      }

      // Update project record with live metadata
      storageService.updateProject(projectId, {
        liveDeploymentId: deploymentId,
        liveUrl: publicEndpoint,
        liveEndpoint: publicEndpoint,
        liveInstanceId: instanceInfo.instanceId,
        liveStatus: 'LIVE',
        liveImageTag: ecrResult.imageTag,
        liveImageDigest: ecrResult.imageDigest,
        latestDeploymentId: deploymentId,
        latestStatus: 'SUCCESS',
        targetInstanceId: instanceInfo.instanceId,
        awsState: state
      });

      return state;
    } catch (err) {
      state.status = 'FAILED';
      state.stage = state.stage || 'FAILED';
      state.isLive = false;
      state.errorCode = err.name || 'DEPLOYMENT_FAILED';
      state.errorMessage = err.message;
      state.updatedAt = new Date().toISOString();
      this._addLog(state, 'FAILURE', `AWS Deployment FAILED: ${err.message}`);

      // Update failed deployment record in DB
      db.update('deployments', deploymentId, {
        status: 'FAILED',
        stage: state.stage,
        isLive: false,
        errorCode: state.errorCode,
        errorMessage: state.errorMessage,
        logs: state.logs,
        updatedAt: state.updatedAt
      });

      // Update project record: record latest failure WITHOUT destroying active liveDeployment
      const currentLive = db.getLiveDeployment(projectId);
      storageService.updateProject(projectId, {
        latestDeploymentId: deploymentId,
        latestStatus: 'FAILED',
        awsState: {
          ...(project.awsState || {}),
          status: currentLive ? 'SUCCESS' : 'FAILED',
          latestDeploymentStatus: 'FAILED',
          latestError: err.message,
          logs: state.logs
        }
      });

      // Safe cleanup: only terminate newly provisioned instance if it failed before going live
      if (resourcesCreated.newlyProvisioned && resourcesCreated.instanceId) {
        const liveInstanceId = currentLive?.ec2InstanceId || currentLive?.ec2?.instanceId;
        await ec2Service.cleanupFailedDeploymentResources(
          deploymentId,
          resourcesCreated,
          liveInstanceId,
          region,
          activeAwsClient
        ).catch(() => null);
      }

      throw err;
    }
  }

  /**
   * Performs real HTTP health probe with configurable retries
   */
  async _verifyEndpointHealth(endpoint, port) {
    const healthUrl = `${endpoint}/health`;
    const rootUrl = `${endpoint}/`;
    const retries = config.aws.healthCheckRetries;
    const intervalMs = config.aws.healthCheckIntervalMs;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        // Try /health first
        let res = await fetch(healthUrl, { signal: controller.signal }).catch(() => null);
        clearTimeout(timeout);

        if (!res || res.status !== 200) {
          // Try root endpoint as fallback
          const rootController = new AbortController();
          const rootTimeout = setTimeout(() => rootController.abort(), 5000);
          res = await fetch(rootUrl, { signal: rootController.signal }).catch(() => null);
          clearTimeout(rootTimeout);
        }

        if (res && res.status === 200) {
          let body = {};
          try {
            body = await res.json();
          } catch (e) {
            body = { text: 'ok' };
          }
          return {
            status: 'healthy',
            statusCode: res.status,
            attempt,
            body
          };
        }
      } catch (err) {
        // Retry
      }

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    return {
      status: 'unhealthy',
      statusCode: null,
      error: `Health check timed out after ${retries} attempts on ${endpoint}`
    };
  }

  /**
   * Retrieves all historical deployments for a project
   */
  getDeployments(projectId) {
    return db.findDeploymentsByProject(projectId);
  }

  /**
   * Retrieves current active live deployment for a project
   */
  getLiveDeployment(projectId) {
    return db.getLiveDeployment(projectId);
  }

  /**
   * Retrieves live AWS deployment status with live vs latest distinction
   */
  getStatus(projectId) {
    const liveDeployment = this.getLiveDeployment(projectId);
    const deployments = this.getDeployments(projectId);
    const latestDeployment = deployments[0] || null;
    const project = storageService.getProject(projectId);

    if (this.deployments.has(projectId)) {
      const inMemory = this.deployments.get(projectId);
      return {
        ...inMemory,
        projectId,
        status: latestDeployment ? latestDeployment.status : (inMemory.status || 'not_deployed'),
        liveStatus: liveDeployment ? 'LIVE' : 'not_deployed',
        liveDeployment: liveDeployment || null,
        latestDeployment: latestDeployment || inMemory,
        endpoint: liveDeployment ? (liveDeployment.publicUrl || liveDeployment.endpoint) : (inMemory.endpoint || null),
        liveUrl: liveDeployment ? (liveDeployment.publicUrl || liveDeployment.endpoint) : (inMemory.publicUrl || null)
      };
    }

    if (liveDeployment || latestDeployment) {
      return {
        projectId,
        status: latestDeployment ? latestDeployment.status : (liveDeployment ? 'SUCCESS' : 'not_deployed'),
        liveStatus: liveDeployment ? 'LIVE' : 'not_deployed',
        liveDeployment: liveDeployment || null,
        latestDeployment: latestDeployment || null,
        endpoint: liveDeployment ? (liveDeployment.publicUrl || liveDeployment.endpoint) : null,
        liveUrl: liveDeployment ? (liveDeployment.publicUrl || liveDeployment.endpoint) : null,
        region: liveDeployment?.awsRegion || latestDeployment?.awsRegion || config.aws.region,
        ec2: liveDeployment ? {
          instanceId: liveDeployment.ec2InstanceId,
          instanceType: liveDeployment.ec2InstanceType,
          architecture: liveDeployment.ec2Architecture,
          publicIp: liveDeployment.publicIp,
          publicDns: liveDeployment.publicDns
        } : (latestDeployment?.ec2 || null),
        ecr: liveDeployment ? {
          repositoryUri: liveDeployment.ecrRepository,
          imageTag: liveDeployment.imageTag,
          imageDigest: liveDeployment.imageDigest
        } : (latestDeployment?.ecr || null),
        logs: latestDeployment ? (latestDeployment.logs || []) : (liveDeployment?.logs || [])
      };
    }

    if (project && project.awsState) {
      return project.awsState;
    }

    return {
      projectId,
      status: 'not_deployed',
      liveStatus: 'not_deployed',
      stage: 'not_deployed',
      endpoint: null,
      liveUrl: null,
      liveDeployment: null,
      latestDeployment: null,
      logs: []
    };
  }

  /**
   * Retrieves deployment logs
   */
  getLogs(projectId) {
    const status = this.getStatus(projectId);
    return {
      projectId,
      status: status.status,
      logs: status.logs || []
    };
  }

  /**
   * Rollback to previous deployment if available
   */
  async rollback(projectId, options = {}) {
    const state = this.getStatus(projectId);
    if (!state || !state.previousDeployment) {
      throw new Error(`No previous successful AWS deployment found for project '${projectId}' to rollback to`);
    }

    const prev = state.previousDeployment;
    const region = options.region || state.region || config.aws.region;

    this._addLog(state, 'ROLLBACK', `Initiating rollback to previous image '${prev.targetImageUri}' on instance '${prev.instanceId}'...`);
    state.status = 'ROLLBACK';
    state.stage = 'ROLLBACK';

    try {
      const registryHost = prev.targetImageUri.split('/')[0];
      const ssmRes = await ssmService.deployDockerContainer(prev.instanceId, {
        ecrRegistryHost: registryHost,
        targetImageUri: prev.targetImageUri,
        containerName: prev.containerName,
        port: options.port || 3000,
        region,
        onLog: (msg) => this._addLog(state, 'ROLLBACK', msg)
      });

      const healthRes = await this._verifyEndpointHealth(prev.endpoint, options.port || 3000);
      if (healthRes.status !== 'healthy') {
        throw new Error(`Rollback health check failed: ${healthRes.error}`);
      }

      state.status = 'SUCCESS';
      state.stage = 'SUCCESS';
      state.endpoint = prev.endpoint;
      state.publicUrl = prev.endpoint;
      state.health = healthRes;
      this._addLog(state, 'ROLLBACK', `Rollback completed successfully! Application restored at ${prev.endpoint}`);

      storageService.updateProject(projectId, { awsState: state, liveUrl: prev.endpoint });
      return state;
    } catch (err) {
      state.status = 'FAILED';
      state.error = `Rollback failed: ${err.message}`;
      this._addLog(state, 'ROLLBACK', `Rollback failed: ${err.message}`);
      storageService.updateProject(projectId, { awsState: state });
      throw err;
    }
  }

  /**
   * Clean up AWS resources for a project
   */
  async cleanup(projectId, options = {}) {
    const state = this.getStatus(projectId);
    const region = options.region || state.region || config.aws.region;

    if (state.ec2 && state.ec2.instanceId) {
      // Stop container
      try {
        await ssmService.stopContainer(state.ec2.instanceId, state.containerName, region);
      } catch (e) {
        // Container may already be stopped
      }

      // If explicit terminate requested
      if (options.terminateInstance) {
        try {
          await ec2Service.terminateInstance(state.ec2.instanceId, region);
        } catch (e) {
          // May already be terminated
        }
      }
    }

    state.status = 'DELETED';
    state.stage = 'DELETED';
    this._addLog(state, 'CLEANUP', `AWS resources cleaned up for project '${projectId}'`);
    storageService.updateProject(projectId, { awsState: null, liveUrl: null, liveDeploymentId: null });
    this.deployments.delete(projectId);

    return {
      success: true,
      projectId,
      status: 'cleaned_up'
    };
  }
}

module.exports = new AWSDeploymentService();
module.exports.AWSDeploymentService = AWSDeploymentService;
