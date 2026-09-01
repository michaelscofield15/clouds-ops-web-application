const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = require('../src/app');
const storageService = require('../src/services/storage.service');
const orchestratorEngine = require('../src/services/orchestrator');
const { RequirementEngine, REQUIREMENT_STATUS } = require('../src/services/orchestrator/requirement.engine');
const { DeploymentPlanner, CONFIDENCE_LEVELS } = require('../src/services/orchestrator/deployment.planner');
const { PreflightEngine } = require('../src/services/orchestrator/preflight.engine');
const { FailureAnalyzer, FAILURE_CATEGORIES, REMEDIATION_DECISIONS } = require('../src/services/orchestrator/failure.analyzer');
const { OrchestratorStorage } = require('../src/services/orchestrator/orchestrator.storage');
const { DEPLOYMENT_STATES } = require('../src/services/orchestrator/orchestrator.engine');

function log(msg = '') {
  process.stdout.write(msg + '\n');
}

async function runOrchestratorTests() {
  log('================================================================');
  log('PHASE 10: INTELLIGENT DEPLOYMENT ORCHESTRATOR & FAILURE ANALYZER');
  log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const startTime = Date.now();

  const server = http.createServer(app);
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, resolve));
  const req = request(server);

  const testProjectId = 'p-orch-test-unit';
  const reqEngine = new RequirementEngine();
  const planner = new DeploymentPlanner();
  const preflight = new PreflightEngine();
  const failureAnalyzer = new FailureAnalyzer();
  const storage = new OrchestratorStorage();

  async function test(name, fn) {
    console.log(`▶ Starting: ${name}`);
    try {
      await fn();
      passed++;
      console.log(`✔ PASS: ${name}`);
    } catch (err) {
      failed++;
      console.log(`✖ FAIL: ${name}`);
      console.log(`  Error: ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }

  try {
    storageService.createWorkspace(testProjectId);
    const ws = storageService.getWorkspacePath(testProjectId);
    fs.writeFileSync(path.join(ws.extractDir, 'package.json'), JSON.stringify({
      name: 'demo-app',
      version: '1.0.0',
      main: 'src/server.js',
      dependencies: { express: '^4.18.2' }
    }, null, 2));
    fs.mkdirSync(path.join(ws.extractDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws.extractDir, 'src/server.js'), 'console.log("demo app");');

    storageService.saveAnalysis(testProjectId, {
      project: { name: 'demo-app', runtime: 'Node.js', language: 'JavaScript' },
      port: { value: 3000 },
      framework: { name: 'Express' }
    });

    // ---------------------------------------------------------------------------
    // 1. Requirement Engine & "Ask Only When Required"
    // ---------------------------------------------------------------------------
    console.log('--- 1. Requirement Engine & "Ask Only When Required" ---');

    await test('Requirement Engine evaluates analysis and suppresses prompts when port is reliably detected', async () => {
      const analysis = {
        project: { runtime: 'Node.js', language: 'JavaScript' },
        port: { value: 3000, source: 'code' },
        entryPoint: { value: 'src/server.js' },
        devops: { kubernetes: { hasManifests: false } },
        environmentVariables: { required: [] }
      };

      const res = await reqEngine.evaluateRequirements(analysis);
      assert.ok(res.totalRequirements > 0);

      const appReq = res.requirements.find(r => r.id === 'APPLICATION_RUNTIME');
      assert.equal(appReq.status, REQUIREMENT_STATUS.READY);
      assert.equal(appReq.userActionRequired, false);

      const k8sReq = res.requirements.find(r => r.id === 'CONTAINER_ORCHESTRATION_K8S');
      assert.equal(k8sReq.status, REQUIREMENT_STATUS.NOT_REQUIRED);
    });

    await test('Requirement Engine flags missing environment secrets as requiring user action', async () => {
      const analysis = {
        project: { runtime: 'Node.js' },
        port: { value: 8080 },
        environmentVariables: { required: ['DATABASE_URL', 'STRIPE_API_KEY', 'PORT'] }
      };

      const withoutSecrets = await reqEngine.evaluateRequirements(analysis, {}, {});
      const secReq = withoutSecrets.requirements.find(r => r.id === 'ENVIRONMENT_SECRETS');
      assert.equal(secReq.status, REQUIREMENT_STATUS.MISSING);
      assert.equal(secReq.userActionRequired, true);
      assert.deepEqual(secReq.action.missingSecrets, ['DATABASE_URL', 'STRIPE_API_KEY']);

      const withSecrets = await reqEngine.evaluateRequirements(analysis, {}, {
        DATABASE_URL: 'postgres://localhost:5432/db',
        STRIPE_API_KEY: 'sk_test_123'
      });
      const secReqResolved = withSecrets.requirements.find(r => r.id === 'ENVIRONMENT_SECRETS');
      assert.equal(secReqResolved.status, REQUIREMENT_STATUS.READY);
      assert.equal(secReqResolved.userActionRequired, false);
    });

    // ---------------------------------------------------------------------------
    // 2. Deployment Planner & Explainable Decisions
    // ---------------------------------------------------------------------------
    console.log('\n--- 2. Deployment Planner & Explainable Decisions ---');

    await test('Deployment Planner selects EC2 + Docker with explainable evidence for single-service apps', () => {
      const analysis = {
        projectId: testProjectId,
        project: { name: 'demo-api', runtime: 'Node.js' },
        framework: { name: 'Express' },
        port: { value: 3000 },
        devops: { kubernetes: { hasManifests: false }, docker: { hasDockerfile: false } }
      };

      const plan = planner.generatePlan(analysis, {}, { region: 'ap-south-1' });
      assert.equal(plan.computeTarget, 'AWS_EC2');
      assert.equal(plan.region, 'ap-south-1');
      assert.equal(plan.totalStages, 8);

      const computeDecision = plan.decisions.find(d => d.category === 'COMPUTE_TARGET');
      assert.ok(computeDecision);
      assert.equal(computeDecision.decision, 'AWS EC2 + Docker');
      assert.equal(computeDecision.confidence, CONFIDENCE_LEVELS.HIGH);
      assert.match(computeDecision.reason, /Single-service container/);
    });

    await test('Deployment Planner selects EKS when Kubernetes manifests are detected', () => {
      const k8sAnalysis = {
        projectId: testProjectId,
        project: { name: 'k8s-microservice', runtime: 'Node.js' },
        devops: { kubernetes: { hasManifests: true } }
      };

      const plan = planner.generatePlan(k8sAnalysis, {});
      assert.equal(plan.computeTarget, 'AWS_EKS');
      const computeDecision = plan.decisions.find(d => d.category === 'COMPUTE_TARGET');
      assert.equal(computeDecision.decision, 'AWS EKS + Kubernetes');
    });

    // ---------------------------------------------------------------------------
    // 3. Preflight Engine & Derived Permissions
    // ---------------------------------------------------------------------------
    console.log('\n--- 3. Preflight Engine & Derived Permissions ---');

    await test('Preflight Engine derives specific AWS permissions and executes comprehensive checks', async () => {
      const perms = preflight.getRequiredAWSPermissions('AWS_EC2');
      assert.ok(perms.some(p => p.action === 'ec2:RunInstances'));
      assert.ok(perms.some(p => p.action === 'ecr:PutImage'));
      assert.ok(perms.some(p => p.action === 'ssm:SendCommand'));

      const plan = planner.generatePlan({ projectId: testProjectId, project: { name: 'app' } }, {});
      const res = await preflight.runPreflight(testProjectId, plan, { githubToken: 'ghp_mocktoken' });
      assert.ok('passed' in res);
      assert.ok(res.totalChecks >= 6);
    });

    // ---------------------------------------------------------------------------
    // 4. Failure Analyzer & Root Cause Analysis (RCA)
    // ---------------------------------------------------------------------------
    console.log('\n--- 4. Failure Analyzer & Root Cause Analysis (RCA) ---');

    await test('Failure Analyzer classifies AccessDenied as AWS_PERMISSION_FAILURE and masks secrets', () => {
      const rca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_AWS_DEPLOYMENT',
        error: new Error('User: arn:aws:iam::123:user/dev is not authorized to perform: ec2:RunInstances with SECRET_KEY=supersecretkey123')
      });

      assert.equal(rca.failureType, FAILURE_CATEGORIES.AWS_PERMISSION_FAILURE);
      assert.match(rca.rootCause, /AWS IAM policy denied/);
      assert.equal(rca.remediationDecision, REMEDIATION_DECISIONS.REQUIRES_USER);
      assert.ok(!rca.evidence.includes('supersecretkey123'));
    });

    await test('Failure Analyzer classifies Docker build dependency failures and health check HTTP 5xx', () => {
      const dockerRca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_DOCKERIZE',
        error: { message: 'Docker build exited with code 1', stderr: 'npm ERR! code ENOENT\nnpm ERR! 404 Not Found' }
      });
      assert.equal(dockerRca.failureType, FAILURE_CATEGORIES.DOCKER_BUILD_FAILURE);
      assert.match(dockerRca.rootCause, /Application dependency installation/);

      const healthRca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_HEALTH_VERIFICATION',
        error: new Error('Application health check failed: HTTP 500 Internal Server Error')
      });
      assert.equal(healthRca.failureType, FAILURE_CATEGORIES.HEALTH_CHECK_FAILURE);
      assert.equal(healthRca.recoverable, true);
      assert.equal(healthRca.remediationDecision, REMEDIATION_DECISIONS.CAN_AUTO_FIX);
    });

    await test('Failure Analyzer classifies destructive Terraform plans as UNSAFE_TO_FIX', () => {
      const rca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_TERRAFORM_IAC',
        error: new Error('Terraform plan contains destructive actions blocked by CloudOps safety gate')
      });

      assert.equal(rca.failureType, FAILURE_CATEGORIES.TERRAFORM_PLAN_FAILURE);
      assert.equal(rca.remediationDecision, REMEDIATION_DECISIONS.UNSAFE_TO_FIX);
    });

    // ---------------------------------------------------------------------------
    // 5. Orchestrator Storage & State Transitions
    // ---------------------------------------------------------------------------
    console.log('\n--- 5. Orchestrator Storage & State Transitions ---');

    await test('Orchestrator Storage persists deployment state, stages progress, and appends logs', () => {
      const pId = 'p-storage-test';
      storageService.createWorkspace(pId);

      const dep = storage.saveDeployment(pId, {
        state: DEPLOYMENT_STATES.PLANNING,
        userId: 'user-01'
      });
      assert.equal(dep.state, DEPLOYMENT_STATES.PLANNING);

      storage.updateStage(pId, 'STAGE_DOCKERIZE', 'RUNNING');
      let loaded = storage.getDeployment(pId);
      assert.equal(loaded.currentStage, 'STAGE_DOCKERIZE');

      storage.appendLog(pId, 'DOCKER', 'Container image compiled');
      loaded = storage.getDeployment(pId);
      assert.equal(loaded.logs.length, 1);
      assert.match(loaded.logs[0], /Container image compiled/);

      storageService.deleteWorkspace(pId);
    });

    // ---------------------------------------------------------------------------
    // 6. REST API Endpoints
    // ---------------------------------------------------------------------------
    console.log('\n--- 6. REST API Endpoints ---');

    await test('POST /api/projects/:id/orchestrate/analyze returns analysis and requirements', async () => {
      const res = await req.post(`/api/projects/${testProjectId}/orchestrate/analyze`);
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.requirements);
    });

    await test('POST and GET /api/projects/:id/orchestrate/plan returns generated plan', async () => {
      const postRes = await req
        .post(`/api/projects/${testProjectId}/orchestrate/plan`)
        .send({ region: 'ap-south-1' });
      assert.equal(postRes.status, 200);
      assert.equal(postRes.body.success, true);
      assert.equal(postRes.body.plan.totalStages, 8);

      const getRes = await req.get(`/api/projects/${testProjectId}/orchestrate/plan`);
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.planId, postRes.body.plan.planId);
    });

    await test('POST /api/projects/:id/orchestrate/preflight returns validation results', async () => {
      const res = await req.post(`/api/projects/${testProjectId}/orchestrate/preflight`);
      assert.equal(res.status, 200);
      assert.ok('passed' in res.body.preflight);
    });

    await test('GET /api/projects/:id/orchestrate/status and logs return active state', async () => {
      orchestratorEngine.storage.saveDeployment(testProjectId, {
        state: DEPLOYMENT_STATES.LIVE,
        endpoint: 'http://43.205.144.97:3000',
        healthEndpoint: 'http://43.205.144.97:3000/health',
        logs: ['[LOG] Initialized', '[LOG] Verified live']
      });

      const statusRes = await req.get(`/api/projects/${testProjectId}/orchestrate/status`);
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.state, DEPLOYMENT_STATES.LIVE);

      const logsRes = await req.get(`/api/projects/${testProjectId}/orchestrate/logs`);
      assert.equal(logsRes.status, 200);
      assert.equal(logsRes.body.logs.length, 2);
    });

  } finally {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    storageService.deleteWorkspace(testProjectId);
    http.globalAgent.destroy();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  log('\n================================================================');
  log(`TEST RUN SUMMARY: ${passed} Passed, ${failed} Failed (${durationSec}s)`);
  log('================================================================');

  process.exit(failed === 0 ? 0 : 1);
}

runOrchestratorTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
