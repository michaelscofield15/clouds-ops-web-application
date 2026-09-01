const config = require('../../config');

/**
 * Masks sensitive credential strings for safe logging and output
 */
function maskSecret(str) {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= 8) return '****';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

class AWSClient {
  constructor(customConfig = {}) {
    this.region = customConfig.region || config.aws.region || 'ap-south-1';
    this.credentials = this._resolveCredentials(customConfig);
    this._clients = new Map();
  }

  _resolveCredentials(options = {}) {
    const accessKeyId = options.accessKeyId || (options.allowEnvironmentFallback ? (config.aws.accessKeyId || process.env.AWS_ACCESS_KEY_ID) : null);
    const secretAccessKey = options.secretAccessKey || (options.allowEnvironmentFallback ? (config.aws.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY) : null);
    const sessionToken = options.sessionToken || (options.allowEnvironmentFallback ? (config.aws.sessionToken || process.env.AWS_SESSION_TOKEN) : null);

    if (accessKeyId && secretAccessKey) {
      return {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {})
      };
    }
    // Return undefined when no tenant credentials are configured
    return undefined;
  }

  getClientConfig(regionOverride) {
    const region = regionOverride || this.region;
    const { NodeHttpHandler } = require('@smithy/node-http-handler');
    const clientConfig = {
      region,
      maxAttempts: 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 10000,
        requestTimeout: 30000
      })
    };
    if (this.credentials) {
      clientConfig.credentials = this.credentials;
    }
    return clientConfig;
  }

  getSTSClient(region) {
    const key = `sts:${region || this.region}`;
    if (!this._clients.has(key)) {
      const { STSClient } = require('@aws-sdk/client-sts');
      this._clients.set(key, new STSClient(this.getClientConfig(region)));
    }
    return this._clients.get(key);
  }

  getECRClient(region) {
    const key = `ecr:${region || this.region}`;
    if (!this._clients.has(key)) {
      const { ECRClient } = require('@aws-sdk/client-ecr');
      this._clients.set(key, new ECRClient(this.getClientConfig(region)));
    }
    return this._clients.get(key);
  }

  getEC2Client(region) {
    const key = `ec2:${region || this.region}`;
    if (!this._clients.has(key)) {
      const { EC2Client } = require('@aws-sdk/client-ec2');
      this._clients.set(key, new EC2Client(this.getClientConfig(region)));
    }
    return this._clients.get(key);
  }

  getSSMClient(region) {
    const key = `ssm:${region || this.region}`;
    if (!this._clients.has(key)) {
      const { SSMClient } = require('@aws-sdk/client-ssm');
      this._clients.set(key, new SSMClient(this.getClientConfig(region)));
    }
    return this._clients.get(key);
  }

  getIAMClient(region) {
    const key = `iam:${region || 'us-east-1'}`; // IAM endpoint is global / us-east-1
    if (!this._clients.has(key)) {
      const { IAMClient } = require('@aws-sdk/client-iam');
      this._clients.set(key, new IAMClient(this.getClientConfig('us-east-1')));
    }
    return this._clients.get(key);
  }

  getCloudWatchClient(region) {
    const key = `cloudwatch:${region || this.region}`;
    if (!this._clients.has(key)) {
      const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
      this._clients.set(key, new CloudWatchClient(this.getClientConfig(region)));
    }
    return this._clients.get(key);
  }

  /**
   * Retrieves AWS Caller Identity via STS GetCallerIdentity
   */
  async getCallerIdentity(regionOverride) {
    const targetRegion = regionOverride || this.region;
    if (!this.credentials || !this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      return {
        connected: false,
        error: 'No AWS credentials configured',
        code: 'CredentialsMissing',
        region: targetRegion
      };
    }

    const sts = this.getSTSClient(targetRegion);
    const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    if (timer && typeof timer.unref === 'function') timer.unref();

    try {
      const command = new GetCallerIdentityCommand({});
      const response = await sts.send(command, { abortSignal: controller.signal });
      clearTimeout(timer);

      return {
        connected: true,
        accountId: response.Account,
        arn: response.Arn,
        userId: response.UserId,
        region: targetRegion
      };
    } catch (err) {
      clearTimeout(timer);
      return {
        connected: false,
        error: err.name === 'AbortError' ? 'AWS STS request timed out' : (err.message || 'Failed to authenticate with AWS STS'),
        code: err.name || 'AuthenticationError',
        region: targetRegion
      };
    }
  }

  /**
   * Full status check for GET /api/aws/status with 10s caching
   */
  async getStatus() {
    if (this._cachedStatus && (Date.now() - (this._cachedStatusTime || 0) < 10000)) {
      return this._cachedStatus;
    }
    const identity = await this.getCallerIdentity();
    this._cachedStatus = {
      connected: identity.connected,
      accountId: identity.accountId || null,
      arn: identity.arn || null,
      region: identity.region,
      error: identity.error || null
    };
    this._cachedStatusTime = Date.now();
    return this._cachedStatus;
  }

  /**
   * Destroys all pooled AWS SDK client instances to cleanly release sockets
   */
  destroy() {
    for (const client of this._clients.values()) {
      if (typeof client.destroy === 'function') {
        try {
          client.destroy();
        } catch {
          // Ignore
        }
      }
    }
    this._clients.clear();
  }
}

module.exports = new AWSClient({ allowEnvironmentFallback: true });
module.exports.AWSClient = AWSClient;
module.exports.maskSecret = maskSecret;
