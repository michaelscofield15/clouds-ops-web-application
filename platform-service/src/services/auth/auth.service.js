const crypto = require('crypto');
const db = require('../db/db.service');
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
    const existing = db.findOne('users', { email: normalizedEmail });
    if (existing) {
      throw new Error('An account with this email address already exists');
    }

    const displayName = (name && name.trim()) || normalizedEmail.split('@')[0];
    const { hash, salt } = this.hashPassword(password);

    // 1. Create User
    const userId = `usr-${crypto.randomUUID()}`;
    const user = db.insert('users', {
      id: userId,
      email: normalizedEmail,
      name: displayName,
      passwordHash: hash,
      salt,
      status: 'ACTIVE'
    });

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

    const user = db.findOne('users', { email: normalizedEmail });
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

    // Resolve user's organization
    let targetOrgId = organizationId;
    if (!targetOrgId) {
      const firstMembership = db.findOne('memberships', { userId: user.id });
      if (firstMembership) {
        targetOrgId = firstMembership.organizationId;
      }
    }

    let organization = null;
    let membership = null;

    if (targetOrgId) {
      organization = db.findById('organizations', targetOrgId);
      membership = db.findOne('memberships', { organizationId: targetOrgId, userId: user.id });
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
   * Creates a cryptographically random session token for user in an organization
   */
  async createSession(userId, organizationId) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    db.insert('sessions', {
      tokenHash,
      userId,
      organizationId,
      expiresAt
    });

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
    const session = db.findOne('sessions', { tokenHash });
    if (!session) {
      return null;
    }

    // Check expiration
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      db.delete('sessions', session.id);
      return null;
    }

    const user = db.findById('users', session.userId);
    if (!user || user.status !== 'ACTIVE') {
      return null;
    }

    const organization = db.findById('organizations', session.organizationId);
    const membership = db.findOne('memberships', {
      organizationId: session.organizationId,
      userId: user.id
    });

    return {
      user: this.sanitizeUser(user),
      organization: organization || { id: session.organizationId, name: 'Default Workspace' },
      membership: membership || { role: 'MEMBER' },
      sessionId: session.id
    };
  }

  /**
   * Revokes a session token on logout
   */
  async revokeToken(rawToken) {
    if (!rawToken) return false;
    const tokenHash = this.hashToken(rawToken.trim());
    const session = db.findOne('sessions', { tokenHash });
    if (session) {
      db.delete('sessions', session.id);
      return true;
    }
    return false;
  }
}

module.exports = new AuthService();
module.exports.AuthService = AuthService;
