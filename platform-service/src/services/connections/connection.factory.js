const providerConnectionService = require('./provider.connection.service');
const secretVault = require('../security/secret.vault');
const { AWSClient } = require('../aws/aws.client');
const { JenkinsClient } = require('../jenkins/jenkins.client');
const config = require('../../config');

class ConnectionFactory {
  /**
   * Instantiates a tenant-scoped AWSClient using the decrypted credentials of a connection ID
   * @param {string} connectionId 
   * @param {string} organizationId 
   * @returns {AWSClient}
   */
  getAWSClient(connectionId, organizationId) {
    if (!connectionId) {
      // In development fallback, return default AWS client if credentials exist in config
      if (process.env.ALLOW_DEV_ANONYMOUS === 'true' || config.aws.accessKeyId) {
        return new AWSClient();
      }
      throw new Error('AWS connection ID is required for deployment');
    }

    const conn = providerConnectionService.getRawConnection(connectionId, organizationId);
    if (!conn) {
      throw new Error(`AWS connection '${connectionId}' not found for organization '${organizationId}'`);
    }

    if (conn.provider !== 'AWS') {
      throw new Error(`Connection '${connectionId}' is not an AWS provider connection (Found: ${conn.provider})`);
    }

    if (!conn.secretReference) {
      throw new Error(`AWS connection '${connectionId}' has no credentials configured`);
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted) {
      throw new Error(`Failed to decrypt AWS credentials for connection '${connectionId}'`);
    }

    return new AWSClient({
      accessKeyId: decrypted.accessKeyId,
      secretAccessKey: decrypted.secretAccessKey,
      sessionToken: decrypted.sessionToken,
      region: decrypted.region || conn.metadata?.region || 'ap-south-1'
    });
  }

  /**
   * Instantiates a tenant-scoped JenkinsClient using the decrypted credentials of a connection ID
   */
  getJenkinsClient(connectionId, organizationId) {
    if (!connectionId) {
      if (process.env.ALLOW_DEV_ANONYMOUS === 'true' || config.jenkins.url) {
        return new JenkinsClient();
      }
      throw new Error('Jenkins connection ID is required');
    }

    const conn = providerConnectionService.getRawConnection(connectionId, organizationId);
    if (!conn || conn.provider !== 'JENKINS') {
      throw new Error(`Jenkins connection '${connectionId}' not found for organization '${organizationId}'`);
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    if (!decrypted) {
      throw new Error(`Failed to decrypt Jenkins credentials for connection '${connectionId}'`);
    }

    return new JenkinsClient(decrypted.url, decrypted.username, decrypted.apiToken);
  }

  /**
   * Resolves the decrypted GitHub PAT token for a connection ID
   */
  getGitHubToken(connectionId, organizationId) {
    if (!connectionId) {
      if (process.env.ALLOW_DEV_ANONYMOUS === 'true' || config.github.token) {
        return config.github.token || null;
      }
      return null;
    }

    const conn = providerConnectionService.getRawConnection(connectionId, organizationId);
    if (!conn || conn.provider !== 'GITHUB') {
      throw new Error(`GitHub connection '${connectionId}' not found for organization '${organizationId}'`);
    }

    const decrypted = secretVault.decrypt(conn.secretReference, true);
    return decrypted?.token || null;
  }
}

module.exports = new ConnectionFactory();
module.exports.ConnectionFactory = ConnectionFactory;
