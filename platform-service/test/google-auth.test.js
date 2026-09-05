const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/services/db/db.service');
const mongodbService = require('../src/services/db/mongodb.service');
const authService = require('../src/services/auth/auth.service');
const googleService = require('../src/services/auth/google.service');

async function runGoogleAuthTestSuite() {
  console.log('========================================================================');
  console.log('GOOGLE AUTHENTICATION & MONGODB STORAGE TEST SUITE');
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

  // Clear DB
  db.clearAll();

  // Test 1: Google Service Configuration & Methods
  await report('1. Google Auth Service configuration and authorization URL', async () => {
    assert.strictEqual(typeof googleService.isConfigured, 'function');
    assert.strictEqual(typeof googleService.getClientId, 'function');
    assert.strictEqual(typeof googleService.verifyIdToken, 'function');
    assert.strictEqual(typeof googleService.exchangeCode, 'function');

    // Reject missing token
    await assert.rejects(
      async () => googleService.verifyIdToken(''),
      /Missing Google ID token/
    );

    await assert.rejects(
      async () => googleService.exchangeCode(''),
      /Missing Google authorization code/
    );
  });

  // Test 2: MongoDB Service Offline Fallback & Unique Index Integrity
  await report('2. MongoDB Service offline fallback and resilience', async () => {
    // When MongoDB is offline/unreachable, isAvailable should return false without crashing
    const available = await mongodbService.isAvailable();
    assert.strictEqual(typeof available, 'boolean');

    // Searching an offline MongoDB should gracefully return null
    const user = await mongodbService.findUserByGoogleId('some-google-id');
    assert.strictEqual(user, null);
  });

  // Test 3: New Google User Registration & Organization Provisioning
  await report('3. New Google User Signup, MongoDB/DB persistence, and Session Creation', async () => {
    const mockGoogleId = 'google-sub-10001';
    const mockEmail = 'newgoogleuser@example.com';
    const mockName = 'New Google User';
    const mockAvatar = 'https://lh3.googleusercontent.com/a/mockavatar';

    // Mock verifyIdToken for testing
    const originalVerify = googleService.verifyIdToken.bind(googleService);
    googleService.verifyIdToken = async () => ({
      googleId: mockGoogleId,
      email: mockEmail,
      emailVerified: true,
      name: mockName,
      avatar: mockAvatar
    });

    try {
      const authResult = await authService.authenticateWithGoogle({ idToken: 'valid-mock-token' });

      assert.ok(authResult.user, 'User object should be returned');
      assert.strictEqual(authResult.user.email, mockEmail);
      assert.strictEqual(authResult.user.name, mockName);
      assert.strictEqual(authResult.user.provider, 'google');
      assert.strictEqual(authResult.user.googleId, mockGoogleId);
      assert.strictEqual(authResult.user.emailVerified, true);
      assert.strictEqual(authResult.user.avatar, mockAvatar);
      assert.strictEqual(authResult.user.passwordHash, undefined, 'Google user must never have a password stored');

      assert.ok(authResult.organization, 'Organization should be automatically provisioned');
      assert.ok(authResult.membership, 'Membership should be created');
      assert.strictEqual(authResult.membership.role, 'OWNER');

      assert.ok(authResult.token, 'Session token should be returned');

      // Verify user document actually exists in database
      const storedUser = db.findOne('users', { googleId: mockGoogleId });
      assert.ok(storedUser, 'User document must be persisted in DB');
      assert.strictEqual(storedUser.email, mockEmail);

      // Verify token can authenticate
      const authContext = await authService.authenticateToken(authResult.token);
      assert.ok(authContext, 'Session token must be valid');
      assert.strictEqual(authContext.user.id, storedUser.id);
    } finally {
      googleService.verifyIdToken = originalVerify;
    }
  });

  // Test 4: Returning Google User Login (Deduplication Check)
  await report('4. Returning Google User Login - No duplicate accounts created', async () => {
    const mockGoogleId = 'google-sub-10001';
    const mockEmail = 'newgoogleuser@example.com';

    const userCountBefore = db.count('users');

    const originalVerify = googleService.verifyIdToken.bind(googleService);
    googleService.verifyIdToken = async () => ({
      googleId: mockGoogleId,
      email: mockEmail,
      emailVerified: true,
      name: 'Updated Name',
      avatar: 'https://lh3.googleusercontent.com/a/mockavatar-updated'
    });

    try {
      const authResult = await authService.authenticateWithGoogle({ idToken: 'valid-mock-token' });

      const userCountAfter = db.count('users');
      assert.strictEqual(userCountAfter, userCountBefore, 'Returning Google user must NOT create a duplicate user record');

      assert.strictEqual(authResult.user.email, mockEmail);
      assert.strictEqual(authResult.user.googleId, mockGoogleId);

      // Verify lastLoginAt was updated
      const updatedUser = db.findOne('users', { googleId: mockGoogleId });
      assert.ok(updatedUser.lastLoginAt, 'lastLoginAt must be recorded');
    } finally {
      googleService.verifyIdToken = originalVerify;
    }
  });

  // Test 5: Account Linking (Existing Email/Password User links Google identity)
  await report('5. Account Linking - Linking Google Identity to Existing Local Email User', async () => {
    const existingEmail = 'localuser@example.com';
    const localSignup = await authService.signup({
      email: existingEmail,
      password: 'Password123!',
      name: 'Local User',
      organizationName: 'Local Workspace'
    });

    assert.ok(localSignup.user.id);
    const initialUserCount = db.count('users');

    // User signs in with Google using the same verified email
    const googleSubForLocal = 'google-sub-local-999';
    const originalVerify = googleService.verifyIdToken.bind(googleService);
    googleService.verifyIdToken = async () => ({
      googleId: googleSubForLocal,
      email: existingEmail,
      emailVerified: true,
      name: 'Local User Google',
      avatar: 'https://lh3.googleusercontent.com/a/google-avatar'
    });

    try {
      const authResult = await authService.authenticateWithGoogle({ idToken: 'mock-token' });

      // Count of users must remain the exact same (no duplicate created!)
      assert.strictEqual(db.count('users'), initialUserCount, 'Account linking must NOT create duplicate accounts');

      // User ID must match existing local user ID
      assert.strictEqual(authResult.user.id, localSignup.user.id, 'Must link to existing user ID');
      assert.strictEqual(authResult.user.googleId, googleSubForLocal, 'Google ID must be linked');
      assert.strictEqual(authResult.user.emailVerified, true);

      // User can still authenticate with their session
      const authCtx = await authService.authenticateToken(authResult.token);
      assert.strictEqual(authCtx.user.id, localSignup.user.id);
    } finally {
      googleService.verifyIdToken = originalVerify;
    }
  });

  // Test 6: Logout Revocation
  await report('6. Logout and Session Invalidation for Google Authenticated Session', async () => {
    const originalVerify = googleService.verifyIdToken.bind(googleService);
    googleService.verifyIdToken = async () => ({
      googleId: 'google-sub-logout-test',
      email: 'logoutuser@example.com',
      emailVerified: true,
      name: 'Logout Test User'
    });

    try {
      const authResult = await authService.authenticateWithGoogle({ idToken: 'token' });
      assert.ok(authResult.token);

      // Valid before logout
      let ctx = await authService.authenticateToken(authResult.token);
      assert.ok(ctx);

      // Revoke token on logout
      const revoked = await authService.revokeToken(authResult.token);
      assert.strictEqual(revoked, true);

      // Invalid after logout
      ctx = await authService.authenticateToken(authResult.token);
      assert.strictEqual(ctx, null, 'Session must be invalid after logout');
    } finally {
      googleService.verifyIdToken = originalVerify;
    }
  });

  // Test 7: Duplicate User Race Condition Prevention
  await report('7. Unique Constraints in DB Layer prevent duplicate user race conditions', async () => {
    // Attempting to insert a second user with the same email directly into DB should throw
    assert.throws(() => {
      db.insert('users', {
        id: 'usr-duplicate-test',
        email: 'newgoogleuser@example.com',
        name: 'Duplicate Attempt'
      });
    }, /Unique constraint violation/);

    // Attempting to insert with duplicate googleId should throw
    assert.throws(() => {
      db.insert('users', {
        id: 'usr-duplicate-test-2',
        email: 'another@example.com',
        googleId: 'google-sub-10001'
      });
    }, /Unique constraint violation/);
  });

  console.log('========================================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================');

  await mongodbService.close();

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runGoogleAuthTestSuite().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
  });
}

module.exports = runGoogleAuthTestSuite;
