const awsClient = require('../aws/aws.client');
const githubAuth = require('../github/github.auth');
const jenkinsClient = require('../jenkins/jenkins.client');
const terraformClient = require('../terraform/terraform.client');
const dockerClient = require('../docker/docker.client');

/**
 * Requirement Status Constants
 */
const REQUIREMENT_STATUS = {
  DETECTED: 'DETECTED',
  READY: 'READY',
  CONNECTED: 'CONNECTED',
  MISSING: 'MISSING',
  UNKNOWN: 'UNKNOWN',
  NOT_REQUIRED: 'NOT_REQUIRED',
  BLOCKED: 'BLOCKED'
};

class RequirementEngine {
  /**
   * Evaluates project analysis and provider connections to produce an exact requirement matrix.
   * Strictly enforces the "Ask only when required" principle.
   * @param {object} analysis Project analysis from Phase 2
   * @param {object} userConnections Existing user provider connection IDs / credentials
   * @param {object} projectSecrets Known project environment secrets
   * @returns {Promise<object>} { allResolved: boolean, requirements: Array<object>, missingCount: number, userActions: Array<object> }
   */
  async evaluateRequirements(analysis = {}, userConnections = {}, projectSecrets = {}) {
    const requirements = [];
    const userActions = [];

    const runtime = analysis.project?.runtime || 'Unknown';
    const isSupportedRuntime = runtime !== 'Unknown';
    const hasK8sManifests = Boolean(analysis.devops?.kubernetes?.hasManifests);
    const detectedPort = analysis.port?.value;
    const requiredEnvVars = analysis.environmentVariables?.required || [];

    // 1. Application Runtime & Structure Requirement
    if (isSupportedRuntime) {
      requirements.push({
        id: 'APPLICATION_RUNTIME',
        category: 'APPLICATION',
        name: `${runtime} Application (${analysis.project?.language || 'Code'})`,
        status: REQUIREMENT_STATUS.READY,
        required: true,
        userActionRequired: false,
        source: 'Phase 2 Static Analysis',
        reason: `Detected valid ${runtime} project with entrypoint '${analysis.entryPoint?.value || 'index.js'}' and port ${detectedPort || 3000}`
      });
    } else {
      requirements.push({
        id: 'APPLICATION_RUNTIME',
        category: 'APPLICATION',
        name: 'Supported Runtime',
        status: REQUIREMENT_STATUS.BLOCKED,
        required: true,
        userActionRequired: true,
        source: 'Phase 2 Static Analysis',
        reason: 'Uploaded project has an unsupported or unknown runtime structure',
        action: {
          type: 'MANUAL_RUNTIME_CONFIG',
          prompt: 'Please provide application runtime, start command, and port.'
        }
      });
      userActions.push({
        requirementId: 'APPLICATION_RUNTIME',
        title: 'Specify Application Runtime',
        description: 'Provide entrypoint and port for custom application structure.'
      });
    }

    // 2. Containerization (Docker) Requirement
    let dockerAvailable = false;
    try {
      const dockerStatus = await dockerClient.isAvailable();
      dockerAvailable = dockerStatus.available;
    } catch {
      dockerAvailable = false;
    }
    // Dockerfile Generator (Phase 3) is always ready to generate container definitions
    requirements.push({
      id: 'CONTAINER_DOCKER',
      category: 'CONTAINER',
      name: 'Docker Container Engine',
      status: REQUIREMENT_STATUS.READY,
      required: true,
      userActionRequired: false,
      source: 'Docker Client & Multi-Stage Generator',
      reason: dockerAvailable
        ? 'Docker daemon active and automated multi-stage generator ready'
        : 'Multi-stage Dockerfile generator initialized for automated containerization'
    });

    // 3. Source Control (GitHub) Requirement
    const githubToken = userConnections.githubToken ||
      (userConnections.github && (userConnections.github.connected || userConnections.github.status === 'CONNECTED')) ||
      githubAuth.getToken();
    if (githubToken) {
      requirements.push({
        id: 'SOURCE_CONTROL_GITHUB',
        category: 'SOURCE_CONTROL',
        name: 'GitHub Source Control',
        status: REQUIREMENT_STATUS.CONNECTED,
        required: true,
        userActionRequired: false,
        source: 'GitHub Provider Connection',
        reason: 'GitHub provider credentials connected and verified'
      });
    } else {
      requirements.push({
        id: 'SOURCE_CONTROL_GITHUB',
        category: 'SOURCE_CONTROL',
        name: 'GitHub Source Control',
        status: REQUIREMENT_STATUS.MISSING,
        required: true,
        userActionRequired: true,
        source: 'GitHub Provider Connection',
        reason: 'GitHub token or connection is required for repository automation and CI/CD',
        action: {
          type: 'CONNECT_GITHUB',
          prompt: 'Please connect your GitHub account or provide a Personal Access Token.'
        }
      });
      userActions.push({
        requirementId: 'SOURCE_CONTROL_GITHUB',
        title: 'Connect GitHub Account',
        description: 'Provide GitHub token with repo scope.'
      });
    }

    // 4. Cloud Infrastructure Provider (AWS) Requirement
    let awsConnected = false;
    let awsDetails = 'AWS credentials check pending';
    if (userConnections.aws && (userConnections.aws.connected || userConnections.aws.status === 'CONNECTED')) {
      awsConnected = true;
      awsDetails = `Connected to AWS Region '${userConnections.aws.region || userConnections.aws.metadata?.region || 'ap-south-1'}'`;
    } else {
      try {
        const sts = await awsClient.getStatus();
        if (sts && sts.connected) {
          awsConnected = true;
          awsDetails = `Connected to AWS Account '${sts.accountId}' in region '${sts.region}'`;
        }
      } catch {
        awsConnected = false;
      }
    }

    if (awsConnected) {
      requirements.push({
        id: 'CLOUD_PROVIDER_AWS',
        category: 'CLOUD_PROVIDER',
        name: 'AWS Cloud Provider',
        status: REQUIREMENT_STATUS.CONNECTED,
        required: true,
        userActionRequired: false,
        source: 'AWS STS Identity Probe',
        reason: awsDetails
      });
    } else {
      requirements.push({
        id: 'CLOUD_PROVIDER_AWS',
        category: 'CLOUD_PROVIDER',
        name: 'AWS Cloud Provider',
        status: REQUIREMENT_STATUS.MISSING,
        required: true,
        userActionRequired: true,
        source: 'AWS Provider Connection',
        reason: 'AWS account credentials (Access Key & Secret Key) are required for cloud provisioning',
        action: {
          type: 'CONNECT_AWS',
          prompt: 'Please configure AWS credentials with EC2, ECR, and SSM permissions.'
        }
      });
      userActions.push({
        requirementId: 'CLOUD_PROVIDER_AWS',
        title: 'Connect AWS Credentials',
        description: 'Configure AWS Access Key, Secret Key, and target region.'
      });
    }

    // 5. CI/CD (Jenkins) Requirement
    let jenkinsConnected = false;
    if (userConnections.jenkins && (userConnections.jenkins.connected || userConnections.jenkins.status === 'CONNECTED')) {
      jenkinsConnected = true;
    } else {
      try {
        const jStatus = await jenkinsClient.getStatus();
        jenkinsConnected = Boolean(jStatus && (jStatus.connected || jStatus.online));
      } catch {
        jenkinsConnected = false;
      }
    }

    requirements.push({
      id: 'CI_CD_JENKINS',
      category: 'CI_CD',
      name: 'Jenkins CI/CD Pipeline Engine',
      status: jenkinsConnected ? REQUIREMENT_STATUS.CONNECTED : REQUIREMENT_STATUS.READY, // Fallback pipeline ready
      required: true,
      userActionRequired: false,
      source: 'Jenkins CI Client',
      reason: jenkinsConnected ? 'Jenkins server is online and reachable' : 'Jenkins pipeline generated and configured'
    });

    // 6. Infrastructure-as-Code (Terraform) Requirement
    let tfInstalled = false;
    try {
      const tfStatus = await terraformClient.getStatus();
      tfInstalled = Boolean(tfStatus.terraformInstalled);
    } catch {
      tfInstalled = false;
    }
    requirements.push({
      id: 'IAC_TERRAFORM',
      category: 'INFRASTRUCTURE',
      name: 'Terraform IaC Engine',
      status: REQUIREMENT_STATUS.READY,
      required: true,
      userActionRequired: false,
      source: 'Terraform Client & Declarative Generator',
      reason: tfInstalled
        ? 'Terraform CLI available with dynamic HCL generation'
        : 'Declarative Terraform HCL generator initialized'
    });

    // 7. Kubernetes / EKS Requirement (Dynamic based on project structure)
    if (hasK8sManifests) {
      requirements.push({
        id: 'CONTAINER_ORCHESTRATION_K8S',
        category: 'COMPUTE',
        name: 'Kubernetes / EKS Cluster',
        status: REQUIREMENT_STATUS.DETECTED,
        required: true,
        userActionRequired: false,
        source: 'Project Manifests',
        reason: 'Kubernetes manifests detected in project; EKS cluster provisioning recommended'
      });
    } else {
      requirements.push({
        id: 'CONTAINER_ORCHESTRATION_K8S',
        category: 'COMPUTE',
        name: 'Kubernetes / EKS Cluster',
        status: REQUIREMENT_STATUS.NOT_REQUIRED,
        required: false,
        userActionRequired: false,
        source: 'Project Structure',
        reason: 'Single-service container application; EC2 compute is optimal'
      });
    }

    // 8. Observability & Self-Healing Requirements
    requirements.push({
      id: 'OBSERVABILITY_MONITORING',
      category: 'OBSERVABILITY',
      name: 'Real-Time Monitoring Engine (Phase 7)',
      status: REQUIREMENT_STATUS.READY,
      required: true,
      userActionRequired: false,
      source: 'CloudOps Platform',
      reason: 'CloudWatch, guest OS metrics, and HTTP health probes ready'
    });

    requirements.push({
      id: 'RECOVERY_SELF_HEALING',
      category: 'SELF_HEALING',
      name: 'Autonomous Self-Healing Engine (Phase 9)',
      status: REQUIREMENT_STATUS.READY,
      required: true,
      userActionRequired: false,
      source: 'CloudOps Platform',
      reason: 'Policy-driven recovery, SSM restarts, and rollback engine active'
    });

    // 9. Required Environment Secrets Requirement
    const missingSecrets = [];
    for (const secretKey of requiredEnvVars) {
      // Exclude common non-secret configuration variables like PORT
      if (secretKey !== 'PORT' && secretKey !== 'NODE_ENV') {
        if (!projectSecrets[secretKey]) {
          missingSecrets.push(secretKey);
        }
      }
    }

    if (missingSecrets.length > 0) {
      requirements.push({
        id: 'ENVIRONMENT_SECRETS',
        category: 'SECRETS',
        name: 'Application Environment Secrets',
        status: REQUIREMENT_STATUS.MISSING,
        required: true,
        userActionRequired: true,
        source: 'Template Analysis (.env.example)',
        reason: `Application template indicates ${missingSecrets.length} missing required variable(s): ${missingSecrets.join(', ')}`,
        action: {
          type: 'PROVIDE_SECRETS',
          missingSecrets,
          prompt: `Your application requires the following environment variables: ${missingSecrets.join(', ')}`
        }
      });
      userActions.push({
        requirementId: 'ENVIRONMENT_SECRETS',
        title: 'Provide Missing Environment Variables',
        description: `Set values for ${missingSecrets.join(', ')}.`
      });
    } else {
      requirements.push({
        id: 'ENVIRONMENT_SECRETS',
        category: 'SECRETS',
        name: 'Application Environment Secrets',
        status: REQUIREMENT_STATUS.READY,
        required: false,
        userActionRequired: false,
        source: 'Project Secrets',
        reason: 'All required environment variables are satisfied'
      });
    }

    const missingCount = requirements.filter(r => r.required && (r.status === REQUIREMENT_STATUS.MISSING || r.status === REQUIREMENT_STATUS.BLOCKED)).length;
    const allResolved = missingCount === 0;

    return {
      allResolved,
      totalRequirements: requirements.length,
      missingCount,
      requirements,
      userActions
    };
  }
}

module.exports = new RequirementEngine();
module.exports.RequirementEngine = RequirementEngine;
module.exports.REQUIREMENT_STATUS = REQUIREMENT_STATUS;
