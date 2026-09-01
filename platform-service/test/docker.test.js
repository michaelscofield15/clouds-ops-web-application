const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('http');

const app = require('../src/app');
const storageService = require('../src/services/storage.service');
const dockerClient = require('../src/services/docker/docker.client');
const dockerfileGenerator = require('../src/services/docker/dockerfile.generator');
const {
  createValidNodeProjectZip,
  createExistingDockerfileProjectZip,
  createBrokenDockerfileProjectZip
} = require('./fixtures/make-fixtures');

describe('Phase 3 — Automatic Dockerization Engine Suite', () => {
  let isDockerAvailable = false;
  let server;
  let req;
  const trackedContainers = [];
  const trackedImages = [];

  before(async () => {
    server = http.createServer(app);
    server.keepAliveTimeout = 0;
    await new Promise((resolve) => server.listen(0, resolve));
    req = request(server);

    const availability = await dockerClient.checkDockerAvailability();
    isDockerAvailable = availability.available;
  });

  after(async () => {
    // Clean up any test containers
    for (const cId of trackedContainers) {
      await dockerClient.stopAndRemoveContainer(cId);
    }
    // Clean up any test images
    for (const tag of trackedImages) {
      await dockerClient.removeImage(tag);
    }
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    storageService.cleanupAll();
    http.globalAgent.destroy();
  });

  describe('1. Docker Availability Precheck', () => {
    it('should correctly report Docker daemon availability status', async () => {
      const availability = await dockerClient.checkDockerAvailability();
      assert.equal(typeof availability.available, 'boolean');
      if (availability.available) {
        assert.ok(availability.version, 'should include Docker version');
      } else {
        assert.ok(availability.error, 'should include error explanation');
      }
    });
  });

  describe('2. Dockerfile Generation Unit Tests', () => {
    it('should generate valid production Dockerfile with detected port and entry point', () => {
      const analysis = {
        packageManager: 'npm',
        port: { value: 8080 },
        entryPoint: { value: 'src/main.js' }
      };

      const dockerfile = dockerfileGenerator.generate(analysis);

      assert.ok(dockerfile.includes('FROM node:20-alpine'), 'must use node LTS alpine');
      assert.ok(dockerfile.includes('ENV PORT=8080'), 'must set port env');
      assert.ok(dockerfile.includes('npm ci --omit=dev') || dockerfile.includes('npm install --omit=dev'), 'must install production deps');
      assert.ok(dockerfile.includes('EXPOSE 8080'), 'must expose detected port');
      assert.ok(dockerfile.includes('CMD ["node", "src/main.js"]'), 'must run detected entrypoint');
    });

    it('should fall back to default entrypoint and port when none are detected', () => {
      const analysis = {
        packageManager: 'npm',
        port: { value: 'unknown' },
        entryPoint: { value: null }
      };

      const dockerfile = dockerfileGenerator.generate(analysis);
      assert.ok(dockerfile.includes('ENV PORT=3000'), 'must fallback to port 3000');
      assert.ok(dockerfile.includes('EXPOSE 3000'), 'must expose default port 3000');
      assert.ok(dockerfile.includes('CMD ["node", "index.js"]'), 'must fallback to index.js');
    });

    it('should support yarn and pnpm package managers in generated Dockerfile', () => {
      const yarnAnalysis = { packageManager: 'yarn', port: { value: 3000 } };
      const yarnDockerfile = dockerfileGenerator.generate(yarnAnalysis);
      assert.ok(yarnDockerfile.includes('yarn.lock'), 'must copy yarn.lock');
      assert.ok(yarnDockerfile.includes('yarn install --production'), 'must use yarn install');

      const pnpmAnalysis = { packageManager: 'pnpm', port: { value: 3000 } };
      const pnpmDockerfile = dockerfileGenerator.generate(pnpmAnalysis);
      assert.ok(pnpmDockerfile.includes('pnpm-lock.yaml'), 'must copy pnpm-lock.yaml');
      assert.ok(pnpmDockerfile.includes('pnpm install --prod'), 'must use pnpm install');
    });
  });

  describe('3. Dockerfile Inspection & Strategy Resolution', () => {
    it('should recognize missing Dockerfile and select generate strategy', () => {
      const workspace = storageService.createWorkspace();
      const info = dockerfileGenerator.prepareDockerfile(workspace.extractDir, {
        packageManager: 'npm',
        port: { value: 3000 }
      });

      assert.equal(info.source, 'generated');
      assert.ok(info.dockerfilePath, 'must write generated Dockerfile');
      storageService.deleteWorkspace(workspace.projectId);
    });
  });

  describe('4. Real Dockerization Integration Tests (Requires Docker)', () => {
    it('Scenario A: No Dockerfile — should generate, build real image, run container, and pass health check', async (t) => {
      if (!isDockerAvailable) {
        t.skip('Docker is not available on host');
        return;
      }

      // Step 1: Upload project
      const zipBuffer = createValidNodeProjectZip();
      const uploadRes = await req
        .post('/api/projects/upload')
        .attach('project', zipBuffer, 'express-demo.zip');

      assert.equal(uploadRes.status, 201);
      const { projectId } = uploadRes.body;

      // Step 2: Trigger Dockerize
      const dockerizeRes = await req
        .post(`/api/projects/${projectId}/dockerize`);

      assert.equal(dockerizeRes.status, 200);
      assert.equal(dockerizeRes.body.status, 'success');
      assert.equal(dockerizeRes.body.dockerfile.source, 'generated');

      // Validate Image
      assert.ok(dockerizeRes.body.image.id, 'must return real image ID');
      assert.ok(dockerizeRes.body.image.tag, 'must return real image tag');
      trackedImages.push(dockerizeRes.body.image.tag);

      // Validate Container
      assert.ok(dockerizeRes.body.container.id, 'must return real container ID');
      assert.equal(dockerizeRes.body.container.status, 'running');
      trackedContainers.push(dockerizeRes.body.container.id);

      // Validate Port Mapping
      assert.equal(dockerizeRes.body.portMapping.internalPort, 8080);
      assert.ok(dockerizeRes.body.portMapping.hostPort > 0, 'must allocate real host port');

      // Validate Health
      assert.equal(dockerizeRes.body.health.status, 'healthy');

      // Step 3: Verify Status API
      const statusRes = await req.get(`/api/projects/${projectId}/docker`);
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.status, 'success');
      assert.equal(statusRes.body.container.status, 'running');

      // Step 4: Verify Logs API
      const logsRes = await req.get(`/api/projects/${projectId}/docker/logs`);
      assert.equal(logsRes.status, 200);
      assert.ok(logsRes.body.logs !== undefined, 'must retrieve container logs');

      // Step 5: Stop Container
      const stopRes = await req.delete(`/api/projects/${projectId}/docker`);
      assert.equal(stopRes.status, 200);
    });

    it('Scenario B: Existing valid Dockerfile — should reuse existing Dockerfile without overwriting', async (t) => {
      if (!isDockerAvailable) {
        t.skip('Docker is not available on host');
        return;
      }

      // Step 1: Upload project with custom Dockerfile
      const zipBuffer = createExistingDockerfileProjectZip();
      const uploadRes = await req
        .post('/api/projects/upload')
        .attach('project', zipBuffer, 'existing-dockerfile-demo.zip');

      assert.equal(uploadRes.status, 201);
      const { projectId } = uploadRes.body;

      // Step 2: Trigger Dockerize
      const dockerizeRes = await req
        .post(`/api/projects/${projectId}/dockerize`);

      assert.equal(dockerizeRes.status, 200);
      assert.equal(dockerizeRes.body.status, 'success');
      assert.equal(dockerizeRes.body.dockerfile.source, 'existing');

      trackedImages.push(dockerizeRes.body.image.tag);
      trackedContainers.push(dockerizeRes.body.container.id);

      // Verify custom health response returned from the existing container
      assert.equal(dockerizeRes.body.health.status, 'healthy');
      assert.equal(dockerizeRes.body.health.response.custom, true);

      // Clean up container
      await req.delete(`/api/projects/${projectId}/docker`);
    });

    it('Scenario C: Existing broken Dockerfile — should fail or safely repair with backup and never produce false success', async (t) => {
      if (!isDockerAvailable) {
        t.skip('Docker is not available on host');
        return;
      }

      // Step 1: Upload project with broken Dockerfile
      const zipBuffer = createBrokenDockerfileProjectZip();
      const uploadRes = await req
        .post('/api/projects/upload')
        .attach('project', zipBuffer, 'broken-dockerfile-demo.zip');

      assert.equal(uploadRes.status, 201);
      const { projectId } = uploadRes.body;

      // Step 2: Trigger Dockerize
      const dockerizeRes = await req
        .post(`/api/projects/${projectId}/dockerize`);

      // It should either safely repair (marking source as repaired_after_failure with backup) or return failure
      if (dockerizeRes.body.status === 'success') {
        assert.equal(dockerizeRes.body.dockerfile.source, 'repaired_after_failure');
        assert.ok(dockerizeRes.body.dockerfile.backupPath, 'backup path must be recorded');
        trackedContainers.push(dockerizeRes.body.container.id);
        trackedImages.push(dockerizeRes.body.image.tag);
        await req.delete(`/api/projects/${projectId}/docker`);
      } else {
        assert.ok(dockerizeRes.body.status === 'failed' || dockerizeRes.body.status === 'blocked');
        assert.ok(dockerizeRes.body.error, 'must report actual Docker build error');
      }
    });
  });
});
