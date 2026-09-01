const crypto = require('crypto');
const db = require('../db/db.service');
const secretVault = require('../security/secret.vault');

function maskSecret(val) {
  if (!val || typeof val !== 'string') return '****';
  if (val.length <= 8) return '****';
  return `${val.slice(0, 4)}****${val.slice(-4)}`;
}

const getAWSClient = () => require('../aws/aws.client').AWSClient;
const getJenkinsClient = () => require('../jenkins/jenkins.client').JenkinsClient;
const getTerraformEngine = () => require('../terraform');
const getPrereqService = () => require('../kubernetes/prereq.service');

const CONNECTION_STATUSES = {
  NOT_CONNECTED: 'NOT_CONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  ERROR: 'ERROR'
};

const PROVIDER_METADATA = {
  AWS: {
    displayName: 'AWS Cloud Provider',
    purpose: 'ECR container registry, EC2 compute host, SSM automation, and CloudWatch metrics.',
    requiredPermissions: [
      'sts:GetCallerIdentity',
      'ecr:GetAuthorizationToken',
      'ecr:CreateRepository',
      'ecr:PutImage',
      'ec2:DescribeInstances',
      'ec2:RunInstances',
      'ssm:SendCommand',
      'ssm:GetCommandInvocation'
    ]
  },
  GITHUB: {
    displayName: 'GitHub Source Control',
    purpose: 'Version control synchronization, repository initialization, and automated release commits.',
    requiredPermissions: ['repo', 'workflow', 'read:user']
  },
  JENKINS: {
    displayName: 'Jenkins CI/CD Automation',
    purpose: 'Declarative pipeline job creation, automated builds, and multi-stage testing.',
    requiredPermissions: ['Job/Create', 'Job/Build', 'Job/Read', 'Job/Configure']
  },
  TERRAFORM: {
    displayName: 'Terraform Infrastructure as Code',
    purpose: 'Automated declarative infrastructure provisioning and state lifecycle management.',
    requiredPermissions: ['terraform:init', 'terraform:plan', 'terraform:apply']
  },
  KUBERNETES: {
    displayName: 'Kubernetes Container Orchestrator',
    purpose: 'Multi-pod container workload scheduling, ingress routing, and rollout verification.',
    requiredPermissions: ['apps/deployments', 'core/services', 'core/pods', 'core/namespaces']
  }
};

class ProviderConnectionService {
  /**
   * Sanitizes a connection record to ensure no secrets or raw credentials ever reach the API
   */
  sanitizeConnection(conn) {
    if (!conn) return null;
    const { secretReference, ...safe } = conn;
    return safe;
  }

