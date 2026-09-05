const crypto = require('crypto');
const db = require('../db/db.service');
const mongodbService = require('../db/mongodb.service');
const googleService = require('./google.service');
const auditService = require('../audit.service');

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class AuthService {
  /**
   * Hashes a password with a cryptographically secure random salt using scrypt
   */
  hashPassword(password, saltOverride) {
    const salt = saltOverride || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
  }

  /**
   * Verifies password against stored hash using timing-safe comparison
   */
  verifyPassword(password, storedHash, salt) {
    if (!password || !storedHash || !salt) return false;
    const { hash } = this.hashPassword(password, salt);
    try {
      const hashBuf = Buffer.from(hash, 'hex');
      const storedBuf = Buffer.from(storedHash, 'hex');
      if (hashBuf.length !== storedBuf.length) return false;
      return crypto.timingSafeEqual(hashBuf, storedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Validates password strength policy
   */
  validatePasswordPolicy(password) {
    if (!password || typeof password !== 'string') {
      return { valid: false, message: 'Password is required' };
    }
    if (password.length < 8) {
      return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    return { valid: true };
  }

  /**
   * Validates and normalizes email address
   */
  normalizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return email.trim().toLowerCase();
  }

  /**
   * Hashes a raw session token for secure DB storage
   */
  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Sanitizes a user object before returning to client (removes hashes/salts)
   */
  sanitizeUser(user) {
    if (!user) return null;
    const { passwordHash, salt, ...safeUser } = user;
    return safeUser;
  }

  /**
   * Registers a new user, creates their primary organization, and logs them in
   */
  async signup({ email, password, name, organizationName }) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Valid email address is required');
    }

    const policy = this.validatePasswordPolicy(password);
    if (!policy.valid) {
      throw new Error(policy.message);
    }

    // Check for duplicate email
    let existing = db.findOne('users', { email: normalizedEmail });
    if (!existing && (await mongodbService.isAvailable())) {
      existing = await mongodbService.findUserByEmail(normalizedEmail);
    }
    if (existing) {
      throw new Error('An account with this email address already exists');
    }

    const displayName = (name && name.trim()) || normalizedEmail.split('@')[0];
    const { hash, salt } = this.hashPassword(password);

    // 1. Create User
    const userId = `usr-${crypto.randomUUID()}`;
    const userDoc = {
      id: userId,
      email: normalizedEmail,
      name: displayName,
      passwordHash: hash,
      salt,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };
    const user = db.insert('users', userDoc);
    if (await mongodbService.isAvailable()) {
      await mongodbService.createUser(userDoc).catch(() => {});
    }

    // 2. Create Organization
    const orgId = `org-${crypto.randomUUID()}`;
    const orgDisplayName = (organizationName && organizationName.trim()) || `${displayName}'s Workspace`;
    const slug = orgDisplayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `org-${userId.slice(4, 12)}`;
    
    const organization = db.insert('organizations', {
      id: orgId,
      name: orgDisplayName,
      slug: `${slug}-${Date.now().toString(36)}`,
      createdByUserId: userId
    });

    // 3. Create Membership with OWNER role
    const membership = db.insert('memberships', {
      organizationId: orgId,
      userId,
      role: 'OWNER'
    });

    // 4. Generate Session Token
    const session = await this.createSession(userId, orgId);

    auditService.log('system', 'USER_SIGNUP', 'SUCCESS', {
      organizationId: orgId,
      userId,
      email: normalizedEmail
    });

    return {
      user: this.sanitizeUser(user),
      organization,
      membership,
      token: session.rawToken,
      expiresAt: session.expiresAt
    };
  }

  /**
   * Authenticates user with email and password
   */
  async login({ email, password, organizationId }) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !password) {
      throw new Error('Email and password are required');
    }

    let user = db.findOne('users', { email: normalizedEmail });
    if (!user && (await mongodbService.isAvailable())) {
      user = await mongodbService.findUserByEmail(normalizedEmail);
      if (user) {
        db._getMap('users').set(user.id, user);
      }
    }

    if (!user) {
      throw new Error('Invalid email or password');
    }

    const isValid = this.verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      throw new Error('Invalid email or password');
    }

    if (user.status !== 'ACTIVE') {
      throw new Error('Account is inactive or suspended');
    }

    // Update last login timestamp
    const now = new Date().toISOString();
    db.update('users', user.id, { lastLoginAt: now });
    if (await mongodbService.isAvailable()) {
      await mongodbService.updateUser(user.id, { lastLoginAt: now });
    }

    // Resolve user's organization
    let targetOrgId = organizationId;
    if (!targetOrgId) {
      let firstMembership = db.findOne('memberships', { userId: user.id });
      if (!firstMembership && (await mongodbService.isAvailable())) {
        const mems = await mongodbService.findRecords('memberships', { userId: user.id });
        if (mems.length > 0) firstMembership = mems[0];
      }
      if (firstMembership) {
        targetOrgId = firstMembership.organizationId;
      }
    }

    let organization = null;
    let membership = null;

    if (targetOrgId) {
      organization = db.findById('organizations', targetOrgId);
      if (!organization && (await mongodbService.isAvailable())) {
        organization = await mongodbService.findOrganizationById(targetOrgId);
      }
      membership = db.findOne('memberships', { organizationId: targetOrgId, userId: user.id });
      if (!membership && (await mongodbService.isAvailable())) {
        membership = await mongodbService.findMembership(targetOrgId, user.id);
      }
    }

    // If no org found, create a personal workspace
    if (!organization) {
      const orgId = `org-${crypto.randomUUID()}`;
      organization = db.insert('organizations', {
        id: orgId,
        name: `${user.name}'s Workspace`,
        slug: `workspace-${user.id.slice(4, 12)}`,
        createdByUserId: user.id
      });
      membership = db.insert('memberships', {
        organizationId: orgId,
        userId: user.id,
        role: 'OWNER'
      });
      targetOrgId = orgId;
    }

    const session = await this.createSession(user.id, targetOrgId);

    auditService.log('system', 'USER_LOGIN', 'SUCCESS', {
      organizationId: targetOrgId,
      userId: user.id,
      email: normalizedEmail
    });

    return {
      user: this.sanitizeUser(user),
      organization,
      membership,
      token: session.rawToken,
      expiresAt: session.expiresAt
    };
  }

  /**
   * Authenticates user via Google OAuth2 / OpenID Connect ID token or auth code
   */
  async authenticateWithGoogle({ idToken, code }) {
    if (!idToken && !code) {
      throw new Error('Google authentication credential (idToken or code) is required');
    }

    // 1. Verify Google identity via official google-auth-library
    let profile;
    if (idToken) {
      profile = await googleService.verifyIdToken(idToken);
    } else {
      profile = await googleService.exchangeCode(code);
    }

    const normalizedEmail = this.normalizeEmail(profile.email);
    if (!normalizedEmail) {
      throw new Error('Verified email address is required from Google account');
    }

    const now = new Date().toISOString();
    let user = null;

    // 2. Query MongoDB first (if available)
    if (await mongodbService.isAvailable()) {
      user = await mongodbService.findUserByGoogleId(profile.googleId);
      if (!user) {
        user = await mongodbService.findUserByEmail(normalizedEmail);
      }
    }

    // 3. Check local database store (or fallback)
    if (!user) {
      user = db.findOne('users', { googleId: profile.googleId }) || db.findOne('users', { email: normalizedEmail });
    }

    if (user) {
      // Existing User: Update profile and link Google identity if not already linked
      const updates = {
        lastLoginAt: now,
        googleId: profile.googleId,
        provider: user.provider || 'google',
        emailVerified: true
      };
      if (profile.avatar && !user.avatar) {
        updates.avatar = profile.avatar;
      }
      if (profile.name && (!user.name || user.name === user.email)) {
        updates.name = profile.name;
      }

      // Update in MongoDB
      if (await mongodbService.isAvailable()) {
        const mongoUpdated = await mongodbService.updateUser(user.id, updates);
        if (mongoUpdated) user = mongoUpdated;
      }

      // Update in local DB store
      const localUpdated = db.update('users', user.id, updates);
      if (localUpdated) user = { ...user, ...localUpdated };
    } else {
      // New User: Create in MongoDB and local store
      const userId = `usr-${crypto.randomUUID()}`;
      const newUserDoc = {
        id: userId,
        email: normalizedEmail,
        name: profile.name || normalizedEmail.split('@')[0],
        provider: 'google',
        googleId: profile.googleId,
        emailVerified: true,
        avatar: profile.avatar || null,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now
      };

      // Persist to MongoDB if available
      if (await mongodbService.isAvailable()) {
        try {
          await mongodbService.createUser(newUserDoc);
        } catch (mErr) {
          console.warn('[AuthService] MongoDB insert warning:', mErr.message);
        }
      }

      // Persist to local DB store
      user = db.insert('users', newUserDoc);
    }

    if (user.status !== 'ACTIVE') {
      throw new Error('This account is inactive or suspended');
    }

    // 4. Resolve or Create User's Organization / Workspace
    let targetOrgId = null;
    const firstMembership = db.findOne('memberships', { userId: user.id });
    if (firstMembership) {
      targetOrgId = firstMembership.organizationId;
    }

    let organization = null;
    let membership = null;

    if (targetOrgId) {
      organization = db.findById('organizations', targetOrgId);
      membership = db.findOne('memberships', { organizationId: targetOrgId, userId: user.id });
    }

    if (!organization) {
      const orgId = `org-${crypto.randomUUID()}`;
      const orgName = `${user.name || 'Developer'}'s Workspace`;
      organization = db.insert('organizations', {
        id: orgId,
        name: orgName,
        slug: `workspace-${user.id.slice(4, 12)}`,
        createdByUserId: user.id
      });
      membership = db.insert('memberships', {
        organizationId: orgId,
        userId: user.id,
        role: 'OWNER'
      });
      targetOrgId = orgId;
    }

    // 5. Create Application Session
    const session = await this.createSession(user.id, targetOrgId);

    auditService.log('system', 'USER_GOOGLE_LOGIN', 'SUCCESS', {
      organizationId: targetOrgId,
      userId: user.id,
      email: normalizedEmail,
      googleId: profile.googleId
    });

    return {
      user: this.sanitizeUser(user),
      organization,
      membership,
      token: session.rawToken,
      expiresAt: session.expiresAt
    };
  }

  /**
   * Creates a cryptographically random session token for user in an organization
   */
  async createSession(userId, organizationId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    const sessionDoc = {
      tokenHash,
      userId,
      organizationId,
      expiresAt
    };

    // Save in local DB
    db.insert('sessions', sessionDoc);

    // Save in MongoDB if available
    if (await mongodbService.isAvailable()) {
      await mongodbService.createSession(sessionDoc);
    }

    return { rawToken, expiresAt };
  }

  /**
   * Authenticates a raw bearer token or cookie token
   */
  async authenticateToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      return null;
    }

    const cleanToken = rawToken.trim();

    // Check if token is an Agent token (e.g. agtok_...)
    if (cleanToken.startsWith('agtok_')) {
      const agent = db.findOne('docker_agents', { agentToken: cleanToken });
      if (!agent) return null;
      const organization = db.findById('organizations', agent.organizationId) || { id: agent.organizationId, name: 'Agent Workspace' };
      return {
        user: { id: agent.userId || 'usr-agent', email: 'agent@cloudops.internal', name: 'Docker Agent' },
        organization,
        membership: { role: 'AGENT', organizationId: organization.id },
        sessionId: `agent-session-${agent.id}`
      };
    }

    const tokenHash = this.hashToken(cleanToken);
    let session = db.findOne('sessions', { tokenHash });

    // Check MongoDB for session if not in local store
    if (!session && (await mongodbService.isAvailable())) {
      session = await mongodbService.findSessionByTokenHash(tokenHash);
    }

    if (!session) {
      return null;
    }

    // Check expiration
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      if (session.id) db.delete('sessions', session.id);
      if (await mongodbService.isAvailable()) {
        await mongodbService.deleteSession(tokenHash);
      }
      return null;
    }

    let user = db.findById('users', session.userId);
    if (!user && (await mongodbService.isAvailable())) {
      user = await mongodbService.findUserById(session.userId);
    }

    if (!user || user.status !== 'ACTIVE') {
      return null;
    }

    let organization = db.findById('organizations', session.organizationId);
    if (!organization && (await mongodbService.isAvailable())) {
      organization = await mongodbService.findOrganizationById(session.organizationId);
    }

    let membership = db.findOne('memberships', {
      organizationId: session.organizationId,
      userId: user.id
    });
    if (!membership && (await mongodbService.isAvailable())) {
      membership = await mongodbService.findMembership(session.organizationId, user.id);
    }

    return {
      user: this.sanitizeUser(user),
      organization: organization || { id: session.organizationId, name: 'Default Workspace' },
      membership: membership || { role: 'MEMBER' },
      sessionId: session.id || session.tokenHash
    };
  }

  /**
   * Revokes a session token on logout
   */
  async revokeToken(rawToken) {
    if (!rawToken) return false;
    const tokenHash = this.hashToken(rawToken.trim());
    let revoked = false;

    const session = db.findOne('sessions', { tokenHash });
    if (session) {
      db.delete('sessions', session.id);
      revoked = true;
    }

    if (await mongodbService.isAvailable()) {
      const mRevoked = await mongodbService.deleteSession(tokenHash);
      if (mRevoked) revoked = true;
    }

    return revoked;
  }
}

module.exports = new AuthService();
module.exports.AuthService = AuthService;
