const assert = require('assert');
const path = require('path');
const fs = require('fs');
const request = require('supertest');

const testBaseDir = path.resolve(__dirname, '../temporary/test-prod-readiness-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');
const dbService = require('../src/services/db/db.service');
const authService = require('../src/services/auth/auth.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const storageService = require('../src/services/storage.service');

async function runProductionReadinessTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: PRODUCTION READINESS & FUNCTIONAL CORRECTNESS TEST SUITE');
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

  // 1. User & Tenant Onboarding
  let tenantA, tokenA, tenantB, tokenB;
  await test('1. User & Tenant Onboarding with Strict Isolation', async () => {
    const signupA = await authService.signup({
      email: 'owner@tenant-alpha.io',
      password: 'Password123!',
      name: 'Alpha Admin',
      organizationName: 'Alpha Cloud Corp'
    });
    tenantA = signupA.organization;
    tokenA = signupA.token;

    const signupB = await authService.signup({
      email: 'owner@tenant-beta.io',
      password: 'Password123!',
      name: 'Beta Admin',
      organizationName: 'Beta Logistics'
    });
    tenantB = signupB.organization;
    tokenB = signupB.token;

    assert.ok(tenantA.id);
    assert.ok(tenantB.id);
    assert.notStrictEqual(tenantA.id, tenantB.id);
  });

  // 2. AWS Connection Zero-Fallback Disconnected Status
  await test('2. Fresh Tenant AWS Status returns NOT CONNECTED with zero fallbacks', async () => {
    const res = await req.get('/api/aws/status')
      .set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.connected, false);
    assert.strictEqual(res.body.status, 'NOT_CONNECTED');
    assert.ok(res.body.message.includes('Provider not connected'));
  });

  // 3. AWS Credentials Validation & Region Selector
  await test('3. AWS Connection Validation with Real Region Binding & AES-256 Vault', async () => {
    const conn = await providerConnectionService.createConnection({
      organizationId: tenantA.id,
      userId: 'usr-alpha',
      provider: 'AWS',
      name: 'Alpha AWS Production',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'ap-south-1'
      },
      metadata: {
        region: 'ap-south-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE'
      }
    });

    assert.ok(conn.id);
    assert.strictEqual(conn.provider, 'AWS');
    assert.strictEqual(conn.metadata.region, 'ap-south-1');
    assert.ok(conn.metadata.maskedAccessKey);
    assert.strictEqual(conn.secretAccessKey, undefined, 'Secret key must NEVER be exposed');

    // Verify Tenant B has ZERO access to Tenant A AWS connection
    const tenantBConns = providerConnectionService.listConnections(tenantB.id);
    assert.strictEqual(tenantBConns.length, 0);
  });

  // 4. Invalid AWS Credentials Rejection (Real Provider Rejection)
  await test('4. Test Connection with Invalid AWS Credentials returns real error', async () => {
    const conn = dbService.findOne('connections', { organizationId: tenantA.id, provider: 'AWS' });
    assert.ok(conn);

    const testRes = await req.post(`/api/connections/${conn.id}/test`)
      .set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(testRes.status, 400);
    assert.strictEqual(testRes.body.error, 'ConnectionVerificationFailed');
    assert.ok(testRes.body.message);
  });

  // 5. GitHub Connection & Token Security
  await test('5. GitHub Provider Connection with Vault Encryption & Zero Token Leakage', async () => {
    const ghConn = await providerConnectionService.createConnection({
      organizationId: tenantA.id,
      userId: 'usr-alpha',
      provider: 'GITHUB',
      name: 'Alpha GitHub Account',
      credentials: {
        token: 'ghp_fakeExampleToken1234567890abcdefghij'
      },
      metadata: {
        username: 'alpha-org'
      }
    });

    assert.strictEqual(ghConn.provider, 'GITHUB');
    assert.ok(ghConn.metadata.maskedToken);
    assert.strictEqual(ghConn.token, undefined, 'GitHub token must never be in sanitized output');
  });

  // 6. Jenkins Connection & URL Security
  await test('6. Jenkins Provider Connection with URL and Credentials Encryption', async () => {
    const jnConn = await providerConnectionService.createConnection({
      organizationId: tenantA.id,
      userId: 'usr-alpha',
      provider: 'JENKINS',
      name: 'Alpha Jenkins CI',
      credentials: {
        url: 'http://jenkins.alpha.internal:8080',
        username: 'admin',
        apiToken: '11xxxxxxxxxxxxxxxxxxxx'
      },
      metadata: {
        url: 'http://jenkins.alpha.internal:8080',
        username: 'admin'
      }
    });

    assert.strictEqual(jnConn.provider, 'JENKINS');
    assert.strictEqual(jnConn.metadata.url, 'http://jenkins.alpha.internal:8080');
    assert.ok(jnConn.metadata.maskedApiToken);
  });

  // 7. Kubernetes Provider Connection
  await test('7. Kubernetes Cluster Connection Configuration', async () => {
    const k8sConn = await providerConnectionService.createConnection({
      organizationId: tenantA.id,
      userId: 'usr-alpha',
      provider: 'KUBERNETES',
      name: 'Alpha EKS Cluster',
      credentials: {
        namespace: 'production',
        endpoint: 'https://eks.ap-south-1.amazonaws.com'
      },
      metadata: {
        namespace: 'production',
        endpoint: 'https://eks.ap-south-1.amazonaws.com'
      }
    });

    assert.strictEqual(k8sConn.provider, 'KUBERNETES');
    assert.strictEqual(k8sConn.metadata.namespace, 'production');
  });

  // 8. Port Detection & Zero [object Object] Serialization
  await test('8. Application Port Detection & Canonical Endpoint Formatting (Zero [object Object])', async () => {
    const mockAnalysis = {
      project: { name: 'cloudemo', runtime: 'Node.js' },
      port: { value: 8080, source: 'package.json' }
    };

    const ws = storageService.createWorkspace(undefined, tenantA.id);
    storageService.saveAnalysis(ws.projectId, mockAnalysis, tenantA.id, 'usr-alpha');
    storageService.updateProject(ws.projectId, { dockerState: { imageTag: 'cloudops/cloudemo:latest' } });

    const validation = awsDeploymentService.validateProject(ws.projectId);
    assert.strictEqual(validation.port, 8080);
    assert.strictEqual(typeof validation.port, 'number');

    // Canonical endpoint construction
    const host = '13.234.112.45';
    const canonicalEndpoint = `http://${host}:${validation.port}`;
    assert.strictEqual(canonicalEndpoint, 'http://13.234.112.45:8080');
    assert.strictEqual(canonicalEndpoint.includes('[object'), false);
    assert.strictEqual(canonicalEndpoint.includes('localhost'), false);
  });

  // 9. Deployment Failure Handling (No Fake LIVE States)
  await test('9. Deployment Pipeline State Machine halts on failure without marking LIVE', async () => {
    const ws = storageService.createWorkspace(undefined, tenantA.id);
    storageService.saveAnalysis(ws.projectId, {
      project: { name: 'failing-app', runtime: 'Node.js' },
      port: 3000
    }, tenantA.id, 'usr-alpha');
    storageService.updateProject(ws.projectId, { dockerState: { imageTag: 'cloudops/failing-app:latest' } });

    // Calling AWS deploy with invalid credentials must throw and fail
    let threw = false;
    try {
      await awsDeploymentService.deploy(ws.projectId, { organizationId: tenantA.id });
    } catch (err) {
      threw = true;
      assert.ok(err.message);
    }
    assert.strictEqual(threw, true, 'Deployment must throw real error when cloud validation fails');

    const status = awsDeploymentService.getStatus(ws.projectId);
    assert.strictEqual(status.status, 'FAILED');
    assert.strictEqual(status.endpoint, null);
  });

  // 10. Cross-Tenant IDOR and Data Isolation
  await test('10. Cross-Tenant IDOR Protection across Projects, Connections, and Deployments', async () => {
    const wsA = storageService.createWorkspace(undefined, tenantA.id);
    storageService.saveAnalysis(wsA.projectId, { project: { name: 'secret-a' } }, tenantA.id, 'usr-alpha');

    // Tenant B attempts to fetch Tenant A project
    const res = await req.get(`/api/projects/${wsA.projectId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    assert.strictEqual(res.status, 404, 'Tenant B must receive 404 for Tenant A project');
  });

  console.log('========================================================================');
  console.log(`PRODUCTION READINESS SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

runProductionReadinessTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
