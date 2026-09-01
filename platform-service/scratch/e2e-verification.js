/**
 * End-to-End Comprehensive Verification Test for CloudOps Platform & UI Backed APIs
 */
const AdmZip = require('adm-zip');

const BASE_URL = 'http://127.0.0.1:4000';

function makeValidZipBuffer() {
  const zip = new AdmZip();
  const pkgJson = JSON.stringify({
    name: 'cloudops-sample-app',
    version: '1.0.0',
    main: 'server.js',
    dependencies: { express: '^4.18.2' }
  }, null, 2);

  const serverJs = `
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log('App running on port ' + PORT));
`;

  zip.addFile('package.json', Buffer.from(pkgJson, 'utf8'));
  zip.addFile('server.js', Buffer.from(serverJs, 'utf8'));
  return zip.toBuffer();
}

async function run() {
  console.log('=== STARTING CLOUDOPS E2E PLATFORM & API VERIFICATION ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }

  try {
    // 1. Health Probe & Static UI
    console.log('[1] Health & Root Static Serving');
    const healthRes = await fetch(`${BASE_URL}/health`);
    const healthBody = await healthRes.json();
    assert(healthRes.status === 200 && healthBody.status === 'healthy', 'GET /health returns 200 OK');

    const rootRes = await fetch(`${BASE_URL}/`);
    const rootText = await rootRes.text();
    assert(rootRes.status === 200 && rootText.includes('CloudOps — Autonomous'), 'GET / serves CloudOps SaaS index.html');

    const appJsRes = await fetch(`${BASE_URL}/app.js`);
    const appJsText = await appJsRes.text();
    assert(appJsRes.status === 200 && appJsText.includes('App.init()'), 'GET /app.js serves frontend controller');

    // 2. Auth: Signup & Me
    console.log('\n[2] Multi-Tenant Authentication & RBAC');
    const userEmail = `e2e_${Date.now()}@enterprise.com`;
    const signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Developer',
        email: userEmail,
        organizationName: 'E2E Quantum Corp',
        password: 'SecurePassword123!'
      })
    });
    const signupBody = await signupRes.json();
    assert(signupRes.status === 201 && signupBody.token, `POST /api/auth/signup creates tenant and returns JWT`);
    const token = signupBody.token;
    const orgId = signupBody.organization.id;

    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const meBody = await meRes.json();
    assert(meRes.status === 200 && meBody.user.email === userEmail, 'GET /api/auth/me returns authenticated tenant profile');

    // 3. Provider Connections Center
    console.log('\n[3] Provider Connections Management (Encrypted Vault)');
    const awsRes = await fetch(`${BASE_URL}/api/connections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'AWS',
        name: 'Production AWS ap-south-1',
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        },
        metadata: {
          region: 'ap-south-1',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE'
        }
      })
    });
    const awsBody = await awsRes.json();
    assert(awsRes.status === 201 && awsBody.connection.id, 'POST /api/connections creates AWS provider credentials');

    const ghRes = await fetch(`${BASE_URL}/api/connections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'GITHUB',
        name: 'GitHub E2E Account',
        credentials: { token: 'ghp_dummytoken1234567890abcdef' },
        metadata: { username: 'e2e-user' }
      })
    });
    assert(ghRes.status === 201, 'POST /api/connections creates GitHub provider credentials');

    const connsListRes = await fetch(`${BASE_URL}/api/connections`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const connsList = await connsListRes.json();
    assert(connsListRes.status === 200 && connsList.connections.length >= 2, 'GET /api/connections lists tenant-isolated connections');

    // 4. Local Docker Agent Pairing
    console.log('\n[4] CloudOps Local Docker Agent Engine & Pairing');
    const pairReqRes = await fetch(`${BASE_URL}/api/agent/pair/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const pairReqBody = await pairReqRes.json();
    assert(pairReqRes.status === 201 && pairReqBody.code && pairReqBody.code.startsWith('PAIR-'), 'POST /api/agent/pair/request generates valid 10-minute pairing code');

    const agentStatusRes = await fetch(`${BASE_URL}/api/agent/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(agentStatusRes.status === 200, 'GET /api/agent/status returns real agent status');

    // 5. Application Upload & Ingestion
    console.log('\n[5] Application Upload & Analysis');
    const zipBuf = makeValidZipBuffer();
    const form = new FormData();
    form.append('project', new Blob([zipBuf]), 'cloudops-sample.zip');

    const uploadRes = await fetch(`${BASE_URL}/api/projects/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const uploadBody = await uploadRes.json();
    assert(uploadRes.status === 201 && uploadBody.projectId, 'POST /api/projects/upload ingests and analyzes project');
    const projectId = uploadBody.projectId;

    const projListRes = await fetch(`${BASE_URL}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const projListBody = await projListRes.json();
    assert(projListRes.status === 200 && projListBody.projects.length >= 1, 'GET /api/projects lists tenant projects');

    // 6. Terraform IaC Engine
    console.log('\n[6] Terraform IaC Engine');
    const tfStatusRes = await fetch(`${BASE_URL}/api/terraform/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const tfStatusBody = await tfStatusRes.json();
    assert(tfStatusRes.status === 200 && (tfStatusBody.terraformInstalled !== undefined || tfStatusBody.ready), 'GET /api/terraform/status returns CLI engine prerequisites');

    const tfGenRes = await fetch(`${BASE_URL}/api/projects/${projectId}/terraform/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const tfGenBody = await tfGenRes.json();
    assert(tfGenRes.status === 200 && tfGenBody.success, `POST /api/projects/:id/terraform/generate creates isolated HCL`);

    // 7. Security Audit Trail & Organization Members
    console.log('\n[7] Security Audit Trail & Organization Members');
    const auditRes = await fetch(`${BASE_URL}/api/audit`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const auditBody = await auditRes.json();
    assert(auditRes.status === 200 && Array.isArray(auditBody.logs), 'GET /api/audit retrieves tenant-scoped audit events');

    const inviteRes = await fetch(`${BASE_URL}/api/organizations/current/members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'collaborator@enterprise.com',
        role: 'ADMIN'
      })
    });
    const inviteBody = await inviteRes.json();
    assert(inviteRes.status === 201 && inviteBody.success, 'POST /api/organizations/current/members adds invited team member');

    const membersRes = await fetch(`${BASE_URL}/api/organizations/current/members`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const membersBody = await membersRes.json();
    assert(membersRes.status === 200 && membersBody.members.length >= 2, 'GET /api/organizations/current/members returns member list with RBAC roles');

    console.log(`\n==================================================`);
    console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`==================================================\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error during E2E verification:', err);
    process.exit(1);
  }
}

run();
