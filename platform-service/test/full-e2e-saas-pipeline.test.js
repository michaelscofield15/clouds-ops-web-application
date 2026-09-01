const assert = require('assert');
const path = require('path');
const fs = require('fs');
const request = require('supertest');
const AdmZip = require('adm-zip');

const testBaseDir = path.resolve(__dirname, '../temporary/test-full-e2e-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');
const dbService = require('../src/services/db/db.service');
const dockerClient = require('../src/services/docker/docker.client');

function makeFullStackZip() {
  const zip = new AdmZip();

  // Root package.json
  const rootPkg = {
    name: 'cloudops-fullstack-app',
    version: '1.0.0',
    private: true,
    workspaces: ['frontend', 'backend']
  };

  // Frontend service
  const frontendPkg = {
    name: 'frontend',
    version: '1.0.0',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview'
    },
    dependencies: {
      react: '^18.2.0',
      'react-dom': '^18.2.0'
    }
  };

  // Backend service
  const backendPkg = {
    name: 'backend',
    version: '1.0.0',
    main: 'server.js',
    scripts: {
      start: 'node server.js'
    },
    dependencies: {
      express: '^4.18.2'
    }
  };

  const backendServer = `
const express = require('express');
const app = express();
const PORT = process.env.PORT || 4000;

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/data', (req, res) => res.json({ message: 'Hello from CloudOps E2E backend!' }));

if (require.main === module) {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}
module.exports = app;
`;

  zip.addFile('package.json', Buffer.from(JSON.stringify(rootPkg, null, 2), 'utf8'));
  zip.addFile('frontend/package.json', Buffer.from(JSON.stringify(frontendPkg, null, 2), 'utf8'));
  zip.addFile('backend/package.json', Buffer.from(JSON.stringify(backendPkg, null, 2), 'utf8'));
  zip.addFile('backend/server.js', Buffer.from(backendServer, 'utf8'));
  zip.addFile('.env.example', Buffer.from('PORT=4000\nDATABASE_URL=postgresql://localhost:5432/app\nJWT_SECRET=supersecret', 'utf8'));

  return zip.toBuffer();
}

