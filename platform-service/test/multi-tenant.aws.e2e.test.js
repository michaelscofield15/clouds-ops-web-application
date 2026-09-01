const assert = require('assert');
const path = require('path');
const fs = require('fs');

const authService = require('../src/services/auth/auth.service');
const db = require('../src/services/db/db.service');
const secretVault = require('../src/services/security/secret.vault');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const connectionFactory = require('../src/services/connections/connection.factory');
const storageService = require('../src/services/storage.service');
const { analyzeProject } = require('../src/services/analyzer');
const healthProbeService = require('../src/services/monitoring/health.probe.service');
const { requireOrgRole } = require('../src/middleware/auth.middleware');
const config = require('../src/config');

async function runRealAWSMultiTenantE2ETest() {
  console.log('========================================================================');
  console.log('PHASE 11: REAL AWS MULTI-TENANT & TWO-USER END-TO-END VERIFICATION');
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
      console.error(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  // Clear in-memory / test databases
  db.clearAll();
  secretVault.clear();

  let userA, userB, orgA, orgB, tokenA, tokenB;
  let connAwsA = null;
  const projectAId = `proj-alice-${Date.now().toString(36)}`;
  const projectBId = `proj-bob-${Date.now().toString(36)}`;

  // Step 1: Real User A & User B Signups and Organization Isolation
  await report('1. Create Isolated Tenants (User A: Alice / Org A vs User B: Bob / Org B)', async () => {
    const resA = await authService.signup({
      email: 'alice@cloudops-test.internal',
      password: 'AlicePassword123!',
      name: 'Alice CloudOps',
      organizationName: 'Alpha Cloud Solutions'
    });

    const resB = await authService.signup({
      email: 'bob@cloudops-test.internal',
      password: 'BobPassword123!',
      name: 'Bob Enterprise',
      organizationName: 'Beta Data Corp'
    });

    userA = resA.user;
    orgA = resA.organization;
    tokenA = resA.token;

    userB = resB.user;
    orgB = resB.organization;
    tokenB = resB.token;

    assert.notStrictEqual(userA.id, userB.id);
    assert.notStrictEqual(orgA.id, orgB.id);
    assert.strictEqual(userA.email, 'alice@cloudops-test.internal');
    assert.strictEqual(userB.email, 'bob@cloudops-test.internal');
    console.log(`   [Tenant A] Org: '${orgA.name}' (ID: ${orgA.id}), User: '${userA.name}'`);
    console.log(`   [Tenant B] Org: '${orgB.name}' (ID: ${orgB.id}), User: '${userB.name}'`);
  });

  // Step 2: User A Connects and Verifies Real AWS Credentials
  await report('2. User A Connects Real AWS Account (892748150267) & Verifies STS Identity', async () => {
    // Encrypt and store User A's real AWS credentials from environment
    connAwsA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'AWS',
      name: 'Alice Production AWS Account',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || config.aws.accessKeyId || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || config.aws.secretAccessKey || '',
        sessionToken: process.env.AWS_SESSION_TOKEN || config.aws.sessionToken || '',
        region: 'ap-south-1'
      },
      metadata: {
        region: 'ap-south-1'
      }
    });

    assert.ok(connAwsA.id.startsWith('conn-aws-'), 'AWS connection ID created');
    assert.strictEqual(connAwsA.metadata.region, 'ap-south-1');
    assert.strictEqual(connAwsA.status, 'CONNECTED');

    // Perform REAL test against AWS STS
    const testResult = await providerConnectionService.testConnection(connAwsA.id, orgA.id);
    assert.strictEqual(testResult.success, true);
    assert.strictEqual(testResult.accountId, '892748150267', 'Must verify real AWS account ID 892748150267');
    console.log(`   [AWS STS Verified] Account: ${testResult.accountId}, Region: ${testResult.region}, ARN: ${testResult.arn}`);
  });

  // Step 3: Provider Connection Isolation (User B cannot see or use User A's AWS Connection)
  await report('3. User B Provider Isolation — Completely Blocked from User A AWS Connection', async () => {
    // A. User B lists connections -> Must be empty
    const listB = providerConnectionService.listConnections(orgB.id);
    assert.strictEqual(listB.length, 0, 'User B must see 0 connections');

    // B. User B requests User A's connection -> Must return null
    const crossGet = providerConnectionService.getConnection(connAwsA.id, orgB.id);
    assert.strictEqual(crossGet, null, 'User B must not be able to get User A connection');

    // C. User B attempts connection test on User A's connection -> Must throw
    await assert.rejects(
      async () => providerConnectionService.testConnection(connAwsA.id, orgB.id),
      /not found/
    );

    // D. Connection Factory blocks User B from creating an AWS client with User A's connection ID
    assert.throws(
      () => connectionFactory.getAWSClient(connAwsA.id, orgB.id),
      /not found for organization/
    );
    console.log(`   [Security Verified] User B cannot read, list, test, or instantiate User A AWS connection '${connAwsA.id}'`);
  });

  // Step 4: Multi-Tenant Project Creation & Workspace Isolation
  await report('4. Project Workspace & Storage Isolation between Tenants', async () => {
    const wsA = storageService.createWorkspace(projectAId, orgA.id);
    const wsB = storageService.createWorkspace(projectBId, orgB.id);

    assert.ok(wsA.projectDir.includes(orgA.id), 'Project A directory must contain Org A ID');
    assert.ok(wsB.projectDir.includes(orgB.id), 'Project B directory must contain Org B ID');

    // Sample mock analysis for demo app
    const demoAppPath = path.resolve(__dirname, '../../cloudops-demo-app');
    let analysisA = {
      project: { name: 'cloudops-demo-app', runtime: 'nodejs', language: 'javascript' },
      port: { value: 3000 }
    };
    if (fs.existsSync(demoAppPath)) {
      analysisA = analyzeProject(demoAppPath);
    }

    storageService.saveAnalysis(projectAId, analysisA, orgA.id, userA.id);
    storageService.saveAnalysis(projectBId, { project: { name: 'bob-microservice', runtime: 'python' } }, orgB.id, userB.id);

    // Verify list queries are strictly tenant-scoped
    const userAProjects = storageService.listProjects(orgA.id);
    const userBProjects = storageService.listProjects(orgB.id);

    assert.strictEqual(userAProjects.length, 1);
    assert.strictEqual(userAProjects[0].projectId, projectAId);

    assert.strictEqual(userBProjects.length, 1);
    assert.strictEqual(userBProjects[0].projectId, projectBId);

    // Cross-tenant project read rejection
    const crossRead = storageService.getProject(projectAId, orgB.id);
    assert.strictEqual(crossRead, null, 'User B must not be able to read Project A');
    console.log(`   [Storage Verified] Project '${projectAId}' is strictly isolated within Org A workspace`);
  });

  // Step 5: Real Deployment Live Health Probe Verification on Real AWS Infrastructure
  await report('5. Real AWS Public Infrastructure Health Probe on Live EC2 Instance', async () => {
    // Probe real active EC2 instance running in region ap-south-1
    const publicIp = '43.205.144.97';
    const liveEndpoint = `http://${publicIp}:3000`;
    const healthEndpoint = `${liveEndpoint}/health`;

    console.log(`   [Live Probe] Probing ${healthEndpoint}...`);
    const probe = await healthProbeService.probeEndpoint(healthEndpoint, { timeoutMs: 5000 });

    assert.strictEqual(probe.isHealthy, true, `Real app must be healthy (status: ${probe.httpStatus})`);
    assert.strictEqual(probe.httpStatus, 200);
    console.log(`   [Health Verified] Real application healthy: HTTP ${probe.httpStatus} (Response time: ${probe.durationMs}ms)`);
  });

  // Step 6: Multi-Tenant Role-Based Access Control (RBAC)
  await report('6. Organization Membership RBAC (OWNER / ADMIN / MEMBER Roles)', async () => {
    // Add Charlie as MEMBER to Org A
    const charlieSignup = await authService.signup({
      email: 'charlie@cloudops-test.internal',
      password: 'CharliePassword123!',
      name: 'Charlie Developer',
      organizationName: 'Charlie Personal'
    });

    const memberRecord = db.insert('memberships', {
      organizationId: orgA.id,
      userId: charlieSignup.user.id,
      role: 'MEMBER'
    });

    assert.strictEqual(memberRecord.role, 'MEMBER');

    // Simulate RBAC Middleware check
    const ownerReq = { user: userA, organization: orgA, membership: { role: 'OWNER' } };
    const memberReq = { user: charlieSignup.user, organization: orgA, membership: { role: 'MEMBER' } };

    let ownerAllowed = false;
    requireOrgRole(['OWNER', 'ADMIN'])(ownerReq, {}, () => { ownerAllowed = true; });
    assert.strictEqual(ownerAllowed, true, 'OWNER must have access');

    let memberBlocked = false;
    const mockRes = {
      status(code) {
        if (code === 403) memberBlocked = true;
        return this;
      },
      json() { return this; }
    };
    requireOrgRole(['OWNER', 'ADMIN'])(memberReq, mockRes, () => {});
    assert.strictEqual(memberBlocked, true, 'MEMBER must be blocked from ADMIN actions (HTTP 403)');
    console.log(`   [RBAC Verified] OWNER has full privileges, MEMBER role is restricted from destructive actions`);
  });

  console.log('========================================================================');
  console.log(`PHASE 11 REAL AWS E2E TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runRealAWSMultiTenantE2ETest();
}

module.exports = { runRealAWSMultiTenantE2ETest };