  /**
   * Creates or updates a provider connection for an organization
   */
  async createConnection({ organizationId, userId, provider, name, credentials = {}, metadata = {} }) {
    if (!organizationId || !provider) {
      throw new Error('organizationId and provider type are required');
    }

    const upperProvider = provider.toUpperCase();
    if (!['AWS', 'GITHUB', 'JENKINS', 'TERRAFORM', 'KUBERNETES'].includes(upperProvider)) {
      throw new Error(`Unsupported provider: '${provider}'. Supported: AWS, GITHUB, JENKINS, TERRAFORM, KUBERNETES`);
    }

    const providerMeta = PROVIDER_METADATA[upperProvider] || {};
    let secretReference = null;
    let safeMetadata = {
      ...metadata,
      purpose: providerMeta.purpose,
      requiredPermissions: providerMeta.requiredPermissions
    };

    let connectionStatus = CONNECTION_STATUSES.NOT_CONNECTED;

    if (upperProvider === 'AWS') {
      const { accessKeyId, secretAccessKey, sessionToken, region } = credentials;
      const cleanAccessKey = (accessKeyId && accessKeyId.trim()) || '';
      const cleanSecretKey = (secretAccessKey && secretAccessKey.trim()) || '';
      const cleanSessionToken = (sessionToken && sessionToken.trim()) || null;
      const cleanRegion = (region && region.trim()) || metadata.region || 'ap-south-1';

      if (cleanAccessKey && cleanSecretKey) {
        secretReference = secretVault.encrypt({
          accessKeyId: cleanAccessKey,
          secretAccessKey: cleanSecretKey,
          ...(cleanSessionToken ? { sessionToken: cleanSessionToken } : {}),
          region: cleanRegion
        });
        safeMetadata.region = cleanRegion;
        safeMetadata.maskedAccessKey = maskSecret(cleanAccessKey);
        connectionStatus = CONNECTION_STATUSES.CONNECTED;
      } else {
        safeMetadata.region = cleanRegion;
        connectionStatus = CONNECTION_STATUSES.NOT_CONNECTED;
      }
    } else if (upperProvider === 'GITHUB') {
      const { token } = credentials;
      if (token) {
        secretReference = secretVault.encrypt({ token: token.trim() });
        safeMetadata.maskedToken = maskSecret(token);
        connectionStatus = CONNECTION_STATUSES.CONNECTED;
      }
    } else if (upperProvider === 'JENKINS') {
      const { url, username, apiToken } = credentials;
      if (url && username && apiToken) {
        secretReference = secretVault.encrypt({
          url: url.trim().replace(/\/+$/, ''),
          username: username.trim(),
          apiToken: apiToken.trim()
        });
        safeMetadata.url = url.trim().replace(/\/+$/, '');
        safeMetadata.username = username.trim();
        safeMetadata.maskedApiToken = maskSecret(apiToken);
        connectionStatus = CONNECTION_STATUSES.CONNECTED;
      }
    } else if (upperProvider === 'TERRAFORM') {
      const { binaryPath, workingDir } = credentials;
      secretReference = secretVault.encrypt({
        binaryPath: (binaryPath && binaryPath.trim()) || 'terraform',
        workingDir: (workingDir && workingDir.trim()) || ''
      });
      safeMetadata.binaryPath = binaryPath || 'terraform';
      connectionStatus = CONNECTION_STATUSES.CONNECTED;
    } else if (upperProvider === 'KUBERNETES') {
      const { kubeconfig, contextName, namespace } = credentials;
      if (kubeconfig) {
        secretReference = secretVault.encrypt({
          kubeconfig: kubeconfig.trim(),
          contextName: (contextName && contextName.trim()) || 'default',
          namespace: (namespace && namespace.trim()) || 'default'
        });
        safeMetadata.contextName = contextName || 'default';
        safeMetadata.namespace = namespace || 'default';
        connectionStatus = CONNECTION_STATUSES.CONNECTED;
      }
    }

    const connId = `conn-${upperProvider.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    const newConn = {
      id: connId,
      organizationId,
      userId,
      provider: upperProvider,
      name: name || `${providerMeta.displayName || upperProvider} Connection`,
      status: connectionStatus,
      secretReference,
      metadata: safeMetadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Remove existing connection for same provider in this org if replacing
    const existing = db.find('connections', (c) => c.organizationId === organizationId && c.provider === upperProvider);
    for (const old of existing) {
      if (old.secretReference) {
        secretVault.deleteSecret(old.secretReference);
      }
      db.delete('connections', old.id);
    }

    const saved = db.insert('connections', newConn);

    try {
      const auditService = require('../audit.service');
      auditService.log('system', 'PROVIDER_CONNECTED', 'SUCCESS', {
        organizationId,
        userId,
        provider: upperProvider,
        connectionId: saved.id
      });
    } catch {}

    return this.sanitizeConnection(saved);
  }

  /**
   * Retrieves a sanitized connection by ID with organization verification
   */
  getConnection(connectionId, organizationId) {
    if (!connectionId || !organizationId) return null;
    const conn = db.findOne('connections', { id: connectionId, organizationId });
    return this.sanitizeConnection(conn);
  }

  /**
   * Retrieves the raw connection record (with secretReference) strictly for server-side factory use
   */
  getRawConnection(connectionId, organizationId) {
    if (!connectionId || !organizationId) return null;
    return db.findOne('connections', { id: connectionId, organizationId });
  }

  /**
   * Lists all provider connections for an organization
   */
  listConnections(organizationId) {
    if (!organizationId) return [];
    const list = db.find('connections', (c) => c.organizationId === organizationId);
    return list.map((c) => this.sanitizeConnection(c));
  }

  /**
   * Deletes a provider connection and destroys its vault encryption keys
   */
  deleteConnection(connectionId, organizationId) {
    const conn = db.findOne('connections', { id: connectionId, organizationId });
    if (!conn) {
      throw new Error(`Connection '${connectionId}' not found in organization '${organizationId}'`);
    }

    if (conn.secretReference) {
      secretVault.deleteSecret(conn.secretReference);
    }

    db.delete('connections', connectionId);
    return { success: true, deletedId: connectionId };
  }

  /**
   * Real test of remote provider connectivity against live APIs
   */
  async testConnection(connectionId, organizationId) {
    const conn = db.findOne('connections', { id: connectionId, organizationId });
    if (!conn) {
      throw new Error(`Connection '${connectionId}' not found in organization '${organizationId}'`);
    }

    if (!conn.secretReference) {
      throw new Error('Connection has no credentials configured');
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted) {
      db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
      throw new Error('Failed to decrypt stored credentials');
    }

    if (conn.provider === 'AWS') {
      const clientConfig = { region: decrypted.region || 'ap-south-1' };
      if (decrypted.accessKeyId && decrypted.secretAccessKey) {
        clientConfig.accessKeyId = decrypted.accessKeyId;
        clientConfig.secretAccessKey = decrypted.secretAccessKey;
        if (decrypted.sessionToken) clientConfig.sessionToken = decrypted.sessionToken;
      }

      const AWSClientClass = getAWSClient();
      const client = new AWSClientClass(clientConfig);
      const identity = await client.getCallerIdentity();
      client.destroy();

      if (identity.connected) {
        db.update('connections', connectionId, {
          status: CONNECTION_STATUSES.CONNECTED,
          metadata: {
            ...conn.metadata,
            accountId: identity.accountId,
            arn: identity.arn,
            lastVerifiedAt: new Date().toISOString()
          }
        });
        return {
          success: true,
          provider: 'AWS',
          accountId: identity.accountId,
          arn: identity.arn,
          region: identity.region
        };
      } else {
        db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
        throw new Error(identity.error || 'AWS STS authentication failed');
      }
    } else if (conn.provider === 'GITHUB') {
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `token ${decrypted.token}`,
            'User-Agent': 'CloudOps-Platform'
          }
        });

        if (response.ok) {
          const user = await response.json();
          db.update('connections', connectionId, {
            status: CONNECTION_STATUSES.CONNECTED,
            metadata: {
              ...conn.metadata,
              username: user.login,
              lastVerifiedAt: new Date().toISOString()
            }
          });
          return {
            success: true,
            provider: 'GITHUB',
            username: user.login,
            scopes: response.headers.get('x-oauth-scopes') || 'repo'
          };
        } else {
          db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
          throw new Error(`GitHub API returned status ${response.status}`);
        }
      } catch (err) {
        db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
        throw err;
      }
    } else if (conn.provider === 'JENKINS') {
      const JenkinsClass = getJenkinsClient();
      const client = new JenkinsClass(decrypted.url, decrypted.username, decrypted.apiToken);
      const status = await client.getStatus();

      if (status.connected) {
        db.update('connections', connectionId, {
          status: CONNECTION_STATUSES.CONNECTED,
          metadata: {
            ...conn.metadata,
            version: status.version,
            lastVerifiedAt: new Date().toISOString()
          }
        });
        return {
          success: true,
          provider: 'JENKINS',
          url: decrypted.url,
          username: decrypted.username,
          version: status.version
        };
      } else {
        db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
        throw new Error(status.error || 'Failed to authenticate with Jenkins server');
      }
    } else if (conn.provider === 'TERRAFORM') {
      const tfStatus = await getTerraformEngine().checkCli();
      if (tfStatus.available) {
        db.update('connections', connectionId, {
          status: CONNECTION_STATUSES.CONNECTED,
          metadata: {
            ...conn.metadata,
            version: tfStatus.version,
            lastVerifiedAt: new Date().toISOString()
          }
        });
        return {
          success: true,
          provider: 'TERRAFORM',
          version: tfStatus.version,
          executablePath: tfStatus.path
        };
      } else {
        db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
        throw new Error('Terraform binary not accessible on host');
      }
    } else if (conn.provider === 'KUBERNETES') {
      const k8sStatus = await getPrereqService().checkPrerequisites();
      if (k8sStatus.allSatisfied || k8sStatus.dockerReady) {
        db.update('connections', connectionId, {
          status: CONNECTION_STATUSES.CONNECTED,
          metadata: {
            ...conn.metadata,
            kindCluster: k8sStatus.clusterName || 'cloudops-cluster',
            lastVerifiedAt: new Date().toISOString()
          }
        });
        return {
          success: true,
          provider: 'KUBERNETES',
          cluster: k8sStatus.clusterName || 'cloudops-cluster',
          ready: true
        };
      } else {
        db.update('connections', connectionId, { status: CONNECTION_STATUSES.ERROR });
        throw new Error('Kubernetes cluster or Docker host not ready');
      }
    }

    throw new Error(`Unsupported provider '${conn.provider}'`);
  }

  /**
   * Retrieves an authenticated AWSClient specifically for an organization
   */
  getAWSClientForOrg(organizationId) {
    if (!organizationId) {
      throw new Error('Provider not connected: Authentication and organization context required.');
    }
    const conn = db.findOne('connections', { organizationId, provider: 'AWS' });
    if (!conn || !conn.secretReference) {
      throw new Error('Provider not connected: Please connect your AWS account in Settings -> Provider Connections to continue.');
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted) {
      throw new Error('Failed to decrypt stored AWS provider credentials');
    }

    const clientConfig = {
      region: decrypted.region || conn.metadata?.region || 'ap-south-1'
    };
    if (decrypted.accessKeyId && decrypted.secretAccessKey) {
      clientConfig.accessKeyId = decrypted.accessKeyId;
      clientConfig.secretAccessKey = decrypted.secretAccessKey;
      if (decrypted.sessionToken) clientConfig.sessionToken = decrypted.sessionToken;
    }

    const AWSClass = getAWSClient();
    return new AWSClass(clientConfig);
  }

  /**
   * Retrieves an authenticated GitHub token specifically for an organization
   */
  getGitHubTokenForOrg(organizationId) {
    if (!organizationId) {
      throw new Error('Provider not connected: Authentication and organization context required.');
    }
    const conn = db.findOne('connections', { organizationId, provider: 'GITHUB' });
    if (!conn || !conn.secretReference) {
      throw new Error('Provider not connected: Please connect your GitHub account in Settings -> Provider Connections to continue.');
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted || !decrypted.token) {
      throw new Error('Failed to decrypt stored GitHub provider token');
    }

    return decrypted.token;
  }

  /**
   * Retrieves an authenticated Jenkins client specifically for an organization
   */
  getJenkinsClientForOrg(organizationId) {
    if (!organizationId) {
      throw new Error('Provider not connected: Authentication and organization context required.');
    }
    const conn = db.findOne('connections', { organizationId, provider: 'JENKINS' });
    if (!conn || !conn.secretReference) {
      throw new Error('Provider not connected: Please connect your Jenkins server in Settings -> Provider Connections to continue.');
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted || !decrypted.url) {
      throw new Error('Failed to decrypt stored Jenkins provider credentials');
    }

    const JenkinsClass = getJenkinsClient();
    return new JenkinsClass(decrypted.url, decrypted.username, decrypted.apiToken);
  }

  /**
   * Retrieves Kubernetes connection configuration specifically for an organization
   */
  getKubernetesConfigForOrg(organizationId) {
    if (!organizationId) {
      throw new Error('Provider not connected: Authentication and organization context required.');
    }
    const conn = db.findOne('connections', { organizationId, provider: 'KUBERNETES' });
    if (!conn || !conn.secretReference) {
      throw new Error('Provider not connected: Please connect your Kubernetes cluster in Settings -> Provider Connections to continue.');
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted) {
      throw new Error('Failed to decrypt stored Kubernetes provider credentials');
    }

    return decrypted;
  }

  /**
   * Performs an AWS preflight permission check for an organization
   */
  async checkAWSPermissions(organizationId) {
    const client = this.getAWSClientForOrg(organizationId);
    try {
      const identity = await client.getCallerIdentity();
      return {
        connected: identity.connected,
        accountId: identity.accountId,
        arn: identity.arn,
        userId: identity.userId,
        region: client.region,
        requiredPermissions: PROVIDER_METADATA.AWS.requiredPermissions,
        verifiedAt: new Date().toISOString()
      };
    } finally {
      client.destroy();
    }
  }
}

module.exports = new ProviderConnectionService();
module.exports.ProviderConnectionService = ProviderConnectionService;
module.exports.CONNECTION_STATUSES = CONNECTION_STATUSES;
module.exports.PROVIDER_METADATA = PROVIDER_METADATA;
