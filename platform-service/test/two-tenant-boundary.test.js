const assert = require('assert');
const path = require('path');
const fs = require('fs');
const request = require('supertest');

const testBaseDir = path.resolve(__dirname, '../temporary/test-two-tenant-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');
const dbService = require('../src/services/db/db.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const connectionFactory = require('../src/services/connections/connection.factory');
const agentService = require('../src/services/agent/agent.service');
const storageService = require('../src/services/storage.service');
const auditService = require('../src/services/audit.service');

async function runTwoTenantBoundaryTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: TWO-TENANT STRICT BOUNDARY & PROVIDER ISOLATION TEST SUITE');
  console.log('========================================================================\n');

  const req = request(app);
  let passed = 0;
  let failed = 0;

  function log(msg) {
    process.stdout.write(`${msg}\n`);
  }

  async function test(name, fn) {
    log(`▶ Testing: ${name}...`);
    try {
      await fn();
      log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      log(`✖ FAIL: ${name}`);
      log(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  // 1. Sign up Tenant A and Tenant B
  let tokenA, userA, orgA;
  let tokenB, userB, orgB;

  await test('1. Register Tenant A (Alpha Corp) and Tenant B (Beta Industries) into isolated workspaces', async () => {
    const resA = await req.post('/api/auth/signup').send({
      name: 'Alice Alpha',
      email: 'alice@alpha-corp.internal',
      organizationName: 'Alpha Corp',
      password: 'Password123!'
    });
    assert.strictEqual(resA.status, 201);
    tokenA = resA.body.token;
    userA = resA.body.user;
    orgA = resA.body.organization;

    const resB = await req.post('/api/auth/signup').send({
      name: 'Bob Beta',
      email: 'bob@beta-industries.internal',
      organizationName: 'Beta Industries',
      password: 'Password456!'
    });
    assert.strictEqual(resB.status, 201);
    tokenB = resB.body.token;
    userB = resB.body.user;
    orgB = resB.body.organization;

    assert.notStrictEqual(orgA.id, orgB.id);
  });

  // 2. Project Isolation
  await test('2. Tenant A and Tenant B workspaces are completely isolated', async () => {
    // Seed project records into DB with their respective organization IDs
    storageService.createWorkspace('proj-alpha-web', orgA.id);
    storageService.saveAnalysis('proj-alpha-web', { project: { name: 'Alpha Frontend' }, port: { value: 3000 } }, orgA.id, userA.id);

    storageService.createWorkspace('proj-beta-api', orgB.id);
    storageService.saveAnalysis('proj-beta-api', { project: { name: 'Beta Backend' }, port: { value: 8080 } }, orgB.id, userB.id);

    // Tenant A tries to read Tenant B's project -> 403 Forbidden
    const resAonB = await req.get('/api/projects/proj-beta-api').set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(resAonB.status, 403);

    // Tenant B tries to read Tenant A's project -> 403 Forbidden
    const resBonA = await req.get('/api/projects/proj-alpha-web').set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resBonA.status, 403);

    // Tenant A reading Tenant A's project -> 200 OK
    const resAonA = await req.get('/api/projects/proj-alpha-web').set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(resAonA.status, 200);

    // Tenant B reading Tenant B's project -> 200 OK
    const resBonB = await req.get('/api/projects/proj-beta-api').set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resBonB.status, 200);
  });

  // 3. Provider Connection Isolation
  let connA_AWS, connA_GitHub;
  await test('3. Provider connections are strictly tenant-scoped (No cross-tenant leaks)', async () => {
    // Tenant A configures AWS and GitHub
    const resConnAWS = await req.post('/api/connections')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        provider: 'AWS',
        name: 'Alpha AWS Production',
        credentials: {
          accessKeyId: 'AKIA_ALPHA_PROD_123',
          secretAccessKey: 'SECRET_ALPHA_PROD_456',
          region: 'us-west-2'
        }
      });
    assert.strictEqual(resConnAWS.status, 201);
    connA_AWS = resConnAWS.body.connection?.id || resConnAWS.body.id;

    const resConnGH = await req.post('/api/connections')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        provider: 'GITHUB',
        name: 'Alpha GitHub Account',
        credentials: {
          token: 'ghp_ALPHA_SECRET_TOKEN_789'
        }
      });
    assert.strictEqual(resConnGH.status, 201);
    connA_GitHub = resConnGH.body.connection?.id || resConnGH.body.id;

    // Tenant B listing connections should see 0 connections
    const resListB = await req.get('/api/connections').set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resListB.status, 200);
    const listB = resListB.body.connections || resListB.body;
    assert.strictEqual(listB.length, 0);

    // Tenant B attempting direct IDOR access to Tenant A's AWS connection -> 404/403
    const resIDOR = await req.get(`/api/connections/${connA_AWS}`).set('Authorization', `Bearer ${tokenB}`);
    assert.ok([403, 404].includes(resIDOR.status));

    // Connection Factory strictly prevents Tenant B from resolving Tenant A's AWS or GitHub client
    assert.throws(() => {
      connectionFactory.getAWSClient(connA_AWS, orgB.id);
    }, /not found for organization/);

    assert.throws(() => {
      connectionFactory.getGitHubToken(connA_GitHub, orgB.id);
    }, /not found for organization/);
  });

  // 4. Local Docker Agent Isolation
  await test('4. Local Docker Agent pairing and telemetry are isolated per tenant', async () => {
    // Tenant A requests pairing code
    const resPairA = await req.post('/api/agent/pair/request').set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(resPairA.status, 201);
    const codeA = resPairA.body.code;

    // Exchange pairing code
    const exchangeRes = agentService.exchangePairingCode({
      code: codeA,
      machineInfo: {
        hostname: 'alpha-builder-01',
        os: 'Darwin 24.0.0',
        arch: 'arm64'
      }
    });
    assert.strictEqual(exchangeRes.organizationId, orgA.id);

    // Tenant A queries status -> ONLINE
    const resStatusA = await req.get('/api/agent/status').set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(resStatusA.status, 200);
    assert.strictEqual(resStatusA.body.connected, true);
    assert.strictEqual(resStatusA.body.machineInfo.hostname, 'alpha-builder-01');

    // Tenant B queries status -> NOT_CONNECTED
    const resStatusB = await req.get('/api/agent/status').set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resStatusB.status, 200);
    assert.strictEqual(resStatusB.body.connected, false);
    assert.strictEqual(resStatusB.body.status, 'NOT_CONNECTED');
  });

  // 5. Audit Log Isolation
  await test('5. Security audit trails are strictly partitioned between tenants', async () => {
    auditService.log('proj-alpha-web', 'ALPHA_DEPLOY_ACTION', 'SUCCESS', { organizationId: orgA.id, userId: userA.id });
    auditService.log('proj-beta-api', 'BETA_DEPLOY_ACTION', 'SUCCESS', { organizationId: orgB.id, userId: userB.id });

    const resAuditA = await req.get('/api/audit').set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(resAuditA.status, 200);
    const logsA = resAuditA.body.logs || resAuditA.body;
    assert.ok(logsA.every(e => e.organizationId === orgA.id || !e.organizationId));
    assert.ok(!logsA.some(e => e.action === 'BETA_DEPLOY_ACTION'));

    const resAuditB = await req.get('/api/audit').set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(resAuditB.status, 200);
    const logsB = resAuditB.body.logs || resAuditB.body;
    assert.ok(logsB.every(e => e.organizationId === orgB.id || !e.organizationId));
    assert.ok(!logsB.some(e => e.action === 'ALPHA_DEPLOY_ACTION'));
  });

  console.log('========================================================================');
  console.log(`TWO-TENANT BOUNDARY TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

runTwoTenantBoundaryTests().catch(err => {
  console.error('Fatal two-tenant test error:', err);
  process.exit(1);
});
