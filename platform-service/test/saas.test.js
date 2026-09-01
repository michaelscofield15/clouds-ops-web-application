const assert = require('assert');
const path = require('path');
const fs = require('fs');

const authService = require('../src/services/auth/auth.service');
const db = require('../src/services/db/db.service');
const secretVault = require('../src/services/security/secret.vault');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const connectionFactory = require('../src/services/connections/connection.factory');
const zipService = require('../src/services/zip.service');
const storageService = require('../src/services/storage.service');
const { analyzeProject } = require('../src/services/analyzer');
const requirementEngine = require('../src/services/orchestrator/requirement.engine');
const deploymentPlanner = require('../src/services/orchestrator/deployment.planner');
const preflightEngine = require('../src/services/orchestrator/preflight.engine');
const failureAnalyzer = require('../src/services/orchestrator/failure.analyzer');
const auditService = require('../src/services/audit.service');
const terraformEngine = require('../src/services/terraform');
const { createValidNodeProjectZip, createZipSlipBuffer } = require('./fixtures/make-fixtures');

async function runSaaSTestSuite() {
  console.log('========================================================================');
  console.log('PHASE 12: MULTI-TENANT PRODUCTION SAAS CONTROL PLANE TEST SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function report(name, fn) {
    try {
      console.log(`▶ Testing: ${name}...`);
      await fn();
      console.log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      console.error(`✖ FAIL: ${name}`);
      console.error(`  Error: ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(1, 3).join('\n'));
      console.log('');
      failed++;
    }
  }

  // Clear in-memory / test databases
  db.clearAll();
  secretVault.clear();

  let userA, userB, orgA, orgB, tokenA, tokenB;
  let connAwsA, connGhA, connJkA, connTfA, connK8sA;

  // -------------------------------------------------------------------------
  // Step 1: User Onboarding (Signup, Login, 256-bit Session Token, TTL)
  // -------------------------------------------------------------------------
  await report('1. User Onboarding: Atomic Tenant Creation & Cryptographic Sessions', async () => {
    const resA = await authService.signup({
      email: 'founder@alphacorp.internal',
      password: 'StrongAlphaPassword123!',
      name: 'Alice Founder',
      organizationName: 'Alpha Cloud Corp'
    });
    userA = resA.user;
    orgA = resA.organization;
    tokenA = resA.token;

    assert.ok(tokenA && tokenA.length >= 40, 'Session token must have high entropy');
    assert.strictEqual(userA.email, 'founder@alphacorp.internal');
    assert.strictEqual(userA.passwordHash, undefined, 'Password hash must never be returned');

    const resB = await authService.signup({
      email: 'engineer@betasystems.internal',
      password: 'StrongBetaPassword456!',
      name: 'Bob Lead',
      organizationName: 'Beta Systems Inc'
    });
    userB = resB.user;
    orgB = resB.organization;
    tokenB = resB.token;

    assert.notStrictEqual(orgA.id, orgB.id, 'Organizations must be completely distinct');
    assert.notStrictEqual(userA.id, userB.id, 'User IDs must be distinct');
  });

  // -------------------------------------------------------------------------
  // Step 2: 5-Provider Connection Center (AWS, GitHub, Jenkins, Terraform, Kubernetes)
  // -------------------------------------------------------------------------
  await report('2. Provider Connection Center: 5-Provider Credentials & AES-256-GCM Vault', async () => {
    // AWS
    connAwsA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'AWS',
      name: 'Alpha AWS Production',
      credentials: {
        accessKeyId: 'AKIA_ALICE_PROD_12345',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'ap-south-1'
      },
      metadata: { region: 'ap-south-1' }
    });
    assert.strictEqual(connAwsA.provider, 'AWS');
    assert.strictEqual(connAwsA.status, 'CONNECTED');
    assert.strictEqual(connAwsA.credentials, undefined, 'Zero plaintext secret exposure');
    assert.ok(connAwsA.metadata.purpose, 'Must explain why credential is used');
    assert.ok(Array.isArray(connAwsA.metadata.requiredPermissions), 'Must list required IAM permissions');

    // GitHub
    connGhA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'GITHUB',
      name: 'Alpha GitHub PAT',
      credentials: { token: 'ghp_AlphaToken1234567890abcdef' }
    });
    assert.strictEqual(connGhA.provider, 'GITHUB');

    // Jenkins
    connJkA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'JENKINS',
      name: 'Alpha CI/CD Server',
      credentials: { url: 'http://127.0.0.1:8080', username: 'alice', apiToken: 'jk_token_12345' }
    });
    assert.strictEqual(connJkA.provider, 'JENKINS');

    // Terraform
    connTfA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'TERRAFORM',
      name: 'Alpha Terraform IaC Engine',
      credentials: { binaryPath: 'terraform' }
    });
    assert.strictEqual(connTfA.provider, 'TERRAFORM');

    // Kubernetes
    connK8sA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'KUBERNETES',
      name: 'Alpha K8s Cluster',
      credentials: { kubeconfig: 'apiVersion: v1\nclusters: []', contextName: 'cloudops-cluster' }
    });
    assert.strictEqual(connK8sA.provider, 'KUBERNETES');

    const allConnsA = providerConnectionService.listConnections(orgA.id);
    assert.strictEqual(allConnsA.length, 5, 'Org A must have all 5 provider connections registered');
  });

  // -------------------------------------------------------------------------
  // Step 3: Secure ZIP Application Ingestion & SHA-256 Checksumming
  // -------------------------------------------------------------------------
  const projectIdA = `proj-alpha-${Date.now().toString(36)}`;
  let uploadChecksum = '';
  let extractionA = null;
  await report('3. Secure ZIP Ingestion: SHA-256 Checksumming & Zip Slip Defense', async () => {
    const validZip = createValidNodeProjectZip();
    uploadChecksum = zipService.calculateChecksum(validZip);
    assert.ok(uploadChecksum && uploadChecksum.length === 64, 'Checksum must be 64-char SHA-256 hex string');

    const ws = storageService.createWorkspace(projectIdA, orgA.id);
    extractionA = zipService.extractSafely(validZip, ws.extractDir);
    assert.strictEqual(extractionA.checksum, uploadChecksum);
    assert.ok(extractionA.fileCount > 0);

    // Verify Zip Slip protection
    const maliciousZip = createZipSlipBuffer();
    assert.throws(() => {
      zipService.extractSafely(maliciousZip, ws.extractDir);
    }, /Zip Slip|traversal/i);
  });

  // -------------------------------------------------------------------------
  // Step 4: Dynamic Application Analysis & Requirement Resolution Engine
  // -------------------------------------------------------------------------
  let analysisReport = null;
  await report('4. Dynamic Application Analysis & "Ask Only When Required" Engine', async () => {
    const ws = storageService.getWorkspacePath(projectIdA, orgA.id);
    analysisReport = analyzeProject(extractionA?.effectiveProjectRoot || ws.extractDir);

    assert.strictEqual(analysisReport.project?.runtime, 'Node.js');
    assert.strictEqual(analysisReport.port?.value, 8080);

    storageService.saveAnalysis(projectIdA, analysisReport, orgA.id, userA.id);

    const reqs = await requirementEngine.evaluateRequirements(analysisReport, {
      aws: connAwsA,
      github: connGhA,
      jenkins: connJkA
    });

    assert.strictEqual(reqs.allResolved, true, 'All requirements must automatically resolve when providers are connected');
    assert.strictEqual(reqs.missingCount, 0, 'No unnecessary prompts required');
  });

  // -------------------------------------------------------------------------
  // Step 5: Explainable 8-Stage Deployment Plan Generation
  // -------------------------------------------------------------------------
  let deploymentPlan = null;
  await report('5. Explainable 8-Stage Deployment Plan & Compute Target Selection', async () => {
    deploymentPlan = deploymentPlanner.generatePlan({
      analysis: analysisReport,
      options: { region: 'ap-south-1' }
    });

    assert.strictEqual(deploymentPlan.totalStages, 8);
    assert.strictEqual(deploymentPlan.computeTarget, 'AWS_EC2');
    const computeDecision = deploymentPlan.decisions.find((d) => d.category === 'COMPUTE_TARGET' || d.decision?.includes('AWS EC2'));
    assert.ok(computeDecision, 'Compute target decision must be recorded');
    assert.strictEqual(computeDecision.confidence, 'HIGH');
    assert.ok(computeDecision.reason.includes('Single-service') || computeDecision.reason.includes('container'));
  });

  // -------------------------------------------------------------------------
  // Step 6: Terraform State Isolation & Concurrency Locking per Tenant
  // -------------------------------------------------------------------------
  await report('6. Terraform Engine: Tenant-Isolated State & Concurrency Lock', async () => {
    const tfGen = await terraformEngine.generate(projectIdA, { region: 'ap-south-1' });
    assert.ok(tfGen.filesGenerated && tfGen.filesGenerated.length > 0, 'HCL configuration generated');

    const state = terraformEngine.stateService.getState(projectIdA);
    assert.ok(state.workspaceDir.includes(projectIdA), 'Terraform directory must be isolated per project');

    // Concurrency lock test
    const acquired = terraformEngine.stateService.acquireLock(projectIdA, 'apply');
    assert.strictEqual(acquired, true);
    const reacquire = terraformEngine.stateService.acquireLock(projectIdA, 'apply');
    assert.strictEqual(reacquire, false, 'Simultaneous lock must be rejected');
    terraformEngine.stateService.releaseLock(projectIdA);
  });

  // -------------------------------------------------------------------------
  // Step 7: Cross-Tenant IDOR Security & Tenant Boundary Enforcement
  // -------------------------------------------------------------------------
  await report('7. Cross-Tenant IDOR Protection & Boundary Isolation', async () => {
    // User B lists connections -> Must see 0
    const listB = providerConnectionService.listConnections(orgB.id);
    assert.strictEqual(listB.length, 0, 'User B must see 0 connections');

    // User B attempts to fetch User A's connection -> Must return null
    const crossConn = providerConnectionService.getConnection(connAwsA.id, orgB.id);
    assert.strictEqual(crossConn, null, 'User B must not access User A AWS connection');

    // User B attempts to access User A's project -> Must return null
    const crossProj = storageService.getAnalysis(projectIdA, orgB.id);
    assert.strictEqual(crossProj, null, 'User B must not access User A project');

    // User B attempts to instantiate AWSClient using User A's connection -> Must throw
    assert.throws(() => {
      connectionFactory.getAWSClient(connAwsA.id, orgB.id);
    }, /not found/i);
  });

  // -------------------------------------------------------------------------
  // Step 8: Tenant-Scoped Audit Trail with Automatic Secret Redaction
  // -------------------------------------------------------------------------
  await report('8. Security Audit Trail: Tenant-Scoped Event Logging & Redaction', async () => {
    auditService.log(projectIdA, 'DEPLOYMENT_START', 'SUCCESS', {
      organizationId: orgA.id,
      userId: userA.id,
      secretKey: 'sensitive-raw-api-key-12345',
      endpoint: 'http://43.205.144.97:3000'
    });

    const logsA = auditService.getTenantLogs(orgA.id);
    assert.ok(logsA.length > 0, 'Org A must have audit logs');

    const startEvent = logsA.find((l) => l.action === 'DEPLOYMENT_START');
    assert.ok(startEvent, 'Deployment start event must be logged');
    assert.strictEqual(startEvent.details.secretKey, '***REDACTED***', 'Secrets must be completely redacted');
    assert.strictEqual(startEvent.details.endpoint, 'http://43.205.144.97:3000');

    // User B has 0 audit logs from User A
    const logsB = auditService.getTenantLogs(orgB.id);
    assert.ok(!logsB.some((l) => l.organizationId === orgA.id || l.projectId === projectIdA), 'User B must see 0 audit events from User A');
  });

  storageService.deleteWorkspace(projectIdA, orgA.id);

  console.log('========================================================================');
  console.log(`PHASE 12 SAAS TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runSaaSTestSuite().catch((err) => {
  console.error('Fatal SaaS test runner error:', err);
  process.exit(1);
});
