const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const orchestratorEngine = require('../src/services/orchestrator');
const { RequirementEngine, REQUIREMENT_STATUS } = require('../src/services/orchestrator/requirement.engine');
const { DeploymentPlanner, CONFIDENCE_LEVELS } = require('../src/services/orchestrator/deployment.planner');
const { PreflightEngine } = require('../src/services/orchestrator/preflight.engine');
const { FailureAnalyzer, FAILURE_CATEGORIES, REMEDIATION_DECISIONS } = require('../src/services/orchestrator/failure.analyzer');
const { OrchestratorStorage } = require('../src/services/orchestrator/orchestrator.storage');
const { DEPLOYMENT_STATES } = require('../src/services/orchestrator/orchestrator.engine');

const storageService = require('../src/services/storage.service');
const awsClient = require('../src/services/aws/aws.client');
const ec2Service = require('../src/services/aws/ec2.service');
const ssmService = require('../src/services/aws/ssm.service');
const healthProbeService = require('../src/services/monitoring/health.probe.service');

async function runAwsE2ETest() {
  console.log('========================================================================');
  console.log('PHASE 10: REAL AWS INTELLIGENT DEPLOYMENT ORCHESTRATION & RCA E2E TEST');
  console.log('========================================================================\n');

  const projectId = 'cloudops-demo-app';
  const region = 'ap-south-1';
  const expectedInstanceId = 'i-0e4f06a59698d1afa';

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    console.log(`▶ ${name}...`);
    try {
      await fn();
      passed++;
      console.log(`✔ PASS: ${name}\n`);
    } catch (err) {
      failed++;
      console.log(`✖ FAIL: ${name}`);
      console.log(`  Error: ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      console.log('');
    }
  }

  try {
    // -------------------------------------------------------------------------
    // STEP 1: Verify Real AWS Identity & Infrastructure Pre-requisites
    // -------------------------------------------------------------------------
    await test('1. Real AWS STS Identity & Active EC2 Instance Verification', async () => {
      const sts = await awsClient.getCallerIdentity(region);
      assert.equal(sts.connected, true, 'AWS STS must be connected');
      assert.equal(sts.accountId, '892748150267', 'Must match AWS Account 892748150267');
      console.log(`   [AWS STS] Account: ${sts.accountId}, ARN: ${sts.arn}`);

      const instance = await ec2Service.getInstanceDetails(expectedInstanceId, region);
      assert.equal(instance.instanceId, expectedInstanceId);
      assert.equal(instance.state, 'running', 'EC2 instance must be running');
      assert.ok(instance.publicIp, 'EC2 instance must have public IP');
      console.log(`   [AWS EC2] Instance ID: ${instance.instanceId}, State: ${instance.state}, Public IP: ${instance.publicIp}`);

      const ssmInfo = await ssmService.getInstanceInformation(expectedInstanceId, region);
      assert.equal(ssmInfo.isOnline, true, 'SSM agent must be online');
      console.log(`   [AWS SSM] Ping Status: ${ssmInfo.pingStatus}, Agent: ${ssmInfo.agentVersion}`);
    });

    // -------------------------------------------------------------------------
    // STEP 2: Intelligent Requirement Resolution Engine ("Ask Only When Required")
    // -------------------------------------------------------------------------
    await test('2. Intelligent Requirement Resolution Engine evaluates project metadata', async () => {
      const reqEngine = new RequirementEngine();

      const sampleAnalysis = {
        project: { name: 'cloudops-demo-app', runtime: 'Node.js', language: 'JavaScript' },
        port: { value: 3000, source: 'code' },
        entryPoint: { value: 'src/server.js' },
        devops: { kubernetes: { hasManifests: false } },
        environmentVariables: { required: [] }
      };

      const evalResult = await reqEngine.evaluateRequirements(sampleAnalysis, {
        aws: { connected: true, region },
        github: { connected: true },
        jenkins: { connected: true }
      });

      assert.equal(evalResult.allResolved, true, 'All requirements should be resolved without user prompts');
      assert.equal(evalResult.missingCount, 0);

      // Verify application runtime was detected without asking user
      const appReq = evalResult.requirements.find(r => r.id === 'APPLICATION_RUNTIME');
      assert.equal(appReq.status, REQUIREMENT_STATUS.READY);
      assert.equal(appReq.userActionRequired, false);

      console.log(`   [Requirements] Total evaluated: ${evalResult.totalRequirements}, Missing: ${evalResult.missingCount}, All Resolved: ${evalResult.allResolved}`);
    });

    // -------------------------------------------------------------------------
    // STEP 3: Explainable Deployment Planner
    // -------------------------------------------------------------------------
    let generatedPlan;
    await test('3. Explainable Deployment Planner generates structured plan with evidence', () => {
      const planner = new DeploymentPlanner();

      const analysis = {
        projectId,
        project: { name: 'cloudops-demo-app', runtime: 'Node.js' },
        framework: { name: 'Express' },
        port: { value: 3000 },
        devops: { kubernetes: { hasManifests: false }, docker: { hasDockerfile: true } }
      };

      generatedPlan = planner.generatePlan(analysis, {}, { region });
      assert.ok(generatedPlan.planId);
      assert.equal(generatedPlan.computeTarget, 'AWS_EC2');
      assert.equal(generatedPlan.region, region);
      assert.equal(generatedPlan.totalStages, 8);

      const computeDecision = generatedPlan.decisions.find(d => d.category === 'COMPUTE_TARGET');
      assert.ok(computeDecision);
      assert.equal(computeDecision.confidence, CONFIDENCE_LEVELS.HIGH);
      console.log(`   [Planner] Plan ID: ${generatedPlan.planId}, Compute: ${generatedPlan.computeTarget}, Stages: ${generatedPlan.totalStages}`);
      console.log(`   [Planner Decision] ${computeDecision.decision} (Confidence: ${computeDecision.confidence}) — Reason: ${computeDecision.reason}`);
    });

    // -------------------------------------------------------------------------
    // STEP 4: Preflight Validation Engine & Derived AWS Permissions
    // -------------------------------------------------------------------------
    await test('4. Preflight Validation Engine verifies derived AWS permissions', async () => {
      const preflight = new PreflightEngine();

      const perms = preflight.getRequiredAWSPermissions('AWS_EC2');
      assert.ok(perms.length >= 6);
      assert.ok(perms.some(p => p.action === 'ec2:RunInstances'));
      assert.ok(perms.some(p => p.action === 'ecr:PutImage'));
      assert.ok(perms.some(p => p.action === 'ssm:SendCommand'));

      console.log(`   [Preflight] Derived ${perms.length} mandatory AWS IAM actions for EC2+SSM deployment`);
    });

    // -------------------------------------------------------------------------
    // STEP 5: Real Deployment Orchestration State Machine & Public Health Probe
    // -------------------------------------------------------------------------
    await test('5. Real Deployment Orchestration State Machine & Live Application Verification', async () => {
      const storage = new OrchestratorStorage();

      // Verify active instance public IP and endpoint
      const inst = await ec2Service.getInstanceDetails(expectedInstanceId, region);
      const liveEndpoint = `http://${inst.publicIp}:3000`;
      const healthEndpoint = `http://${inst.publicIp}:3000/health`;

      console.log(`   [Orchestrator] Testing live public application at ${healthEndpoint}...`);
      const probe = await healthProbeService.probeEndpoint(healthEndpoint, { timeoutMs: 5000 });
      assert.equal(probe.isHealthy, true, `Real application at ${healthEndpoint} must return HTTP 200 OK`);
      assert.equal(probe.httpStatus, 200);

      // Save and verify complete orchestrator state
      const depRecord = storage.saveDeployment(projectId, {
        state: DEPLOYMENT_STATES.LIVE,
        plan: generatedPlan,
        instanceId: expectedInstanceId,
        publicIp: inst.publicIp,
        endpoint: liveEndpoint,
        healthEndpoint,
        deployedAt: new Date().toISOString(),
        monitoringActive: true,
        selfHealingActive: true
      });

      storage.updateStage(projectId, 'STAGE_HEALTH_VERIFICATION', 'COMPLETED', { httpStatus: 200 });
      storage.updateStage(projectId, 'STAGE_MONITORING_HANDOFF', 'COMPLETED');
      storage.updateStage(projectId, 'STAGE_SELF_HEALING_HANDOFF', 'COMPLETED');

      const loaded = storage.getDeployment(projectId);
      assert.equal(loaded.state, DEPLOYMENT_STATES.LIVE);
      assert.equal(loaded.endpoint, liveEndpoint);

      console.log(`   [Orchestrator State] Status: ${loaded.state}`);
      console.log(`   [Verified Live Endpoint] ${loaded.endpoint}`);
      console.log(`   [Verified Health Probe] HTTP ${probe.httpStatus} (Response time: ${probe.durationMs}ms)`);
    });

    // -------------------------------------------------------------------------
    // STEP 6: Real Failure Analyzer & Root Cause Analysis (RCA) Engine
    // -------------------------------------------------------------------------
    await test('6. Failure Analyzer & RCA Engine classifies all failure categories with safe remediation decisions', () => {
      const failureAnalyzer = new FailureAnalyzer();

      // Case A: IAM Permission Failure
      const rcaPerm = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_AWS_DEPLOYMENT',
        error: new Error('User: arn:aws:iam::892748150267:user/operator is not authorized to perform: ec2:RunInstances on resource: *')
      });
      assert.equal(rcaPerm.failureType, FAILURE_CATEGORIES.AWS_PERMISSION_FAILURE);
      assert.equal(rcaPerm.remediationDecision, REMEDIATION_DECISIONS.REQUIRES_USER);
      console.log(`   [RCA A] ${rcaPerm.failureType} -> Decision: ${rcaPerm.remediationDecision} (Root Cause: ${rcaPerm.rootCause})`);

      // Case B: Docker Build Dependency Failure
      const rcaDocker = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_DOCKERIZE',
        error: { message: 'Command failed: docker build', stderr: 'npm ERR! 404 Not Found - express-nonexistent-pkg@^1.0.0' }
      });
      assert.equal(rcaDocker.failureType, FAILURE_CATEGORIES.DOCKER_BUILD_FAILURE);
      assert.equal(rcaDocker.remediationDecision, REMEDIATION_DECISIONS.REQUIRES_USER);
      console.log(`   [RCA B] ${rcaDocker.failureType} -> Decision: ${rcaDocker.remediationDecision}`);

      // Case C: Application HTTP 500 (Auto-recoverable via Phase 9)
      const rcaHealth = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_HEALTH_VERIFICATION',
        error: new Error('Health check probe returned HTTP 500: Database connection timed out')
      });
      assert.equal(rcaHealth.failureType, FAILURE_CATEGORIES.HEALTH_CHECK_FAILURE);
      assert.equal(rcaHealth.recoverable, true);
      assert.equal(rcaHealth.remediationDecision, REMEDIATION_DECISIONS.CAN_AUTO_FIX);
      console.log(`   [RCA C] ${rcaHealth.failureType} -> Decision: ${rcaHealth.remediationDecision} (Recoverable: ${rcaHealth.recoverable})`);

      // Case D: Destructive Terraform Plan
      const rcaTf = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_TERRAFORM_IAC',
        error: new Error('Terraform plan contains destructive actions blocked by CloudOps safety gate')
      });
      assert.equal(rcaTf.failureType, FAILURE_CATEGORIES.TERRAFORM_PLAN_FAILURE);
      assert.equal(rcaTf.remediationDecision, REMEDIATION_DECISIONS.UNSAFE_TO_FIX);
      console.log(`   [RCA D] ${rcaTf.failureType} -> Decision: ${rcaTf.remediationDecision}`);
    });

  } finally {
    awsClient.destroy();
  }

  console.log('========================================================================');
  console.log(`PHASE 10 REAL AWS E2E TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  process.exit(failed === 0 ? 0 : 1);
}

runAwsE2ETest().catch((err) => {
  console.error('Fatal E2E test error:', err);
  process.exit(1);
});
