const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:4000';

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

async function runE2EUploadAuthTest() {
  console.log('========================================================================');
  console.log('CLOUDOPS: LIVE SERVER END-TO-END UPLOAD & AUTHENTICATION VERIFICATION');
  console.log(`Target: ${BASE_URL}`);
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

  // 1. Health Probe
  await test('1. GET /health responds with HTTP 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'healthy');
  });

  // 2. Unauthenticated Upload Rejection
  await test('2. POST /api/projects/upload without Authorization header is rejected with 401', async () => {
    const zipBuf = makeZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'app.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 401, 'Unauthenticated upload must return 401');
    assert.ok(
      body.message?.includes('Authentication required') || body.error === 'Unauthorized',
      'Response must explain authentication requirement'
    );
  });

  // 3. User Signup & Atomic Tenant Creation (Tenant A)
  let tokenA, userA, orgA;
  const uniqueA = Date.now().toString(36);
  await test('3. POST /api/auth/signup creates Tenant A with session token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice CloudOps',
        email: `alice.${uniqueA}@alphacloud.internal`,
        organizationName: `Alpha Solutions ${uniqueA}`,
        password: 'Password123!'
      })
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, `Signup failed with status ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(body.token, 'Must return session token');
    assert.strictEqual(body.token.length, 64, 'Token must be 64-char hex string');
    tokenA = body.token;
    userA = body.user;
    orgA = body.organization;
  });

  // 4. Session Validation (GET /api/auth/me)
  await test('4. GET /api/auth/me returns authenticated context with valid Bearer token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.user.id, userA.id);
    assert.strictEqual(body.organization.id, orgA.id);
    assert.strictEqual(body.membership.role, 'OWNER');
  });

  // 5. Authenticated Upload Request
  let uploadedProjectId;
  await test('5. POST /api/projects/upload succeeds with Authorization: Bearer <tokenA>', async () => {
    const zipBuf = makeZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'cloudops-sample.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, `Upload failed with status ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(body.projectId, 'Must return generated projectId');
    assert.strictEqual(body.organizationId, orgA.id);
    assert.strictEqual(body.status, 'uploaded');
    assert.ok(body.checksum, 'Must calculate SHA-256 checksum');
    assert.ok(
      body.analysis.project?.runtime === 'Node.js' || body.analysis.runtime === 'Node.js',
      'Runtime must be detected as Node.js'
    );
    uploadedProjectId = body.projectId;
  });

  // 6. Tenant B Creation & Strict IDOR Defense
  let tokenB, orgB;
  const uniqueB = (Date.now() + 1).toString(36);
  await test('6. Tenant B cannot access or inspect Tenant A project (Strict IDOR Defense)', async () => {
    const resSignup = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob DevOps',
        email: `bob.${uniqueB}@betadata.internal`,
        organizationName: `Beta Data ${uniqueB}`,
        password: 'Password456!'
      })
    });
    const bodySignup = await resSignup.json();
    assert.strictEqual(resSignup.status, 201);
    tokenB = bodySignup.token;
    orgB = bodySignup.organization;

    // Tenant B tries to read Tenant A's project
    const resIDOR = await fetch(`${BASE_URL}/api/projects/${uploadedProjectId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const bodyIDOR = await resIDOR.json();
    assert.strictEqual(resIDOR.status, 403, 'Must return HTTP 403 Forbidden for cross-tenant project access');
    assert.ok(bodyIDOR.message.includes('Access denied') || bodyIDOR.error === 'Forbidden');
  });

  // 7. Session Revocation (Logout)
  await test('7. POST /api/auth/logout revokes session token; subsequent requests are rejected', async () => {
    const resLogout = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const bodyLogout = await resLogout.json();
    assert.strictEqual(resLogout.status, 200);
    assert.strictEqual(bodyLogout.success, true);

    // Verify tokenA is now rejected
    const resMeAfter = await fetch(`${BASE_URL}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(resMeAfter.status, 401);
  });

  console.log('========================================================================');
  console.log(`LIVE E2E TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runE2EUploadAuthTest().catch(err => {
  console.error('Fatal live test runner error:', err);
  process.exit(1);
});
