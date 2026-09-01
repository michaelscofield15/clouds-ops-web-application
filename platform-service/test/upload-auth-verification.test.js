const assert = require('node:assert/strict');
const request = require('supertest');
const AdmZip = require('adm-zip');

const app = require('../src/app');

function makeZipBuffer() {
  const zip = new AdmZip();
  const packageJson = {
    name: 'cloudops-sample-app',
    version: '1.0.0',
    main: 'server.js',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.18.2' }
  };
  const serverJs = `
    const express = require('express');
    const app = express();
    const port = process.env.PORT || 3000;
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.listen(port, () => console.log('Running on ' + port));
  `;
  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('server.js', Buffer.from(serverJs));
  return zip.toBuffer();
}

async function runUploadAuthVerification() {
  console.log('========================================================================');
  console.log('CLOUDOPS: UPLOAD APPLICATION & AUTHENTICATION FLOW VERIFICATION');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
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

  const req = request(app);

  // 1. Health Check
  await test('1. GET /health responds with HTTP 200 OK', async () => {
    const res = await req.get('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'healthy');
  });

  // 2. Unauthenticated Upload Rejection
  await test('2. POST /api/projects/upload without Authorization header is strictly rejected with 401', async () => {
    const zipBuf = makeZipBuffer();
    const res = await req
      .post('/api/projects/upload')
      .attach('project', zipBuf, 'app.zip');
    assert.strictEqual(res.status, 401);
    assert.ok(res.body.message.includes('Authentication required') || res.body.error === 'Unauthorized');
  });

  // 3. User Signup & Atomic Tenant Creation (Tenant A)
  let tokenA, userA, orgA;
  await test('3. POST /api/auth/signup creates Tenant A with session token', async () => {
    const res = await req.post('/api/auth/signup').send({
      name: 'Alice CloudOps',
      email: `alice.${Date.now()}@alphacloud.internal`,
      organizationName: 'Alpha Cloud Solutions',
      password: 'Password123!'
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
    assert.strictEqual(res.body.token.length, 64);
    tokenA = res.body.token;
    userA = res.body.user;
    orgA = res.body.organization;
  });

  // 4. Session Validation (GET /api/auth/me)
  await test('4. GET /api/auth/me returns authenticated context with valid Bearer token', async () => {
    const res = await req
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.id, userA.id);
    assert.strictEqual(res.body.organization.id, orgA.id);
    assert.strictEqual(res.body.membership.role, 'OWNER');
  });

  // 5. Authenticated Upload Request
  let uploadedProjectId;
  await test('5. POST /api/projects/upload succeeds with Authorization: Bearer <tokenA>', async () => {
    const zipBuf = makeZipBuffer();
    const res = await req
      .post('/api/projects/upload')
      .set('Authorization', `Bearer ${tokenA}`)
      .attach('project', zipBuf, 'cloudops-sample.zip');

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.projectId);
    assert.strictEqual(res.body.organizationId, orgA.id);
    assert.strictEqual(res.body.status, 'uploaded');
    assert.ok(res.body.checksum);
    assert.strictEqual(res.body.analysis.runtime.name, 'Node.js');
    uploadedProjectId = res.body.projectId;
  });

  // 6. Tenant B Creation & Strict IDOR Defense
  let tokenB, orgB;
  await test('6. Tenant B cannot access or inspect Tenant A project (Strict IDOR Defense)', async () => {
    const resSignup = await req.post('/api/auth/signup').send({
      name: 'Bob DevOps',
      email: `bob.${Date.now()}@betadata.internal`,
      organizationName: 'Beta Data Corp',
      password: 'Password456!'
    });
    assert.strictEqual(resSignup.status, 201);
    tokenB = resSignup.body.token;
    orgB = resSignup.body.organization;

    // Tenant B tries to read Tenant A's project
    const resIDOR = await req
      .get(`/api/projects/${uploadedProjectId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    assert.strictEqual(resIDOR.status, 403, 'Must return HTTP 403 Forbidden for cross-tenant project access');
    assert.ok(resIDOR.body.message.includes('Access denied') || resIDOR.body.error === 'Forbidden');
  });

  // 7. Session Revocation (Logout)
  await test('7. POST /api/auth/logout revokes session token; subsequent requests are rejected', async () => {
    const resLogout = await req
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tokenA}`);

    assert.strictEqual(resLogout.status, 200);
    assert.strictEqual(resLogout.body.success, true);

    // Verify tokenA is now rejected
    const resMeAfter = await req
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`);

    assert.strictEqual(resMeAfter.status, 401);
  });

  console.log('========================================================================');
  console.log(`VERIFICATION RESULT: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  runUploadAuthVerification().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = { runUploadAuthVerification };
