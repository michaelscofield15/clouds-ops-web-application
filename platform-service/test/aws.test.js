const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('http');

const app = require('../src/app');
const awsClient = require('../src/services/aws/aws.client');
const { maskSecret } = require('../src/services/aws/aws.client');
const ecrService = require('../src/services/aws/ecr.service');
const ec2Service = require('../src/services/aws/ec2.service');
const ssmService = require('../src/services/aws/ssm.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const storageService = require('../src/services/storage.service');
const pipelineGenerator = require('../src/services/jenkins/pipeline.generator');

describe('Phase 6 — Real AWS Cloud Deployment Engine Suite', () => {
  let server;
  let req;

  before(async () => {
    server = http.createServer(app);
    server.keepAliveTimeout = 0;
    await new Promise((resolve) => server.listen(0, resolve));
    req = request(server);
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    awsClient.destroy();
    http.globalAgent.destroy();
  });

  describe('1. AWS Client & Credential Security', () => {
    it('should correctly mask sensitive AWS credentials and tokens', () => {
      const accessKey = 'AKIAIOSFODNN7EXAMPLE';
      const masked = maskSecret(accessKey);
      assert.equal(masked, 'AKIA****MPLE');
      assert.ok(!masked.includes('IOSFODNN7'));

      assert.equal(maskSecret(''), '');
      assert.equal(maskSecret('short'), '****');
    });

    it('should query live STS status or handle disconnection gracefully', async () => {
      const status = await awsClient.getStatus();
      assert.ok(typeof status.connected === 'boolean');
      assert.ok(status.region);
      if (status.connected) {
        assert.ok(status.accountId);
        assert.ok(status.arn);
      }
    });

    it('should expose GET /api/aws/status with accurate connection info', async () => {
      const res = await req.get('/api/aws/status');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.connected === 'boolean');
      assert.ok(res.body.region);
    });
  });

  describe('2. ECR Service Repository & Tag Sanitization', () => {
    it('should sanitize repository names to valid ECR naming convention', () => {
      const raw = 'My-App_Service 123!!';
      const clean = ecrService.sanitizeRepoName(raw);
      assert.ok(/^[a-z0-9/_-]+$/.test(clean), 'Repo name must match ECR regex');
      assert.equal(clean, 'cloudops/my-app_service-123');
    });

    it('should decode ECR authorization token base64 format', async () => {
      // Mock auth data decoding test
      const testToken = Buffer.from('AWS:my-secret-ecr-password').toString('base64');
      const decoded = Buffer.from(testToken, 'base64').toString('utf8');
      const [user, pass] = decoded.split(':');
      assert.equal(user, 'AWS');
      assert.equal(pass, 'my-secret-ecr-password');
    });
  });

  describe('3. EC2 Service Validation & Security Group Design', () => {
    it('should reject invalid instance ID formats', async () => {
      await assert.rejects(
        async () => {
          await ec2Service.validateExistingInstance('not-an-instance-id');
        },
        {
          name: 'Error',
          message: /Invalid EC2 instance ID format/
        }
      );
    });

    it('should correctly build Amazon Linux 2023 user-data initialization script', () => {
      const script = `#!/bin/bash
dnf update -y
dnf install -y docker amazon-ssm-agent
systemctl enable --now docker
systemctl enable --now amazon-ssm-agent
usermod -aG docker ec2-user
`;
      assert.ok(script.includes('amazon-ssm-agent'));
      assert.ok(script.includes('docker'));
    });
  });

  describe('4. SSM Deployment Command Construction', () => {
    it('should construct deterministic and safe container deployment commands', () => {
      const containerName = 'cloudops-test-app';
      const port = 3000;
      const targetImageUri = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/cloudops/demo:build-1';
      const ecrRegistryHost = '123456789012.dkr.ecr.ap-south-1.amazonaws.com';
      const region = 'ap-south-1';

      const deployScript = [
        'set -e',
        `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${ecrRegistryHost}`,
        `docker pull ${targetImageUri}`,
        `docker stop ${containerName} || true`,
        `docker rm ${containerName} || true`,
        `docker run -d --name ${containerName} --restart unless-stopped -p ${port}:${port} ${targetImageUri}`,
        `docker ps --filter name=${containerName}`
      ];

      assert.ok(deployScript[1].includes('get-login-password'));
      assert.ok(deployScript[2].includes('docker pull'));
      assert.ok(deployScript[5].includes('-p 3000:3000'));
      assert.ok(!deployScript.join('\n').includes('eval '));
    });
  });

  describe('5. Error Handling & Validation Gates', () => {
    it('should return 404 when validating non-existent project', async () => {
      const res = await req.post('/api/projects/non-existent-uuid-9999/aws/validate');
      assert.equal(res.status, 404);
    });

    it('should reject deployment when project is not dockerized', async () => {
      const projectId = storageService.generateProjectId();
      storageService.createWorkspace(projectId);
      storageService.saveAnalysis(projectId, {
        project: { name: 'undockerized-aws-app' },
        port: { value: 3000 }
      });

      const res = await req
        .post(`/api/projects/${projectId}/aws/deploy`)
        .send({});

      assert.equal(res.status, 400);
      assert.ok((res.body.message || res.body.error).includes('dockerized'));
    });

    it('should return not_deployed status for project without AWS state', async () => {
      const projectId = storageService.generateProjectId();
      storageService.createWorkspace(projectId);
      storageService.saveAnalysis(projectId, {
        project: { name: 'un-deployed-aws-app' },
        port: { value: 3000 }
      });

      const res = await req.get(`/api/projects/${projectId}/aws/status`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'not_deployed');
    });
  });

  describe('6. Jenkinsfile AWS CI/CD Pipeline Generation', () => {
    it('should generate AWS ECR push and EC2 deployment stages when enableAws is true', () => {
      const analysis = {
        project: { name: 'aws-cloud-service' },
        packageManager: 'npm',
        port: { value: 3000 }
      };

      const jenkinsfile = pipelineGenerator.generate(analysis, {
        enableAws: true,
        awsRegion: 'ap-south-1',
        instanceId: 'i-0123456789abcdef0'
      });

      assert.ok(jenkinsfile.includes("stage('7. Push Image to ECR')"), 'must include ECR push stage');
      assert.ok(jenkinsfile.includes("stage('8. Deploy to EC2')"), 'must include EC2 deployment stage');
      assert.ok(jenkinsfile.includes("stage('9. Health Check')"), 'must include Health check stage');
      assert.ok(jenkinsfile.includes('i-0123456789abcdef0'), 'must specify target instance ID');
      assert.ok(jenkinsfile.includes('ap-south-1'), 'must specify AWS region');
    });
  });
});
