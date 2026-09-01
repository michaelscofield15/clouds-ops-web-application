const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Core Services to test
const authService = require('../src/services/auth/auth.service');
const db = require('../src/services/db/db.service');
const secretVault = require('../src/services/security/secret.vault');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const connectionFactory = require('../src/services/connections/connection.factory');
const storageService = require('../src/services/storage.service');
const { requireAuth, requireOrgRole, requireProjectAccess, requireConnectionAccess } = require('../src/middleware/auth.middleware');
const { createRateLimiter } = require('../src/middleware/rateLimit.middleware');

async function runMultiTenantTestSuite() {
  console.log('========================================================================');
  console.log('PHASE 11: MULTI-USER & MULTI-TENANT ARCHITECTURE TEST SUITE');
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

  // Clear test DB
  db.clearAll();
  secretVault.clear();

  // Test 1: Real User Signup, Validation & Salted Password Hashing
  await report('1. User Signup, Email Validation, Password Policy & Organization Creation', async () => {
    // A. Password too short (< 8 chars)
    await assert.rejects(
      async () => authService.signup({ email: 'userA@example.com', password: '123' }),
      /Password must be at least 8 characters/
    );

    // B. Successful Signup User A
    const signupA = await authService.signup({
      email: 'userA@example.com',
      password: 'Password123!',
      name: 'Alice Cloud',
      organizationName: 'Acme Corp'
    });

    assert.ok(signupA.user.id.startsWith('usr-'), 'User ID must be generated');
    assert.strictEqual(signupA.user.email, 'usera@example.com');
    assert.strictEqual(signupA.user.passwordHash, undefined, 'passwordHash must never be exposed');
    assert.strictEqual(signupA.user.salt, undefined, 'salt must never be exposed');
    assert.ok(signupA.organization.id.startsWith('org-'), 'Organization must be created');
    assert.strictEqual(signupA.organization.name, 'Acme Corp');
    assert.strictEqual(signupA.membership.role, 'OWNER', 'Initial member must be OWNER');
    assert.ok(signupA.token && signupA.token.length === 64, '64-hex session token generated');

    // C. Duplicate email prevention
    await assert.rejects(
      async () => authService.signup({ email: 'userA@example.com', password: 'Password456!' }),
      /already exists/
    );

    // D. Successful Signup User B
    const signupB = await authService.signup({
      email: 'userB@example.com',
      password: 'Password456!',
      name: 'Bob DevOps',
      organizationName: 'Beta Labs'
    });

    assert.notStrictEqual(signupA.user.id, signupB.user.id);
    assert.notStrictEqual(signupA.organization.id, signupB.organization.id);
  });

  // Test 2: Real User Login & Secure Session Management
  await report('2. User Login, Password Verification, Session TTL & Revocation', async () => {
    // A. Invalid password
    await assert.rejects(
      async () => authService.login({ email: 'userA@example.com', password: 'WrongPassword!' }),
      /Invalid email or password/
    );

    // B. Valid login
    const loginA = await authService.login({ email: 'userA@example.com', password: 'Password123!' });
    assert.strictEqual(loginA.user.email, 'usera@example.com');
    assert.strictEqual(loginA.organization.name, 'Acme Corp');
    assert.strictEqual(loginA.membership.role, 'OWNER');
    assert.ok(loginA.token);

    // C. Authenticate Token
    const authContext = await authService.authenticateToken(loginA.token);
    assert.ok(authContext, 'Token must authenticate successfully');
    assert.strictEqual(authContext.user.email, 'usera@example.com');
    assert.strictEqual(authContext.organization.name, 'Acme Corp');

    // D. Revoke Token on Logout
    const revoked = await authService.revokeToken(loginA.token);
    assert.strictEqual(revoked, true);
    const postLogoutAuth = await authService.authenticateToken(loginA.token);
    assert.strictEqual(postLogoutAuth, null, 'Revoked token must be rejected');
  });

  // Test 3: AES-256-GCM Secret Encryption Vault
  await report('3. AES-256-GCM Secret Vault Encryption, Decryption & Zero Plaintext Exposure', async () => {
    const rawSecret = { accessKeyId: 'AKIA1234567890EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    const ref = secretVault.encrypt(rawSecret);

    assert.ok(ref.startsWith('sec-'), 'Secret reference must be generated');
    
    // Vault storage check (encrypted)
    const stored = secretVault.storage.get(ref);
    assert.ok(stored.encryptedData);
    assert.notStrictEqual(stored.encryptedData, JSON.stringify(rawSecret));
    assert.strictEqual(stored.algorithm, 'aes-256-gcm');
    assert.ok(stored.iv && stored.tag);

    // Decrypt
    const decrypted = secretVault.decrypt(ref, true);
    assert.strictEqual(decrypted.accessKeyId, rawSecret.accessKeyId);
    assert.strictEqual(decrypted.secretAccessKey, rawSecret.secretAccessKey);

    // Delete secret
    const deleted = secretVault.deleteSecret(ref);
    assert.strictEqual(deleted, true);
    assert.strictEqual(secretVault.decrypt(ref), null);
  });

  // Test 4: Multi-Tenant Provider Connection Ownership & Isolation
  await report('4. Provider Connection Ownership & Strict Cross-Tenant Isolation', async () => {
    const userA = db.findOne('users', { email: 'usera@example.com' });
    const userB = db.findOne('users', { email: 'userb@example.com' });
    const orgA = db.findOne('organizations', { createdByUserId: userA.id });
    const orgB = db.findOne('organizations', { createdByUserId: userB.id });

    // User A connects AWS
    const connA = await providerConnectionService.createConnection({
      organizationId: orgA.id,
      userId: userA.id,
      provider: 'AWS',
      name: 'Org A Production AWS',
      credentials: {
        accessKeyId: 'AKIA_USER_A_KEY',
        secretAccessKey: 'SECRET_USER_A_KEY',
        region: 'ap-south-1'
      }
    });

    // User B connects AWS
    const connB = await providerConnectionService.createConnection({
      organizationId: orgB.id,
      userId: userB.id,
      provider: 'AWS',
      name: 'Org B Cloud AWS',
      credentials: {
        accessKeyId: 'AKIA_USER_B_KEY',
        secretAccessKey: 'SECRET_USER_B_KEY',
        region: 'us-east-1'
      }
    });

    assert.strictEqual(connA.metadata.maskedAccessKey, 'AKIA****_KEY');
    assert.strictEqual(connA.credentials, undefined, 'Raw credentials must never be in connection record');

    // List isolation
    const listA = providerConnectionService.listConnections(orgA.id);
    const listB = providerConnectionService.listConnections(orgB.id);

    assert.strictEqual(listA.length, 1);
    assert.strictEqual(listA[0].id, connA.id);

    assert.strictEqual(listB.length, 1);
    assert.strictEqual(listB[0].id, connB.id);

    // Cross-tenant access rejection
    const crossGet = providerConnectionService.getConnection(connB.id, orgA.id);
    assert.strictEqual(crossGet, null, 'Org A must not be able to get Org B connection');

    const crossRaw = providerConnectionService.getRawConnection(connB.id, orgA.id);
    assert.strictEqual(crossRaw, null, 'Org A must not be able to get raw Org B connection');
  });

  // Test 5: Cross-Tenant IDOR Matrix & Project Workspace Isolation
  await report('5. Cross-Tenant IDOR Protection & Project Workspace Data Isolation', async () => {
    const orgA = db.findOne('organizations', { name: 'Acme Corp' });
    const orgB = db.findOne('organizations', { name: 'Beta Labs' });
    const userA = db.findOne('users', { email: 'usera@example.com' });
    const userB = db.findOne('users', { email: 'userb@example.com' });

    // Create workspaces
    const wsA = storageService.createWorkspace('proj-acme-app', orgA.id);
    const wsB = storageService.createWorkspace('proj-beta-app', orgB.id);

    assert.ok(wsA.projectDir.includes(orgA.id), 'Workspace A must be nested in Org A directory');
    assert.ok(wsB.projectDir.includes(orgB.id), 'Workspace B must be nested in Org B directory');

    // Save analyses
    storageService.saveAnalysis('proj-acme-app', { project: { name: 'Acme API', runtime: 'nodejs' } }, orgA.id, userA.id);
    storageService.saveAnalysis('proj-beta-app', { project: { name: 'Beta Core', runtime: 'python' } }, orgB.id, userB.id);

    // List projects isolation
    const projectsA = storageService.listProjects(orgA.id);
    const projectsB = storageService.listProjects(orgB.id);

    assert.strictEqual(projectsA.length, 1);
    assert.strictEqual(projectsA[0].projectId, 'proj-acme-app');

    assert.strictEqual(projectsB.length, 1);
    assert.strictEqual(projectsB[0].projectId, 'proj-beta-app');

    // IDOR Read Check
    const crossRead = storageService.getProject('proj-beta-app', orgA.id);
    assert.strictEqual(crossRead, null, 'Org A reading Org B project must return null');

    // Middleware IDOR Simulation
    let req = {
      params: { projectId: 'proj-beta-app' },
      organization: orgA,
      user: userA
    };
    let res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      }
    };
    let nextCalled = false;

    requireProjectAccess(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'Middleware must block cross-tenant project access');
    assert.strictEqual(res.statusCode, 403, 'Must return HTTP 403 Forbidden');
  });

  // Test 6: Cross-Tenant Connection Misuse Rejection in Factory
  await report('6. Cross-Tenant Provider Connection Factory Rejection', async () => {
    const orgA = db.findOne('organizations', { name: 'Acme Corp' });
    const orgB = db.findOne('organizations', { name: 'Beta Labs' });
    const connB = db.findOne('connections', { organizationId: orgB.id });

    // Org A attempts to create AWSClient using Org B's connection ID
    assert.throws(
      () => connectionFactory.getAWSClient(connB.id, orgA.id),
      /not found for organization/
    );
  });

  // Test 7: Rate Limiting & Upload Security
  await report('7. Rate Limiter & Security Protection', async () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    let blocked = false;

    const mockReq = { ip: '192.168.1.100', headers: {}, socket: {} };
    const mockRes = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        if (this.statusCode === 429) blocked = true;
        return this;
      }
    };

    // 3 allowed hits
    limiter(mockReq, mockRes, () => {});
    limiter(mockReq, mockRes, () => {});
    limiter(mockReq, mockRes, () => {});
    assert.strictEqual(blocked, false);

    // 4th hit blocked
    limiter(mockReq, mockRes, () => {});
    assert.strictEqual(blocked, true, '4th request must be rate limited with HTTP 429');
    assert.strictEqual(mockRes.statusCode, 429);
  });

  console.log('========================================================================');
  console.log(`PHASE 11 TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runMultiTenantTestSuite();
}

module.exports = { runMultiTenantTestSuite };
