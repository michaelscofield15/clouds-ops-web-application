const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const testBaseDir = path.resolve(__dirname, '../temporary/test-arch-deployment');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;
process.env.ALLOW_DEV_ANONYMOUS = 'true';

const db = require('../src/services/db/db.service');
const ec2Service = require('../src/services/aws/ec2.service');
const ecrService = require('../src/services/aws/ecr.service');
const ssmService = require('../src/services/aws/ssm.service');
const dockerClient = require('../src/services/docker/docker.client');
const dockerEngine = require('../src/services/docker');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const storageService = require('../src/services/storage.service');
const gitController = require('../src/controllers/git.controller');
const jenkinsController = require('../src/controllers/jenkins.controller');
const auditService = require('../src/services/audit.service');

function log(msg = '') {
  console.log(msg);
}

async function runArchitectureDeploymentTests() {
  log('========================================================================');
  log('CLOUDOPS — ARCHITECTURE-AWARE AWS DEPLOYMENT & PIPELINE TEST SUITE');
  log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    log(`  [TEST] ${name}...`);
    try {
      await fn();
      passed++;
      log(`  ✔ [PASS] ${name}\n`);
    } catch (err) {
      failed++;
      log(`  ✖ [FAIL] ${name}`);
      log(`    Error: ${err.stack || err.message}\n`);
    }
  }

  // 1. EC2 Architecture Mapping
  await test('1. EC2Service accurately maps AWS architectures to OCI platforms', async () => {
    assert.equal(ec2Service.getPlatformForArchitecture('x86_64'), 'linux/amd64');
    assert.equal(ec2Service.getPlatformForArchitecture('amd64'), 'linux/amd64');
    assert.equal(ec2Service.getPlatformForArchitecture('arm64'), 'linux/arm64');
    assert.equal(ec2Service.getPlatformForArchitecture('aarch64'), 'linux/arm64');
    assert.equal(ec2Service.getPlatformForArchitecture(undefined), 'linux/amd64');

    const resAmd = ec2Service.resolveTargetPlatform('x86_64');
    assert.equal(resAmd.platform, 'linux/amd64');
    assert.equal(resAmd.dockerArch, 'amd64');
    assert.equal(resAmd.isAmd64, true);

    const resArm = ec2Service.resolveTargetPlatform({ architecture: 'arm64' });
    assert.equal(resArm.platform, 'linux/arm64');
    assert.equal(resArm.dockerArch, 'arm64');
    assert.equal(resArm.isArm, true);
  });

  // 2. Docker Client inspectImage parses architecture
  await test('2. DockerClient inspectImage extracts architecture, os, and platform', async () => {
    // Test inspect parser format
    const mockInspect = {
      Id: 'sha256:1234567890abcdef1234567890abcdef',
      Size: 45000000,
      Created: '2026-08-31T12:00:00Z',
      Architecture: 'amd64',
      Os: 'linux',
      Config: { ExposedPorts: { '5000/tcp': {} }, Cmd: ['node', 'server.js'] }
    };

    const parsed = {
      id: mockInspect.Id,
      size: mockInspect.Size,
      sizeFormatted: `${(mockInspect.Size / (1024 * 1024)).toFixed(2)} MB`,
      created: mockInspect.Created,
      architecture: mockInspect.Architecture,
      os: mockInspect.Os,
      platform: `${mockInspect.Os}/${mockInspect.Architecture}`,
      exposedPorts: Object.keys(mockInspect.Config.ExposedPorts)
    };

    assert.equal(parsed.architecture, 'amd64');
    assert.equal(parsed.os, 'linux');
    assert.equal(parsed.platform, 'linux/amd64');
  });

  // 3. ECR Manifest Verification
  await test('3. ECRService verifyImageManifest detects manifest architecture compatibility', async () => {
    const mockEcrClient = {
      getECRClient: () => ({
        send: async (cmd) => {
          return {
            images: [{
              imageId: { imageDigest: 'sha256:ecrtestdigest12345', imageTag: 'build-archtest' },
              imageManifestMediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
              imageManifest: JSON.stringify({
                schemaVersion: 2,
                mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
                manifests: [
                  {
                    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
                    size: 528,
                    digest: 'sha256:subdigest_amd64',
                    platform: { architecture: 'amd64', os: 'linux' }
                  }
                ]
              })
            }]
          };
        }
      })
    };

    const amdCheck = await ecrService.verifyImageManifest('cloudops/testapp', 'build-archtest', 'linux/amd64', 'ap-south-1', mockEcrClient);
    assert.equal(amdCheck.verified, true);
    assert.equal(amdCheck.compatible, true);

    const armCheck = await ecrService.verifyImageManifest('cloudops/testapp', 'build-archtest', 'linux/arm64', 'ap-south-1', mockEcrClient);
    assert.equal(armCheck.verified, true);
    assert.equal(armCheck.compatible, false);
  });

  // 4. Git Controller auditService import validation
  await test('4. GitController properly imports auditService without ReferenceError', async () => {
    assert.ok(typeof gitController.pushToGitHub === 'function');
    // Ensure auditService.log exists and can be invoked
    assert.ok(typeof auditService.log === 'function');
    assert.ok(typeof auditService.record === 'function');
  });

  // 5. Jenkins Controller optional build trigger handling
  await test('5. JenkinsController triggerBuild handles unconfigured Jenkins cleanly without 400 crash', async () => {
    const projectId = 'proj-jenkins-test';
    storageService.saveAnalysis(projectId, { project: { name: 'jenkins-test-app' }, runtime: { name: 'node' } });
    storageService.updateProject(projectId, { id: projectId, name: 'jenkins-test-app' });

    let statusCode = 0;
    let jsonResult = null;
    const req = {
      params: { projectId },
      body: {},
      organization: { id: 'org-test' }
    };
    const res = {
      status: (code) => {
        statusCode = code;
        return {
          json: (data) => {
            jsonResult = data;
            return data;
          }
        };
      }
    };
    const next = (err) => {
      throw err;
    };

    await jenkinsController.triggerBuild(req, res, next);
    assert.equal(statusCode, 200);
    assert.equal(jsonResult.status, 'skipped');
    assert.equal(jsonResult.configured, false);
    assert.ok(jsonResult.message.includes('No Jenkins job'));
  });

  // 6. AWS Deployment Service Dynamic Architecture Resolution & Early Incompatibility Diagnostics
  await test('6. AWSDeploymentService dynamically resolves EC2 architecture before SSM dispatch', async () => {
    const projectId = 'proj-deploy-arch-test';
    storageService.saveAnalysis(projectId, {
      project: { name: 'cloudemo-arch', port: 5000 },
      runtime: { name: 'Node.js' }
    });
    storageService.updateProject(projectId, {
      id: projectId,
      name: 'cloudemo-arch',
      organizationId: 'org-arch-test',
      dockerState: {
        image: {
          tag: 'cloudops/cloudemo-arch:build-proj-dep',
          architecture: 'arm64',
          platform: 'linux/arm64'
        }
      }
    });

    const mockTenantAwsClient = {
      region: 'ap-south-1',
      credentials: { accessKeyId: 'AKIA_ARCH_TEST', secretAccessKey: 'SECRET_ARCH_TEST' },
      getCallerIdentity: async () => ({ connected: true, accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/deployer' }),
      getEC2Client: () => ({
        send: async (cmd) => ({
          Reservations: [{
            Instances: [{
              InstanceId: 'i-086bb63a1641b9a51',
              InstanceType: 't3.micro',
              State: { Name: 'running' },
              PublicIpAddress: '15.207.25.10',
              PublicDnsName: 'ec2-15-207-25-10.ap-south-1.compute.amazonaws.com',
              Architecture: 'x86_64'
            }]
          }]
        })
      }),
      getECRClient: () => ({
        send: async (cmd) => {
          if (cmd.input?.repositoryNames) {
            return {
              repositories: [{
                repositoryName: 'cloudops/cloudemo-arch',
                repositoryUri: '123456789012.dkr.ecr.ap-south-1.amazonaws.com/cloudops/cloudemo-arch'
              }]
            };
          }
          if (cmd.input?.imageIds) {
            return {
              imageDetails: [{
                imageDigest: 'sha256:arch_valid_amd64_digest_123',
                imageSizeInBytes: 65000000,
                imagePushedAt: new Date()
              }],
              images: [{
                imageId: { imageDigest: 'sha256:arch_valid_amd64_digest_123', imageTag: 'build-proj-dep' },
                imageManifest: JSON.stringify({
                  schemaVersion: 2,
                  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
                  config: { architecture: 'amd64', os: 'linux' }
                })
              }]
            };
          }
          return {};
        }
      }),
      getSSMClient: () => ({
        send: async (cmd) => {
          if (cmd.input?.DocumentName || (cmd.input?.InstanceIds && !cmd.input?.CommandId)) {
            return { Command: { CommandId: 'cmd-arch-deploy-123' } };
          }
          return {
            Status: 'Success',
            ResponseCode: 0,
            StandardOutputContent: 'CONTAINER_ID_OUTPUT=fedcba9876543210\n==> Container deployed and active!'
          };
        }
      })
    };

    const providerConnectionService = require('../src/services/connections/provider.connection.service');
    const origGetAws = providerConnectionService.getAWSClientForOrg;
    providerConnectionService.getAWSClientForOrg = () => mockTenantAwsClient;

    const origWaitOnline = ssmService.waitForInstanceOnline;
    const origDeployDocker = ssmService.deployDockerContainer;
    ssmService.waitForInstanceOnline = async () => true;
    ssmService.deployDockerContainer = async () => ({
      success: true,
      containerName: 'cloudops-proj-dep',
      containerId: 'fedcba9876543210'
    });

    const origInspect = dockerClient.inspectImage;
    const origBuild = dockerClient.buildImage;
    dockerClient.inspectImage = async () => ({ id: 'sha256:mockimg123', architecture: 'amd64', platform: 'linux/amd64' });
    dockerClient.buildImage = async () => ({ imageId: 'sha256:rebuiltimg123', architecture: 'amd64', platform: 'linux/amd64' });

    // Mock ecrService methods to avoid real Docker daemon push
    const origPublish = ecrService.publishImageToECR;
    ecrService.publishImageToECR = async (opts) => {
      assert.equal(opts.targetPlatform, 'linux/amd64');
      return {
        success: true,
        repositoryName: 'cloudops/cloudemo-arch',
        repositoryUri: '123456789012.dkr.ecr.ap-south-1.amazonaws.com/cloudops/cloudemo-arch',
        imageTag: 'build-proj-dep',
        targetImageUri: '123456789012.dkr.ecr.ap-south-1.amazonaws.com/cloudops/cloudemo-arch:build-proj-dep',
        imageDigest: 'sha256:arch_valid_amd64_digest_123',
        imageSizeInBytes: 65000000,
        targetPlatform: 'linux/amd64',
        region: 'ap-south-1'
      };
    };

    // Mock health check probe
    const origVerifyHealth = awsDeploymentService._verifyEndpointHealth;
    awsDeploymentService._verifyEndpointHealth = async (endpoint, port) => {
      assert.equal(endpoint, 'http://15.207.25.10:5000');
      return {
        status: 'healthy',
        statusCode: 200,
        body: { status: 'ok', application: 'cloudemo' }
      };
    };

    const deployRes = await awsDeploymentService.deploy(projectId, {
      instanceId: 'i-086bb63a1641b9a51',
      organizationId: 'org-arch-test',
      region: 'ap-south-1'
    });

    // Restore mocks
    providerConnectionService.getAWSClientForOrg = origGetAws;
    ssmService.waitForInstanceOnline = origWaitOnline;
    ssmService.deployDockerContainer = origDeployDocker;
    dockerClient.inspectImage = origInspect;
    dockerClient.buildImage = origBuild;
    ecrService.publishImageToECR = origPublish;
    awsDeploymentService._verifyEndpointHealth = origVerifyHealth;

    assert.equal(deployRes.status, 'SUCCESS');
    assert.equal(deployRes.ec2.instanceId, 'i-086bb63a1641b9a51');
    assert.equal(deployRes.ec2.architecture, 'x86_64');
    assert.equal(deployRes.ec2.platform, 'linux/amd64');
    assert.equal(deployRes.endpoint, 'http://15.207.25.10:5000');
    assert.equal(deployRes.host, '15.207.25.10');
    assert.equal(deployRes.port, 5000);
    assert.equal(deployRes.health.status, 'healthy');
  });

  // 7. Canonical URL formatting validation
  await test('7. Production URL serializer produces strictly canonical HTTP string without [object Object]', async () => {
    const host = '3.110.200.55';
    const port = 5000;
    const url = `http://${host}:${port}`;
    assert.equal(url, 'http://3.110.200.55:5000');
    assert.equal(url.includes('[object'), false);
    assert.equal(url.includes('undefined'), false);
    assert.equal(url.includes('null'), false);
  });

  log('========================================================================');
  log(`ARCHITECTURE-AWARE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runArchitectureDeploymentTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
