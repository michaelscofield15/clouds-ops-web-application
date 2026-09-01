const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('http');
const app = require('../src/app');
const storageService = require('../src/services/storage.service');
const {
  createValidNodeProjectZip,
  createFastifyPnpmZip,
  createDevopsProjectZip,
  createSecretsProjectZip,
  createZipSlipBuffer
} = require('./fixtures/make-fixtures');

describe('Platform Service - ZIP Ingestion & Static Analyzer Suite', () => {
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
    storageService.cleanupAll();
    http.globalAgent.destroy();
  });

  describe('POST /api/projects/upload - File Validation', () => {
    it('should reject request when no file is attached', async () => {
      const res = await req.post('/api/projects/upload').send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'No file uploaded');
    });

    it('should reject non-ZIP files (e.g. .txt file)', async () => {
      const res = await req
        .post('/api/projects/upload')
        .attach('project', Buffer.from('Plain text content'), 'sample.txt');

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Invalid file type');
    });

    it('should reject empty files (0 bytes)', async () => {
      const res = await req
        .post('/api/projects/upload')
        .attach('project', Buffer.alloc(0), 'empty.zip');

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Empty archive');
    });

    it('should reject corrupted / malformed ZIP archives', async () => {
      const corruptedZip = Buffer.from('PK\x03\x04corrupted-content-not-a-valid-zip');
      const res = await req
        .post('/api/projects/upload')
        .attach('project', corruptedZip, 'corrupted.zip');

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Archive extraction failed');
    });

    it('should reject Zip Slip path traversal attempts', async () => {
      const maliciousZip = createZipSlipBuffer();
      const res = await req
        .post('/api/projects/upload')
        .attach('project', maliciousZip, 'malicious.zip');

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Archive extraction failed');
      assert.ok(res.body.message.includes('Zip Slip') || res.body.message.includes('traversal'));
    });
  });

  describe('POST /api/projects/upload - Static Analysis & Technology Detection', () => {
    it('should accept valid Express project, extract safely, and detect runtime & framework', async () => {
      const validZip = createValidNodeProjectZip();
      const res = await req
        .post('/api/projects/upload')
        .attach('project', validZip, 'test-express.zip');

      assert.equal(res.status, 201);
      assert.ok(res.body.projectId, 'must return generated projectId');
      assert.equal(res.body.status, 'uploaded');

      const { analysis } = res.body;

      // Project metadata
      assert.equal(analysis.project.name, 'test-express-service');
      assert.equal(analysis.project.runtime, 'Node.js');
      assert.equal(analysis.project.language, 'JavaScript');

      // Framework
      assert.equal(analysis.framework.name, 'Express');
      assert.equal(analysis.framework.confidence, 'high');

      // Package Manager
      assert.equal(analysis.packageManager, 'npm');

      // Entry Point
      assert.equal(analysis.entryPoint.value, 'src/index.js');
      assert.equal(analysis.entryPoint.confidence, 'high');

      // Port
      assert.equal(analysis.port.value, 8080);

      // Dependencies
      assert.equal(analysis.dependencies.production, 1);
      assert.equal(analysis.dependencies.development, 1);
      assert.ok(analysis.dependencies.productionList.includes('express'));
      assert.ok(analysis.dependencies.developmentList.includes('nodemon'));

      // File count & structure
      assert.ok(analysis.files.total > 0);
      assert.ok(Array.isArray(analysis.files.structure));

      // Generated timestamp
      assert.ok(analysis.analyzedAt);
    });

    it('should detect Fastify framework, pnpm package manager, and custom port', async () => {
      const fastifyZip = createFastifyPnpmZip();
      const res = await req
        .post('/api/projects/upload')
        .attach('project', fastifyZip, 'fastify-app.zip');

      assert.equal(res.status, 201);
      assert.equal(res.body.analysis.framework.name, 'Fastify');
      assert.equal(res.body.analysis.packageManager, 'pnpm');
      assert.equal(res.body.analysis.port.value, 5000);
    });

    it('should detect Docker, Kubernetes, CI/CD, and Terraform configurations', async () => {
      const devopsZip = createDevopsProjectZip();
      const res = await req
        .post('/api/projects/upload')
        .attach('project', devopsZip, 'devops-app.zip');

      assert.equal(res.status, 201);
      const { devops } = res.body.analysis;
      assert.equal(devops.docker.detected, true);
      assert.equal(devops.kubernetes.detected, true);
      assert.equal(devops.cicd.detected, true);
      assert.equal(devops.terraform.detected, true);
    });

    it('should detect secrets statically without exposing secret values', async () => {
      const secretsZip = createSecretsProjectZip();
      const res = await req
        .post('/api/projects/upload')
        .attach('project', secretsZip, 'secrets-app.zip');

      assert.equal(res.status, 201);
      const { analysis } = res.body;
      assert.ok(analysis.security.possibleSecretsDetected, 'must detect secrets');

      // Ensure secret values are NOT in the response
      const jsonString = JSON.stringify(analysis);
      assert.ok(!jsonString.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS secret key must not be exposed');
      assert.ok(!jsonString.includes('xoxb-1234567890'), 'Slack token must not be exposed');

      // Safe metadata must be present
      assert.ok(analysis.security.findings.some((f) => f.type.includes('AWS')));
      assert.equal(analysis.status, 'security_review_required');
    });
  });

  describe('GET /api/projects/:projectId - Analysis Retrieval', () => {
    it('should return stored analysis for a valid project ID', async () => {
      const validZip = createValidNodeProjectZip();
      const uploadRes = await req
        .post('/api/projects/upload')
        .attach('project', validZip, 'lookup-test.zip');
      assert.equal(uploadRes.status, 201);
      const existingProjectId = uploadRes.body.projectId;

      const res = await req.get(`/api/projects/${existingProjectId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.projectId, existingProjectId);
      assert.equal(res.body.project.name, 'test-express-service');
    });

    it('should return 404 for a non-existent project ID', async () => {
      const res = await req.get('/api/projects/non-existent-uuid-12345');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Project not found');
    });
  });
});
