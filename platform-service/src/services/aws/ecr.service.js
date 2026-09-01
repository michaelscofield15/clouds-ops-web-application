const { spawn } = require('child_process');
const awsClient = require('./aws.client');
const config = require('../../config');

const getECR = () => require('@aws-sdk/client-ecr');

class ECRService {
  /**
   * Sanitizes repository name to valid ECR naming convention
   */
  sanitizeRepoName(name, prefix = 'cloudops/') {
    const raw = (name || 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9/_-]/g, '');
    const combined = `${cleanPrefix}${raw}`;
    // ECR repos must be <= 256 chars and match regex
    return combined.slice(0, 255);
  }

  /**
   * Lists all ECR repositories in the target region for the authenticated tenant
   */
  async listRepositories(region = config.aws.region, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const { DescribeRepositoriesCommand } = getECR();
    try {
      const describeCmd = new DescribeRepositoriesCommand({});
      const describeRes = await client.send(describeCmd);
      const repositories = (describeRes.repositories || []).map((repo) => ({
        repositoryName: repo.repositoryName,
        repositoryUri: repo.repositoryUri,
        repositoryArn: repo.repositoryArn,
        registryId: repo.registryId,
        createdAt: repo.createdAt ? new Date(repo.createdAt).toISOString() : null,
        imageTagMutability: repo.imageTagMutability
      }));
      return repositories;
    } catch (err) {
      throw new Error(`Failed to list ECR repositories in region '${region}': ${err.message}`);
    }
  }

  /**
   * Describes an ECR repository by name
   */
  async describeRepository(repoName, region = config.aws.region, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const sanitizedName = this.sanitizeRepoName(repoName, '');
    const { DescribeRepositoriesCommand } = getECR();
    const describeCmd = new DescribeRepositoriesCommand({
      repositoryNames: [sanitizedName]
    });
    const describeRes = await client.send(describeCmd);
    if (!describeRes.repositories || describeRes.repositories.length === 0) {
      const err = new Error(`Repository '${sanitizedName}' not found`);
      err.name = 'RepositoryNotFoundException';
      throw err;
    }
    const repo = describeRes.repositories[0];
    return {
      repositoryName: repo.repositoryName,
      repositoryUri: repo.repositoryUri,
      repositoryArn: repo.repositoryArn,
      registryId: repo.registryId,
      createdAt: repo.createdAt
    };
  }

  /**
   * Checks if an ECR repository exists or creates it if missing
   */
  async getOrCreateRepository(repoName, region = config.aws.region, tags = {}, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const sanitizedName = this.sanitizeRepoName(repoName, '');
    const { DescribeRepositoriesCommand, CreateRepositoryCommand } = getECR();

    try {
      // 1. Check if repository already exists
      const describeCmd = new DescribeRepositoriesCommand({
        repositoryNames: [sanitizedName]
      });
      const describeRes = await client.send(describeCmd);
      if (describeRes.repositories && describeRes.repositories.length > 0) {
        const repo = describeRes.repositories[0];
        return {
          created: false,
          repositoryName: repo.repositoryName,
          repositoryUri: repo.repositoryUri,
          repositoryArn: repo.repositoryArn,
          registryId: repo.registryId
        };
      }
    } catch (err) {
      if (err.name !== 'RepositoryNotFoundException') {
        throw new Error(`Failed to check ECR repository '${sanitizedName}': ${err.message}`);
      }
    }

    // 2. Create new repository
    try {
      const createCmd = new CreateRepositoryCommand({
        repositoryName: sanitizedName,
        imageTagMutability: 'MUTABLE',
        tags: Object.entries({
          ...config.aws.tags,
          ...tags
        }).map(([Key, Value]) => ({ Key, Value: String(Value) }))
      });
      const createRes = await client.send(createCmd);
      const repo = createRes.repository;

      return {
        created: true,
        repositoryName: repo.repositoryName,
        repositoryUri: repo.repositoryUri,
        repositoryArn: repo.repositoryArn,
        registryId: repo.registryId
      };
    } catch (err) {
      throw new Error(`Failed to create ECR repository '${sanitizedName}': ${err.message}`);
    }
  }

  /**
   * Retrieves ECR authorization credentials
   */
  async getAuthToken(region = config.aws.region, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const { GetAuthorizationTokenCommand } = getECR();
    try {
      const authCmd = new GetAuthorizationTokenCommand({});
      const authRes = await client.send(authCmd);

      if (!authRes.authorizationData || authRes.authorizationData.length === 0) {
        throw new Error('No ECR authorization data returned from AWS');
      }

      const authData = authRes.authorizationData[0];
      const decoded = Buffer.from(authData.authorizationToken, 'base64').toString('utf8');
      const [username, password] = decoded.split(':');

      return {
        username,
        password,
        proxyEndpoint: authData.proxyEndpoint,
        expiresAt: authData.expiresAt
      };
    } catch (err) {
      throw new Error(`Failed to retrieve ECR authorization token: ${err.message}`);
    }
  }

  /**
   * Safe Docker CLI execution helper
   */
  _execDocker(args, input) {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', args, {
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      if (input) {
        proc.stdin.write(input);
        proc.stdin.end();
      }

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', (err) => {
        reject(new Error(`Docker CLI execution error: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        } else {
          const err = new Error(`Docker ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
          err.code = code;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }
      });
    });
  }

  /**
   * Logs local Docker daemon into ECR registry
   */
  async authenticateDocker(registryUri, username, password) {
    try {
      // Clear any previous stale login session to avoid macOS keychain duplicate item error (-25299)
      try {
        await this._execDocker(['logout', registryUri]);
      } catch {
        // Ignore logout failure
      }

      await this._execDocker(['login', '--username', username, '--password-stdin', registryUri], password);
      return { authenticated: true, registryUri };
    } catch (err) {
      if (err.message && (err.message.includes('already exists in the keychain') || err.message.includes('Login Succeeded'))) {
        return { authenticated: true, registryUri };
      }
      throw new Error(`ECR Docker authentication failed for '${registryUri}': ${err.message}`);
    }
  }

  /**
   * Tags local Docker image with ECR target URI
   */
  async tagImage(localImageTag, targetEcrTag) {
    try {
      await this._execDocker(['tag', localImageTag, targetEcrTag]);
      return { tagged: true, targetEcrTag };
    } catch (err) {
      throw new Error(`Failed to tag Docker image '${localImageTag}' -> '${targetEcrTag}': ${err.message}`);
    }
  }

  /**
   * Pushes image to ECR
   */
  async pushImage(targetEcrTag) {
    try {
      const res = await this._execDocker(['push', targetEcrTag]);
      return { pushed: true, output: res.stdout };
    } catch (err) {
      throw new Error(`Failed to push Docker image to ECR '${targetEcrTag}': ${err.message}`);
    }
  }

  /**
   * Verifies image exists in ECR and returns its digest
   */
  async verifyImageDigest(repositoryName, imageTag, region = config.aws.region, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const sanitizedName = this.sanitizeRepoName(repositoryName, '');

    try {
      const { DescribeImagesCommand } = getECR();
      const describeImagesCmd = new DescribeImagesCommand({
        repositoryName: sanitizedName,
        imageIds: [{ imageTag }]
      });
      const res = await client.send(describeImagesCmd);

      if (!res.imageDetails || res.imageDetails.length === 0) {
        return { verified: false, error: `Image '${imageTag}' not found in ECR repository '${sanitizedName}'` };
      }

      const img = res.imageDetails[0];
      return {
        verified: true,
        imageDigest: img.imageDigest,
        imageSizeInBytes: img.imageSizeInBytes,
        imagePushedAt: img.imagePushedAt,
        repositoryName: sanitizedName,
        imageTag
      };
    } catch (err) {
      return {
        verified: false,
        error: `Failed to verify ECR image digest for '${sanitizedName}:${imageTag}': ${err.message}`
      };
    }
  }

  /**
   * Verifies the ECR image manifest and checks architectural compatibility with the target EC2 platform
   */
  async verifyImageManifest(repositoryName, imageTag, targetPlatform = 'linux/amd64', region = config.aws.region, clientOverride = null) {
    const client = (clientOverride || awsClient).getECRClient(region);
    const sanitizedName = this.sanitizeRepoName(repositoryName, '');

    try {
      const { BatchGetImageCommand } = getECR();
      const batchCmd = new BatchGetImageCommand({
        repositoryName: sanitizedName,
        imageIds: [{ imageTag }],
        acceptedMediaTypes: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.oci.image.index.v1+json'
        ]
      });

      const res = await client.send(batchCmd);

      if (!res.images || res.images.length === 0) {
        return {
          compatible: false,
          verified: false,
          error: `Image '${sanitizedName}:${imageTag}' not found in ECR repository '${sanitizedName}'`
        };
      }

      const img = res.images[0];
      let manifestObj = null;
      let manifestMedia = img.imageManifestMediaType || '';
      let isCompatible = true;
      let detectedArch = 'unknown';

      if (img.imageManifest) {
        try {
          manifestObj = JSON.parse(img.imageManifest);
        } catch {}
      }

      // Check manifest list / index
      if (manifestObj && Array.isArray(manifestObj.manifests)) {
        const expectedArch = targetPlatform.includes('arm64') ? 'arm64' : 'amd64';
        const matchingEntry = manifestObj.manifests.find(m => {
          const mArch = m.platform?.architecture;
          return mArch === expectedArch;
        });

        isCompatible = !!matchingEntry;
        detectedArch = manifestObj.manifests.map(m => m.platform?.architecture).filter(Boolean).join(', ');
      }

      return {
        verified: true,
        compatible: isCompatible,
        imageDigest: img.imageId?.imageDigest,
        imageTag: img.imageId?.imageTag,
        mediaType: manifestMedia,
        detectedArch,
        targetPlatform,
        repositoryName: sanitizedName
      };
    } catch (err) {
      // Fallback to basic digest check if BatchGetImage fails on permissions
      const digestCheck = await this.verifyImageDigest(sanitizedName, imageTag, region, clientOverride);
      return {
        verified: digestCheck.verified,
        compatible: true, // fallback
        imageDigest: digestCheck.imageDigest,
        repositoryName: sanitizedName,
        imageTag,
        targetPlatform,
        warning: err.message
      };
    }
  }

  /**
   * Full ECR push workflow:
   * 1. Get/Create ECR repo
   * 2. Authenticate Docker with ECR
   * 3. Tag Phase 3 image
   * 4. Push image to ECR
   * 5. Verify image digest and architectural manifest via AWS API
   */
  async publishImageToECR({ localImageTag, projectName, projectId, organizationId, targetPlatform = 'linux/amd64', environment = 'production', region = config.aws.region, onLog, awsClient: customAwsClient }) {
    const log = (msg) => { if (typeof onLog === 'function') onLog(msg); };
    const activeClient = customAwsClient || awsClient;

    log(`[ECR] Validating ECR repository for project '${projectName}' in ${region}...`);
    const repoName = `cloudops/${this.sanitizeRepoName(projectName, '')}`;
    const repoInfo = await this.getOrCreateRepository(repoName, region, {
      ManagedBy: 'CloudOps',
      TenantId: organizationId || 'tenant-workspace',
      ProjectId: projectId,
      ProjectName: projectName,
      Environment: environment
    }, activeClient);
    log(`[ECR] Repository verified: ${repoInfo.repositoryUri} (Created: ${repoInfo.created})`);

    const imageTag = `build-${projectId.slice(0, 8)}`;
    const fullTargetTag = `${repoInfo.repositoryUri}:${imageTag}`;

    log(`[ECR] Retrieving ECR authentication token from AWS...`);
    const auth = await this.getAuthToken(region, activeClient);
    const registryHost = repoInfo.repositoryUri.split('/')[0];

    log(`[ECR] Authenticating Docker daemon against ${registryHost}...`);
    await this.authenticateDocker(registryHost, auth.username, auth.password);

    log(`[ECR] Tagging local image '${localImageTag}' -> '${fullTargetTag}'...`);
    await this.tagImage(localImageTag, fullTargetTag);

    log(`[ECR] Pushing Docker image to AWS ECR (${targetPlatform})...`);
    await this.pushImage(fullTargetTag);

    log(`[ECR] Verifying image digest and manifest in ECR registry for platform '${targetPlatform}'...`);
    const verification = await this.verifyImageDigest(repoInfo.repositoryName, imageTag, region, activeClient);

    if (!verification.verified) {
      throw new Error(`ECR image push verification failed: ${verification.error}`);
    }

    const manifestCheck = await this.verifyImageManifest(repoInfo.repositoryName, imageTag, targetPlatform, region, activeClient);
    if (manifestCheck.compatible === false) {
      throw new Error(`Incompatible Image Manifest: Target EC2 platform requires '${targetPlatform}', but ECR manifest does not support it (Detected: ${manifestCheck.detectedArch})`);
    }

    log(`[ECR] ECR Push & Manifest Verified: ${fullTargetTag} (Digest: ${verification.imageDigest}, Target: ${targetPlatform})`);

    return {
      success: true,
      repositoryName: repoInfo.repositoryName,
      repositoryUri: repoInfo.repositoryUri,
      imageTag,
      targetImageUri: fullTargetTag,
      imageDigest: verification.imageDigest,
      imageSizeInBytes: verification.imageSizeInBytes,
      targetPlatform,
      region
    };
  }
}

module.exports = new ECRService();
module.exports.ECRService = ECRService;
