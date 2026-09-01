const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const app = require('../src/app');
const storageService = require('../src/services/storage.service');
const { RequirementEngine, REQUIREMENT_STATUS } = require('../src/services/orchestrator/requirement.engine');
const { DeploymentPlanner, CONFIDENCE_LEVELS } = require('../src/services/orchestrator/deployment.planner');
const { PreflightEngine } = require('../src/services/orchestrator/preflight.engine');
const { FailureAnalyzer, FAILURE_CATEGORIES, REMEDIATION_DECISIONS } = require('../src/services/orchestrator/failure.analyzer');
const { OrchestratorStorage } = require('../src/services/orchestrator/orchestrator.storage');
const { DEPLOYMENT_STATES } = require('../src/services/orchestrator/orchestrator.engine');
const awsClient = require('../src/services/aws/aws.client');

async function runEngine9Tests() {
  console.log('================================================================');
  console.log('ENGINE 9: INTELLIGENT DEPLOYMENT ORCHESTRATOR & FAILURE ANALYZER');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const startTime = Date.now();
  const req = request(app);

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

  const reqEngine = new RequirementEngine();
  const planner = new DeploymentPlanner();
  const preflight = new PreflightEngine();
  const failureAnalyzer = new FailureAnalyzer();
  const orchStorage = new OrchestratorStorage();

  try {
    await test('Requirement Engine evaluates analysis and suppresses prompts when port is detected', async () => {
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
    });

    await test('Requirement Engine flags missing environment secrets as user action required', async () => {
      const analysis = {
        project: { runtime: 'Node.js' },
        port: { value: 8080 },
        environmentVariables: { required: ['DATABASE_URL', 'STRIPE_API_KEY', 'PORT'] }
      };
      const withoutSecrets = await reqEngine.evaluateRequirements(analysis, {}, {});
      const secReq = withoutSecrets.requirements.find(r => r.id === 'ENVIRONMENT_SECRETS');
      assert.equal(secReq.status, REQUIREMENT_STATUS.MISSING);
      assert.equal(secReq.userActionRequired, true);
    });

    await test('Deployment Planner selects EC2 for single-service and EKS for Kubernetes manifests', () => {
      const ec2Plan = planner.generatePlan({ project: { name: 'app', runtime: 'Node.js' }, port: { value: 3000 } }, {});
      assert.equal(ec2Plan.computeTarget, 'AWS_EC2');
      assert.equal(ec2Plan.totalStages, 8);

      const eksPlan = planner.generatePlan({ project: { name: 'k8s-app' }, devops: { kubernetes: { hasManifests: true } } }, {});
      assert.equal(eksPlan.computeTarget, 'AWS_EKS');
    });

    await test('Preflight Engine derives specific AWS permissions based on compute target', () => {
      const perms = preflight.getRequiredAWSPermissions('AWS_EC2');
      assert.ok(perms.some(p => p.action === 'ec2:RunInstances'));
      assert.ok(perms.some(p => p.action === 'ecr:PutImage'));
      assert.ok(perms.some(p => p.action === 'ssm:SendCommand'));
    });

    await test('Failure Analyzer performs Root Cause Analysis (RCA) and masks sensitive credentials', () => {
      const rca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_AWS_DEPLOYMENT',
        error: new Error('User: arn:aws:iam::123:user/dev is not authorized to perform: ec2:RunInstances with SECRET_KEY=supersecretkey123')
      });
      assert.equal(rca.failureType, FAILURE_CATEGORIES.AWS_PERMISSION_FAILURE);
      assert.equal(rca.remediationDecision, REMEDIATION_DECISIONS.REQUIRES_USER);
      assert.ok(!rca.evidence.includes('supersecretkey123'));
    });

    await test('Orchestrator Storage persists deployment state, stage progress, and logs', () => {
      const pId = 'p-orch-store-test';
      storageService.createWorkspace(pId);
      const dep = orchStorage.saveDeployment(pId, { state: DEPLOYMENT_STATES.PLANNING });
      assert.equal(dep.state, DEPLOYMENT_STATES.PLANNING);
      orchStorage.updateStage(pId, 'STAGE_DOCKERIZE', 'RUNNING');
      orchStorage.appendLog(pId, 'DOCKER', 'Building image');
      const loaded = orchStorage.getDeployment(pId);
      assert.equal(loaded.currentStage, 'STAGE_DOCKERIZE');
      assert.equal(loaded.logs.length, 1);
      storageService.deleteWorkspace(pId);
    });

    await test('REST API /api/projects/:id/orchestrate/plan and status handle orchestration requests', async () => {
      const pId = 'p-orch-rest-test';
      storageService.createWorkspace(pId);
      const ws = storageService.getWorkspacePath(pId);
      fs.writeFileSync(path.join(ws.extractDir, 'package.json'), JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        main: 'index.js'
      }));
      fs.writeFileSync(path.join(ws.extractDir, 'index.js'), 'console.log("hello");');
      storageService.saveAnalysis(pId, { project: { name: 'test-app', runtime: 'Node.js' } });

      const planRes = await req.post(`/api/projects/${pId}/orchestrate/plan`).send({ region: 'ap-south-1' });
      assert.equal(planRes.status, 200);
      assert.equal(planRes.body.success, true);
      assert.equal(planRes.body.plan.totalStages, 8);

      const statusRes = await req.get(`/api/projects/${pId}/orchestrate/status`);
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.state, DEPLOYMENT_STATES.PLAN_READY);

      storageService.deleteWorkspace(pId);
    });

  } finally {
    awsClient.destroy();
    storageService.cleanupAll();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n================================================================');
  console.log(`TEST RUN SUMMARY: ${passed} Passed, ${failed} Failed (${durationSec}s)`);
  console.log('================================================================');

  process.exit(failed === 0 ? 0 : 1);
}

runEngine9Tests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
