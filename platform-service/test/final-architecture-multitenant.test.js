const assert = require('assert');
const path = require('path');
const fs = require('fs');

const testBaseDir = path.resolve(__dirname, '../temporary/test-multitenant-arch');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const dbService = require('../src/services/db/db.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const auditService = require('../src/services/audit.service');

async function runTests() {
  console.log('===============================================================');
  console.log('TEST SUITE: Multi-Tenant Boundary Isolation & Provider Zero-Fallback');
  console.log('===============================================================');

  const orgA = 'org-acme-corp-100';
  const orgB = 'org-beta-logistics-200';
  const userA = 'usr-alice-admin';
  const userB = 'usr-bob-operator';

  // 1. Create Tenant A
  console.log('[Test 1] Create Tenant A (Acme Corp)...');
  dbService.insert('organizations', { id: orgA, name: 'Acme Corp', ownerId: userA });
  dbService.insert('users', { id: userA, email: 'alice@acmewidgets.com', name: 'Alice Admin' });
  console.log(`✔ Tenant A created: Org ID = ${orgA}`);

  // 2. Create Tenant B
  console.log('[Test 2] Create Tenant B (Beta Logistics)...');
  dbService.insert('organizations', { id: orgB, name: 'Beta Logistics', ownerId: userB });
  dbService.insert('users', { id: userB, email: 'bob@betalogistics.com', name: 'Bob Operator' });
  console.log(`✔ Tenant B created: Org ID = ${orgB}`);

  // 3. Verify Initial Disconnected States for Both Tenants (Zero Fallback)
  console.log('[Test 3] Verify Zero-Fallback Disconnected Status for Fresh Tenants...');
  assert.throws(() => {
    providerConnectionService.getAWSClientForOrg(orgA);
  }, /Provider not connected: Please connect your AWS account/);

  assert.throws(() => {
    providerConnectionService.getGitHubTokenForOrg(orgB);
  }, /Provider not connected: Please connect your GitHub account/);

  assert.throws(() => {
    providerConnectionService.getJenkinsClientForOrg(orgB);
  }, /Provider not connected: Please connect your Jenkins server/);
  console.log('✔ Both tenants cleanly throw "Provider not connected" with zero hardcoded fallbacks');

  // 4. Connect AWS and GitHub to Tenant A
  console.log('[Test 4] Connect AWS and GitHub to Tenant A...');
  await providerConnectionService.createConnection({
    organizationId: orgA,
    userId: userA,
    provider: 'AWS',
    name: 'Acme Production AWS',
    credentials: {
      accessKeyId: 'AKIA_ACME_PROD_1111',
      secretAccessKey: 'secret_key_acme_prod_99999',
      region: 'ap-south-1'
    },
    metadata: {
      accountId: '111222333444',
      region: 'ap-south-1'
    }
  });

  await providerConnectionService.createConnection({
    organizationId: orgA,
    userId: userA,
    provider: 'GITHUB',
    name: 'Acme GitHub Org',
    credentials: {
      token: 'ghp_acme_pat_token_secret_12345'
    },
    metadata: {
      username: 'acme-corp'
    }
  });
  console.log('✔ Tenant A successfully configured encrypted AWS and GitHub connections');

  // 5. Assert Strict Tenant B Isolation (Tenant B must NOT inherit Tenant A credentials)
  console.log('[Test 5] Verify Tenant B has zero access to Tenant A connections...');
  const connsB = providerConnectionService.listConnections(orgB);
  assert.strictEqual(connsB.length, 0, 'Tenant B connections list must be empty');

  assert.throws(() => {
    providerConnectionService.getAWSClientForOrg(orgB);
  }, /Provider not connected/);

  assert.throws(() => {
    providerConnectionService.getGitHubTokenForOrg(orgB);
  }, /Provider not connected/);

  const awsClientA = providerConnectionService.getAWSClientForOrg(orgA);
  assert.strictEqual(awsClientA.region, 'ap-south-1');
  const ghTokenA = providerConnectionService.getGitHubTokenForOrg(orgA);
  assert.strictEqual(ghTokenA, 'ghp_acme_pat_token_secret_12345');
  console.log('✔ Tenant B remains 100% isolated; Tenant A credentials securely resolved');

  // 6. Test Project Isolation
  console.log('[Test 6] Verify Cross-Tenant Project Isolation...');
  const projectAId = 'proj-acme-secret-app-100';
  dbService.insert('projects', {
    id: projectAId,
    organizationId: orgA,
    userId: userA,
    name: 'Acme Secret Microservice',
    runtime: 'Node.js',
    port: 3000,
    createdAt: new Date().toISOString()
  });

  const projectsA = dbService.find('projects', { organizationId: orgA });
  assert.strictEqual(projectsA.length, 1, 'Tenant A should see 1 project');
  assert.strictEqual(projectsA[0].id, projectAId);

  const projectsB = dbService.find('projects', { organizationId: orgB });
  assert.strictEqual(projectsB.length, 0, 'Tenant B should see 0 projects');
  console.log('✔ Cross-tenant project access strictly separated');

  // 7. Test Audit Isolation
  console.log('[Test 7] Verify Cross-Tenant Audit Log Isolation...');
  auditService.log(userA, 'PAYMENT_CONFIG_UPDATED', 'SUCCESS', {
    organizationId: orgA,
    details: 'Confidential Stripe API key updated'
  });

  const auditEvents = dbService.find('audit_events', {});
  const auditA = auditEvents.filter(e => e.details?.organizationId === orgA || e.metadata?.organizationId === orgA);
  const auditB = auditEvents.filter(e => e.details?.organizationId === orgB || e.metadata?.organizationId === orgB);

  assert(auditA.length >= 1, 'Tenant A should see its audit log');
  assert.strictEqual(auditB.length, 0, 'Tenant B must NOT see Tenant A audit logs');
  console.log('✔ Tenant audit trails are strictly scoped to authenticated organization');

  console.log('\n===============================================================');
  console.log('✔ ALL 7 MULTI-TENANT & ZERO-FALLBACK ISOLATION TESTS PASSED!');
  console.log('===============================================================\n');

  // Cleanup
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n✖ Multi-Tenant Test Suite Failed:', err);
  process.exit(1);
});
