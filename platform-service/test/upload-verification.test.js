const assert = require('assert');
const AdmZip = require('adm-zip');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:4000';

function makeValidZipBuffer() {
  const zip = new AdmZip();
  const pkgJson = JSON.stringify({
    name: 'cloudops-sample-app',
    version: '1.0.0',
    main: 'server.js',
    dependencies: {
      express: '^4.18.2'
    }
  }, null, 2);

  const serverJs = `
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log('App running on port ' + PORT);
});
`;

  zip.addFile('package.json', Buffer.from(pkgJson, 'utf8'));
  zip.addFile('server.js', Buffer.from(serverJs, 'utf8'));
  return zip.toBuffer();
}

async function runUploadVerificationSuite() {
  console.log('========================================================================');
  console.log('CLOUDOPS: APPLICATION UPLOAD & SINGLE-ZIP INTEGRITY TEST SUITE');
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
  await test('1. Health check returns HTTP 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'healthy');
  });

  // 2. Setup Tenant A
  let tokenA, userA, orgA;
  const uniqueA = Date.now().toString(36);
  await test('2. Sign up Tenant A (Owner)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Engineer',
        email: `alice.${uniqueA}@acme-corp.internal`,
        organizationName: `Acme Corp ${uniqueA}`,
        password: 'Password123!'
      })
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201);
    assert.ok(body.token);
    tokenA = body.token;
    userA = body.user;
    orgA = body.organization;
  });

  // 3. Unauthenticated Upload Rejection
  await test('3. Reject unauthenticated upload with HTTP 401 Unauthorized', async () => {
    const zipBuf = makeValidZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'app.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 401);
    assert.ok(body.message?.includes('Authentication required') || body.error === 'Unauthorized');
  });

  // 4. Single Valid ZIP Upload (Success)
  let uploadedProjectId;
  await test('4. Accept single valid application ZIP with HTTP 201 Created', async () => {
    const zipBuf = makeValidZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'cloudops-sample.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, `Upload failed: ${JSON.stringify(body)}`);
    assert.ok(body.projectId, 'Must generate projectId');
    assert.strictEqual(body.organizationId, orgA.id);
    assert.strictEqual(body.status, 'uploaded');
    assert.ok(body.checksum, 'Must calculate SHA-256 checksum');
    assert.strictEqual(body.checksum.length, 64, 'SHA-256 must be 64-character hex');
    
    // Validate AST Analysis
    const analysis = body.analysis?.analysis || body.analysis;
    assert.strictEqual(analysis.project?.name, 'cloudops-sample-app');
    assert.strictEqual(analysis.project?.runtime, 'Node.js');
    assert.strictEqual(analysis.project?.language, 'JavaScript');
    assert.strictEqual(analysis.framework?.name, 'Express');
    assert.strictEqual(analysis.port?.value, 3000);
    assert.strictEqual(analysis.packageManager, 'npm');

    uploadedProjectId = body.projectId;
  });

  // 5. Multiple Files Upload Rejection
  await test('5. Reject multiple files in one request with HTTP 400 "Too many files"', async () => {
    const zipBuf = makeValidZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'app1.zip');
    form.append('extraFile', new Blob([zipBuf]), 'app2.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400);
    assert.ok(
      body.error === 'Too many files' || body.error === 'Upload error' || body.message?.includes('Only one ZIP'),
      `Expected "Too many files" error but received: ${JSON.stringify(body)}`
    );
    assert.ok(body.message?.includes('Only one ZIP') || body.message?.includes('Too many files'));
  });

  // 6. Non-ZIP File Rejection
  await test('6. Reject non-ZIP file with HTTP 400 "Invalid file type"', async () => {
    const form = new FormData();
    form.append('project', new Blob(['console.log("hello world");'], { type: 'text/plain' }), 'app.js');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(body.error, 'Invalid file type');
    assert.ok(body.message?.includes('Only .zip archive files are accepted'));
  });

  // 7. Empty File Rejection
  await test('7. Reject empty 0-byte file with HTTP 400 "Empty archive"', async () => {
    const form = new FormData();
    form.append('project', new Blob([]), 'empty.zip');

    const res = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400);
    assert.ok(body.error === 'Empty archive' || body.error === 'Archive extraction failed');
  });

  // 8. Project Appears in Tenant A Projects List
  await test('8. Uploaded project appears in Tenant A projects list', async () => {
    const res = await fetch(`${BASE_URL}/api/projects`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    const projects = body.projects || (Array.isArray(body) ? body : []);
    assert.ok(Array.isArray(projects));
    const found = projects.find(p => p.id === uploadedProjectId);
    assert.ok(found, `Project ${uploadedProjectId} must be listed in tenant workspace`);
    assert.strictEqual(found.name, 'cloudops-sample-app');
    assert.strictEqual(found.runtime, 'Node.js');
  });

  // 9. Setup Tenant B and Test Strict Cross-Tenant IDOR Protection
  let tokenB, userB, orgB;
  const uniqueB = (Date.now() + 1).toString(36);
  await test('9. Tenant B cannot access or inspect Tenant A project (Strict IDOR Defense)', async () => {
    const resSignup = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob Competitor',
        email: `bob.${uniqueB}@competitor.internal`,
        organizationName: `Competitor Ltd ${uniqueB}`,
        password: 'Password456!'
      })
    });
    const bodySignup = await resSignup.json();
    assert.strictEqual(resSignup.status, 201);
    tokenB = bodySignup.token;
    orgB = bodySignup.organization;

    // Tenant B attempts to read Tenant A's project
    const resIDOR = await fetch(`${BASE_URL}/api/projects/${uploadedProjectId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const bodyIDOR = await resIDOR.json();
    assert.strictEqual(resIDOR.status, 403, 'Must return HTTP 403 Forbidden for cross-tenant access');
    assert.strictEqual(bodyIDOR.error, 'Forbidden');
    assert.ok(bodyIDOR.message.includes('Access denied'));

    // Tenant B's project list must not contain Tenant A's project
    const resListB = await fetch(`${BASE_URL}/api/projects`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const listBodyB = await resListB.json();
    assert.strictEqual(resListB.status, 200);
    const projectsB = listBodyB.projects || (Array.isArray(listBodyB) ? listBodyB : []);
    assert.ok(Array.isArray(projectsB));
    const leaked = projectsB.find(p => p.id === uploadedProjectId);
    assert.strictEqual(leaked, undefined, 'Tenant A project must never leak into Tenant B project list');
  });

  console.log('========================================================================');
  console.log(`UPLOAD TEST SUITE SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runUploadVerificationSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