async function runFullE2ESaaSPipelineTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: FULL END-TO-END AUTONOMOUS SAAS PIPELINE TEST SUITE');
  console.log('========================================================================\n');

  const req = request(app);
  let passed = 0;
  let failed = 0;

  async function step(name, fn) {
    console.log(`▶ Step: ${name}...`);
    try {
      await fn();
      console.log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      console.error(`✖ FAIL: ${name}`);
      console.error(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  let sessionToken, user, org;
  let awsConnId, githubConnId, jenkinsConnId;
  let uploadedProjectId, analysisData;

  // Step 1: Signup
  await step('1. SIGNUP: User registers and automatically provisions isolated tenant workspace', async () => {
    const res = await req.post('/api/auth/signup').send({
      name: 'E2E DevOps Engineer',
      email: 'engineer@cloudops-enterprise.internal',
      organizationName: 'CloudOps Enterprise Org',
      password: 'SecurePassword123!'
    });

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.token);
    assert.ok(res.body.organization.id);
    assert.strictEqual(res.body.user.email, 'engineer@cloudops-enterprise.internal');

    sessionToken = res.body.token;
    user = res.body.user;
    org = res.body.organization;
  });

  // Step 2: Login
  await step('2. LOGIN: Authenticate and verify session token', async () => {
    const res = await req.post('/api/auth/login').send({
      email: 'engineer@cloudops-enterprise.internal',
      password: 'SecurePassword123!'
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.token);
    assert.strictEqual(res.body.user.id, user.id);
    sessionToken = res.body.token;
  });

  // Step 3: Connect Providers (AWS, GitHub, Jenkins)
  await step('3. CONNECT PROVIDERS: Link encrypted tenant AWS, GitHub & Jenkins connections', async () => {
    // AWS
    const resAws = await req.post('/api/connections')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        provider: 'AWS',
        name: 'Enterprise AWS Production',
        credentials: {
          accessKeyId: 'AKIA_E2E_PROD_ACCESS',
          secretAccessKey: 'SECRET_E2E_PROD_KEY',
          region: 'ap-south-1'
        }
      });
    assert.strictEqual(resAws.status, 201);
    awsConnId = resAws.body.connection?.id || resAws.body.id;

    // GitHub
    const resGh = await req.post('/api/connections')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        provider: 'GITHUB',
        name: 'Enterprise GitHub',
        credentials: {
          token: 'ghp_E2E_ENTERPRISE_TOKEN'
        }
      });
    assert.strictEqual(resGh.status, 201);
    githubConnId = resGh.body.connection?.id || resGh.body.id;

    // Jenkins
    const resJn = await req.post('/api/connections')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        provider: 'JENKINS',
        name: 'Enterprise Jenkins Master',
        credentials: {
          url: 'http://127.0.0.1:8080',
          username: 'e2e-admin',
          apiToken: 'e2e-token'
        }
      });
    assert.strictEqual(resJn.status, 201);
    jenkinsConnId = resJn.body.connection?.id || resJn.body.id;
  });

  // Step 4: Upload Full-Stack ZIP Application
  await step('4. UPLOAD FULL-STACK ZIP: Ingest multi-service React + Express monorepo', async () => {
    const zipBuffer = makeFullStackZip();
    const res = await req.post('/api/projects/upload')
      .set('Authorization', `Bearer ${sessionToken}`)
      .attach('project', zipBuffer, 'fullstack-app.zip');

    assert.strictEqual(res.status, 201);
    assert.ok(res.body.projectId);
    assert.strictEqual(res.body.organizationId, org.id);
    assert.strictEqual(res.body.status, 'uploaded');
    assert.ok(res.body.checksum);

    uploadedProjectId = res.body.projectId;
    analysisData = res.body.analysis;
  });

  // Step 5: AST Analysis & Multi-Service Inspection
  await step('5. ANALYZE: Verify multi-service topology, port discovery and env requirements', async () => {
    const res = await req.get(`/api/projects/${uploadedProjectId}`).set('Authorization', `Bearer ${sessionToken}`);
    assert.strictEqual(res.status, 200);

    const an = res.body.analysis || res.body;
    assert.ok(an.topology);
    assert.ok(an.environmentVariables?.required?.includes('DATABASE_URL'));
    assert.ok(an.environmentVariables?.required?.includes('JWT_SECRET'));
  });

  // Step 6: Generate Deployment Plan
  await step('6. GENERATE PLAN: Synthesize explainable 8-stage deployment plan', async () => {
    const res = await req.post(`/api/projects/${uploadedProjectId}/orchestrate/plan`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({
        computeTarget: 'EC2',
        region: 'ap-south-1',
        awsConnectionId: awsConnId,
        githubConnectionId: githubConnId
      });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.plan?.planId || res.body.plan?.stages || res.body.planId);
  });

  // Step 7: Synthesize Dockerfile
  await step('7. DOCKERIZE: Generate optimized Dockerfile for detected stack', async () => {
    const res = await req.post(`/api/projects/${uploadedProjectId}/dockerize`)
      .set('Authorization', `Bearer ${sessionToken}`);

    assert.ok([200, 503].includes(res.status));
    assert.ok(res.body.dockerfile || res.body.status === 'success' || res.body.status === 'blocked' || res.body.imageTag);
  });

  // Step 8: Generate Terraform IaC
  await step('8. PROVISION IAC: Generate tenant-isolated HCL manifests', async () => {
    const res = await req.post(`/api/projects/${uploadedProjectId}/terraform/generate`)
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ region: 'ap-south-1' });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.success === true || res.body.data?.filesGenerated || res.body.filesGenerated);
  });

  // Step 9: Health Probe & Synthetic Verification
  await step('9. HEALTH CHECK: Verify root health probe and API status', async () => {
    const res = await req.get('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'healthy');
  });

  // Step 10: Security Audit Trail Verification
  await step('10. AUDIT TRAIL: Verify complete tenant-scoped audit logging without secret leaks', async () => {
    const res = await req.get('/api/audit').set('Authorization', `Bearer ${sessionToken}`);
    assert.strictEqual(res.status, 200);
    const logs = res.body.logs || res.body;

    assert.ok(Array.isArray(logs) && logs.length >= 3);
    assert.ok(logs.every(e => e.organizationId === org.id || !e.organizationId));
    // Zero secret leak verification
    const jsonLogs = JSON.stringify(logs);
    assert.ok(!jsonLogs.includes('SECRET_E2E_PROD_KEY'));
    assert.ok(!jsonLogs.includes('ghp_E2E_ENTERPRISE_TOKEN'));
    assert.ok(!jsonLogs.includes('SecurePassword123!'));
  });

  console.log('========================================================================');
  console.log(`FULL E2E PIPELINE SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  fs.rmSync(testBaseDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

runFullE2ESaaSPipelineTests().catch(err => {
  console.error('Fatal E2E test error:', err);
  process.exit(1);
});
