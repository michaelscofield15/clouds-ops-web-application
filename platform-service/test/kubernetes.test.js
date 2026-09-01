const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = require('../src/app');
const manifestGenerator = require('../src/services/kubernetes/manifest.generator');
const prereqService = require('../src/services/kubernetes/prereq.service');
const k8sClient = require('../src/services/kubernetes/k8s.client');
const storageService = require('../src/services/storage.service');

describe('Phase 5 — Real Kubernetes Automation Engine Unit Tests', () => {
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
    http.globalAgent.destroy();
  });

  describe('1. Prerequisite & Environment Detection', () => {
    it('should detect Docker, kubectl, Kind, and Homebrew on host machine', async () => {
      const report = await prereqService.checkPrerequisites();

      assert.equal(report.os.platform, 'darwin');
      assert.equal(report.docker.installed, true);
      assert.equal(report.docker.daemonRunning, true);
      assert.equal(report.kubectl.installed, true);
      assert.equal(report.kind.installed, true);
      assert.equal(report.homebrew.installed, true);
      assert.equal(report.kubernetes.clusterExists, true);
      assert.equal(report.kubernetes.nodesReady, true);
      assert.equal(report.allReady, true);
    });

    it('should expose GET /api/kubernetes/status with accurate cluster information', async () => {
      const res = await req.get('/api/kubernetes/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.docker.installed, true);
      assert.equal(res.body.kubectl.installed, true);
      assert.equal(res.body.kind.installed, true);
      assert.equal(res.body.kubernetes.clusterName, 'cloudops-local');
      assert.equal(res.body.kubernetes.nodesReady, true);
    });
  });

  describe('2. Manifest Generation & DNS-1123 Sanitization', () => {
    it('should sanitize project IDs to valid Kubernetes DNS-1123 compliant names', () => {
      const raw1 = 'PROJECT_UUID_1234_ABC!!';
      const clean1 = manifestGenerator.sanitizeName(raw1);
      assert.ok(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(clean1), 'Name must match DNS-1123 regex');
      assert.equal(clean1, 'project-uuid-1234-abc');

      const prefixed = manifestGenerator.sanitizeName('my-test-app', 'cloudops-');
      assert.equal(prefixed, 'cloudops-my-test-app');
    });

    it('should generate valid Deployment and Service manifests with detected port and resources', () => {
      const projectId = 'b45c719e-9901';
      const analysis = {
        project: { name: 'test-k8s-app' },
        port: { value: 8080 },
        packageManager: 'npm'
      };
      const dockerState = {
        image: { tag: 'cloudops/test-k8s-app:build-b45c719e' }
      };

      const manifests = manifestGenerator.generateManifests(projectId, analysis, dockerState);

      assert.equal(manifests.namespace, 'cloudops-b45c719e-990');
      assert.equal(manifests.deploymentName, 'cloudops-app-b45c719e-990');
      assert.equal(manifests.serviceName, 'cloudops-svc-b45c719e-990');
      assert.equal(manifests.port, 8080);
      assert.equal(manifests.imageTag, 'cloudops/test-k8s-app:build-b45c719e');

      // Check Deployment YAML structure
      assert.ok(manifests.deploymentYaml.includes('kind: Deployment'));
      assert.ok(manifests.deploymentYaml.includes('image: cloudops/test-k8s-app:build-b45c719e'));
      assert.ok(manifests.deploymentYaml.includes('imagePullPolicy: IfNotPresent'));
      assert.ok(manifests.deploymentYaml.includes('containerPort: 8080'));
      assert.ok(manifests.deploymentYaml.includes('readinessProbe:'));
      assert.ok(manifests.deploymentYaml.includes('path: /health'));
      assert.ok(manifests.deploymentYaml.includes('cpu:'));
      assert.ok(manifests.deploymentYaml.includes('memory:'));

      // Check Service YAML structure
      assert.ok(manifests.serviceYaml.includes('kind: Service'));
      assert.ok(manifests.serviceYaml.includes('type: NodePort'));
      assert.ok(manifests.serviceYaml.includes('port: 8080'));
    });
  });

  describe('3. Error Handling & Validation Gates', () => {
    it('should return 404 when deploying non-existent project ID', async () => {
      const res = await req
        .post('/api/projects/non-existent-uuid-9999/kubernetes/deploy')
        .send({});

      assert.equal(res.status, 404);
      assert.ok((res.body.message || res.body.error).includes('not found'));
    });

    it('should reject deployment with 400 when project is not dockerized', async () => {
      // Create fresh project in storage without dockerState
      const projectId = storageService.generateProjectId();
      storageService.createWorkspace(projectId);
      storageService.saveAnalysis(projectId, {
        project: { name: 'undockerized-app' },
        port: { value: 3000 }
      });

      const res = await req
        .post(`/api/projects/${projectId}/kubernetes/deploy`)
        .send({});

      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('NOT_DOCKERIZED') || (res.body.message && res.body.message.includes('dockerized')));
    });

    it('should return not_deployed status for project without Kubernetes state', async () => {
      const projectId = storageService.generateProjectId();
      storageService.createWorkspace(projectId);
      storageService.saveAnalysis(projectId, {
        project: { name: 'un-deployed-app' },
        port: { value: 3000 }
      });

      const res = await req.get(`/api/projects/${projectId}/kubernetes/status`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'not_deployed');
    });
  });

  describe('4. Real Kubernetes Cluster Live Querying', () => {
    it('should retrieve live nodes and context from local Kind cluster', async () => {
      const context = await k8sClient.getCurrentContext();
      assert.equal(context, 'kind-cloudops-local');

      const nodes = await k8sClient.getNodes();
      assert.ok(nodes.length > 0);
      assert.equal(nodes[0].name, 'cloudops-local-control-plane');
      assert.equal(nodes[0].ready, true);
    });

    it('should safely create, verify, and delete a test namespace', async () => {
      const testNs = `cloudops-test-ns-${Date.now()}`;
      const created = await k8sClient.createNamespace(testNs);
      assert.equal(created.namespace, testNs);

      const exists = await k8sClient.namespaceExists(testNs);
      assert.equal(exists, true);

      await k8sClient.deleteNamespace(testNs);
    });
  });
});
