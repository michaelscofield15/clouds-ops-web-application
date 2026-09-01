const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = require('../src/app');
const githubAuth = require('../src/services/github/github.auth');
const gitClient = require('../src/services/git/git.client');
const secretScanner = require('../src/services/git/secret.scanner');
const pipelineGenerator = require('../src/services/jenkins/pipeline.generator');
const jenkinsClient = require('../src/services/jenkins/jenkins.client');
const storageService = require('../src/services/storage.service');
const { createValidNodeProjectZip } = require('./fixtures/make-fixtures');

describe('Phase 4 — Real GitHub Automation + Jenkins CI/CD Engine Suite', () => {
  const tmpDir = path.resolve('temporary/test-cicd');
  let server;
  let req;

  before(async () => {
    server = http.createServer(app);
    server.keepAliveTimeout = 0;
    await new Promise((resolve) => server.listen(0, resolve));
    req = request(server);

    fs.mkdirSync(tmpDir, { recursive: true });
    githubAuth.clearToken();
  });

  after(async () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    http.globalAgent.destroy();
  });

  describe('1. GitHub Auth & Account Status', () => {
    it('should report disconnected when no token is active', async () => {
      githubAuth.clearToken();
      const res = await req.get('/api/github/account');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.connected, false);
    });

    it('should reject connection when token is empty or invalid format', async () => {
      const res = await req.post('/api/github/connect').send({ token: '' });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error);
    });

    it('should reject list repositories when disconnected', async () => {
      githubAuth.clearToken();
      const res = await req.get('/api/github/repos');
      assert.strictEqual(res.status, 401);
    });
  });

  describe('2. Pre-Push Secret Scanner Unit Tests', () => {
    const testSecretDir = path.join(tmpDir, 'secret-test');

    before(() => {
      fs.mkdirSync(testSecretDir, { recursive: true });
    });

    it('should pass on clean project without secrets', () => {
      const cleanDir = path.join(testSecretDir, 'clean');
      fs.mkdirSync(cleanDir, { recursive: true });
      fs.writeFileSync(path.join(cleanDir, 'server.js'), 'console.log("hello world");');
      fs.writeFileSync(path.join(cleanDir, '.env.example'), 'PORT=3000\nAPI_KEY=sample_key');

      const result = secretScanner.scanDirectory(cleanDir);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.findingsCount, 0);
    });

    it('should detect AWS access key and flag finding', () => {
      const awsDir = path.join(testSecretDir, 'aws');
      fs.mkdirSync(awsDir, { recursive: true });
      fs.writeFileSync(path.join(awsDir, 'aws-config.js'), 'const key = "AKIAIOSFODNN7EXAMPLE";');

      const result = secretScanner.scanDirectory(awsDir);
      assert.strictEqual(result.passed, false);
      assert.ok(result.findingsCount > 0);
      assert.strictEqual(result.findings[0].rule, 'AWS Access Key');
    });

    it('should detect GitHub Personal Access Token', () => {
      const ghDir = path.join(testSecretDir, 'gh');
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(path.join(ghDir, 'token.js'), 'const t = "ghp_123456789012345678901234567890123456";');

      const result = secretScanner.scanDirectory(ghDir);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.findings[0].rule, 'GitHub Personal Access Token');
    });

    it('should detect Private Key headers', () => {
      const keyDir = path.join(testSecretDir, 'key');
      fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(path.join(keyDir, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----');

      const result = secretScanner.scanDirectory(keyDir);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.findings[0].rule, 'Private Key');
    });
  });

  describe('3. Declarative Jenkinsfile Generator Unit Tests', () => {
    it('should generate declarative Jenkinsfile with all required pipeline stages', () => {
      const analysis = {
        project: { name: 'cloudops-demo-app' },
        packageManager: 'npm',
        port: { value: 3000 }
      };

      const jenkinsfile = pipelineGenerator.generate(analysis);

      assert.ok(jenkinsfile.includes('pipeline {'), 'must be declarative pipeline');
      assert.ok(jenkinsfile.includes("stage('1. Checkout SCM')"), 'must have checkout stage');
      assert.ok(jenkinsfile.includes("stage('2. Install Dependencies')"), 'must have install stage');
      assert.ok(jenkinsfile.includes("stage('3. Run Automated Tests')"), 'must have test stage');
      assert.ok(jenkinsfile.includes("stage('4. Security & Quality Gate')"), 'must have security gate stage');
      assert.ok(jenkinsfile.includes("stage('5. Docker Image Build')"), 'must have docker build stage');
      assert.ok(jenkinsfile.includes("stage('6. Docker Image Verification')"), 'must have docker verification stage');
      assert.ok(jenkinsfile.includes('npm test'), 'must execute npm test');
      assert.ok(jenkinsfile.includes('docker image inspect'), 'must inspect image');
      assert.ok(!jenkinsfile.includes('password'), 'must not contain secrets');
    });

    it('should adapt install and test commands for yarn projects', () => {
      const analysis = {
        project: { name: 'yarn-service' },
        packageManager: 'yarn',
        port: { value: 8080 }
      };

      const jenkinsfile = pipelineGenerator.generate(analysis);
      assert.ok(jenkinsfile.includes('yarn install'), 'must use yarn install');
      assert.ok(jenkinsfile.includes('yarn test'), 'must use yarn test');
    });
  });

  describe('4. Safe Git Engine Unit Tests', () => {
    const gitTestDir = path.join(tmpDir, `git-test-${Date.now()}`);

    before(() => {
      fs.mkdirSync(gitTestDir, { recursive: true });
    });

    it('should safely initialize a local git repo', async () => {
      const initResult = await gitClient.initRepository(gitTestDir);
      assert.strictEqual(initResult.success, true);
      assert.ok(fs.existsSync(path.join(gitTestDir, '.git')));
    });

    it('should configure user identity', async () => {
      await gitClient.configureIdentity(gitTestDir, 'Test Bot', 'test@cloudops.internal');
      const author = await gitClient.getAuthor(gitTestDir);
      assert.ok(author.includes('Test Bot'));
    });

    it('should commit files and return valid commit hash', async () => {
      fs.writeFileSync(path.join(gitTestDir, 'README.md'), '# Test App');
      const commit = await gitClient.commitAll(gitTestDir, 'Initial test commit');
      assert.strictEqual(commit.success, true);
      assert.ok(commit.commitHash);
      assert.strictEqual(commit.commitHash.length, 40);
    });

    it('should create and checkout a feature branch', async () => {
      const branchName = 'cloudops/provision/test-branch';
      const branch = await gitClient.createAndCheckoutBranch(gitTestDir, branchName);
      assert.strictEqual(branch.success, true);
      assert.strictEqual(branch.branch, branchName);

      const current = await gitClient.getCurrentBranch(gitTestDir);
      assert.strictEqual(current, branchName);
    });

    it('should sanitize dangerous branch names to prevent command injection', () => {
      const malicious = 'feature; rm -rf /;';
      const sanitized = gitClient.sanitizeBranchName(malicious);
      assert.ok(!sanitized.includes(';'));
      assert.ok(!sanitized.includes(' '));
    });

    it('should sanitize dangerous repo names', () => {
      const malicious = 'user/repo $(rm -rf /)';
      const sanitized = gitClient.sanitizeRepoName(malicious);
      assert.ok(!sanitized.includes('$'));
      assert.ok(!sanitized.includes('('));
    });
  });

  describe('5. Jenkins Client Unit & Health Tests', () => {
    it('should check connectivity status without throwing', async () => {
      const status = await jenkinsClient.getStatus();
      assert.strictEqual(typeof status.connected, 'boolean');
      assert.ok(status.url);
    });

    it('should sanitize job names correctly', () => {
      const dirty = 'My Project / Test 123!';
      const clean = jenkinsClient.sanitizeJobName(dirty);
      assert.strictEqual(clean, 'cloudops-My-Project---Test-123-');
    });

    it('should return error when connecting to non-existent Jenkins host', async () => {
      const { JenkinsClient } = require('../src/services/jenkins/jenkins.client');
      const offlineClient = new JenkinsClient('http://127.0.0.1:9999');
      const status = await offlineClient.getStatus();
      assert.strictEqual(status.connected, false);
      assert.ok(status.error.includes('Failed to connect to Jenkins'));
    });
  });

  describe('6. Project Push & Secret Blocker Integration Tests', () => {
    it('should block Git push when project contains secrets', async () => {
      // 1. Upload a project
      const zipBuffer = createValidNodeProjectZip();
      const uploadRes = await req
        .post('/api/projects/upload')
        .attach('project', zipBuffer, 'test.zip');

      assert.strictEqual(uploadRes.status, 201);
      const projectId = uploadRes.body.projectId;

      // 2. Inject a secret into the project workspace
      const wsDir = storageService.getWorkspaceDir(projectId);
      fs.writeFileSync(path.join(wsDir, 'credentials.js'), 'const secret = "AKIAIOSFODNN7EXAMPLE";');

      // Set mock token in auth service so auth passes to reach secret scanner
      githubAuth.setToken('mock_test_token_12345');

      // 3. Attempt push
      const pushRes = await req
        .post(`/api/projects/${projectId}/github/push`)
        .send({
          repository: 'test-user/test-repo',
          branch: 'cloudops/provision/test'
        });

      assert.strictEqual(pushRes.status, 400);
      assert.strictEqual(pushRes.body.status, 'blocked');
      assert.strictEqual(pushRes.body.reason, 'Potential secret detected');
      assert.ok(pushRes.body.findingsCount > 0);

      // 4. Check audit log
      const auditRes = await req.get(`/api/projects/${projectId}/audit`);
      assert.strictEqual(auditRes.status, 200);
      const blockedLog = auditRes.body.logs.find(l => l.action === 'PRE_PUSH_SECRET_SCAN');
      assert.ok(blockedLog);
      assert.strictEqual(blockedLog.status, 'BLOCKED');

      githubAuth.clearToken();
    });
  });
});
