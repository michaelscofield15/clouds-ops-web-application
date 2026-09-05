const config = require('../../config');

class MongoDBService {
  constructor() {
    this.client = null;
    this.db = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.uri = config.mongodb?.uri || process.env.MONGODB_URI || '';
    this.dbName = config.mongodb?.dbName || process.env.MONGODB_DB_NAME || 'cloudops';
  }

  /**
   * Initializes MongoDB connection if configured
   */
  async connect() {
    if (!this.uri) {
      // MongoDB not configured, will use internal document store
      return false;
    }

    if (this.isConnected && this.db) {
      return true;
    }

    if (this.isConnecting) {
      return false;
    }

    this.isConnecting = true;
    try {
      const { MongoClient } = require('mongodb');
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000
      });

      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.isConnected = true;
      this.isConnecting = false;
      console.log(`[MongoDB] Connected successfully to database '${this.dbName}'`);

      await this.ensureIndexes();
      return true;
    } catch (err) {
      this.isConnected = false;
      this.isConnecting = false;
      console.warn(`[MongoDB] Connection unavailable (${err.message}). Falling back to local document store.`);
      return false;
    }
  }

  /**
   * Ensures unique indexes on collections
   */
  async ensureIndexes() {
    if (!this.isConnected || !this.db) return;
    try {
      const usersCol = this.db.collection('users');
      await usersCol.createIndex({ email: 1 }, { unique: true });
      await usersCol.createIndex({ googleId: 1 }, { unique: true, sparse: true });
      await usersCol.createIndex({ id: 1 }, { unique: true });

      const sessionsCol = this.db.collection('sessions');
      await sessionsCol.createIndex({ tokenHash: 1 }, { unique: true });
      await sessionsCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

      const orgsCol = this.db.collection('organizations');
      await orgsCol.createIndex({ id: 1 }, { unique: true });

      const memCol = this.db.collection('memberships');
      await memCol.createIndex({ organizationId: 1, userId: 1 });

      const projectsCol = this.db.collection('projects');
      await projectsCol.createIndex({ id: 1 }, { unique: true });
      await projectsCol.createIndex({ organizationId: 1 });

      const deploymentsCol = this.db.collection('deployments');
      await deploymentsCol.createIndex({ id: 1 }, { unique: true });
      await deploymentsCol.createIndex({ projectId: 1 });

      const connectionsCol = this.db.collection('connections');
      await connectionsCol.createIndex({ id: 1 }, { unique: true });

      const auditCol = this.db.collection('audit_events');
      await auditCol.createIndex({ id: 1 }, { unique: true });

      console.log('[MongoDB] Unique and lookup indexes ensured on all collections');
    } catch (err) {
      console.warn('[MongoDB] Index creation warning:', err.message);
    }
  }

  /**
   * Checks if MongoDB is currently connected and responsive
   */
  async isAvailable() {
    if (!this.isConnected || !this.client || !this.db) {
      if (this.uri && !this.isConnecting) {
        return await this.connect();
      }
      return false;
    }

    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch (err) {
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Generic CRUD operations on any collection
   */
  async insertRecord(collectionName, record) {
    if (!collectionName || !record || !(await this.isAvailable())) return null;
    try {
      const doc = {
        ...record,
        id: record.id,
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this.db.collection(collectionName).updateOne(
        { id: doc.id },
        { $set: doc },
        { upsert: true }
      );
      return this._formatDoc(doc);
    } catch (err) {
      console.error(`[MongoDB] insertRecord(${collectionName}) error:`, err.message);
      return null;
    }
  }

  async findRecordById(collectionName, id) {
    if (!collectionName || !id || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection(collectionName).findOne({ id });
      return doc ? this._formatDoc(doc) : null;
    } catch (err) {
      return null;
    }
  }

  async findRecords(collectionName, query = {}) {
    if (!collectionName || !(await this.isAvailable())) return [];
    try {
      const mongoQuery = typeof query === 'object' && query !== null ? query : {};
      const docs = await this.db.collection(collectionName).find(mongoQuery).toArray();
      return docs.map(d => this._formatDoc(d));
    } catch (err) {
      return [];
    }
  }

  async updateRecord(collectionName, id, updates) {
    if (!collectionName || !id || !(await this.isAvailable())) return null;
    try {
      const { _id, id: docId, ...cleanUpdates } = updates;
      cleanUpdates.updatedAt = new Date().toISOString();
      const res = await this.db.collection(collectionName).findOneAndUpdate(
        { id },
        { $set: cleanUpdates },
        { returnDocument: 'after' }
      );
      const updatedDoc = res?.value || res;
      return updatedDoc ? this._formatDoc(updatedDoc) : null;
    } catch (err) {
      console.error(`[MongoDB] updateRecord(${collectionName}) error:`, err.message);
      return null;
    }
  }

  async deleteRecord(collectionName, id) {
    if (!collectionName || !id || !(await this.isAvailable())) return false;
    try {
      await this.db.collection(collectionName).deleteOne({ id });
      return true;
    } catch {
      return false;
    }
  }

  async loadCollectionData(collectionName) {
    if (!collectionName || !(await this.isAvailable())) return [];
    try {
      const docs = await this.db.collection(collectionName).find({}).toArray();
      return docs.map(d => this._formatDoc(d));
    } catch {
      return [];
    }
  }

  /**
   * Finds user by Google Subject ID
   */
  async findUserByGoogleId(googleId) {
    if (!googleId || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection('users').findOne({ googleId });
      return doc ? this._formatDoc(doc) : null;
    } catch (err) {
      console.error('[MongoDB] findUserByGoogleId error:', err.message);
      return null;
    }
  }

  /**
   * Finds user by email
   */
  async findUserByEmail(email) {
    if (!email || !(await this.isAvailable())) return null;
    try {
      const normalized = email.trim().toLowerCase();
      const doc = await this.db.collection('users').findOne({ email: normalized });
      return doc ? this._formatDoc(doc) : null;
    } catch (err) {
      console.error('[MongoDB] findUserByEmail error:', err.message);
      return null;
    }
  }

  /**
   * Finds user by CloudOps ID
   */
  async findUserById(id) {
    if (!id || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection('users').findOne({ id });
      return doc ? this._formatDoc(doc) : null;
    } catch (err) {
      console.error('[MongoDB] findUserById error:', err.message);
      return null;
    }
  }

  /**
   * Inserts a user into MongoDB
   */
  async createUser(userData) {
    if (!(await this.isAvailable())) return null;
    try {
      const doc = {
        ...userData,
        email: userData.email?.toLowerCase(),
        createdAt: userData.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this.db.collection('users').insertOne(doc);
      return this._formatDoc(doc);
    } catch (err) {
      console.error('[MongoDB] createUser error:', err.message);
      throw err;
    }
  }

  /**
   * Updates a user by CloudOps ID
   */
  async updateUser(id, updates) {
    if (!id || !(await this.isAvailable())) return null;
    try {
      const { _id, id: docId, ...cleanUpdates } = updates;
      cleanUpdates.updatedAt = new Date().toISOString();

      const res = await this.db.collection('users').findOneAndUpdate(
        { id },
        { $set: cleanUpdates },
        { returnDocument: 'after' }
      );
      const updatedDoc = res?.value || res;
      return updatedDoc ? this._formatDoc(updatedDoc) : null;
    } catch (err) {
      console.error('[MongoDB] updateUser error:', err.message);
      return null;
    }
  }

  /**
   * Sessions, Organizations, Memberships in MongoDB
   */
  async createSession(sessionDoc) {
    if (!(await this.isAvailable())) return null;
    try {
      await this.db.collection('sessions').updateOne(
        { tokenHash: sessionDoc.tokenHash },
        { $set: sessionDoc },
        { upsert: true }
      );
      return this._formatDoc(sessionDoc);
    } catch (err) {
      console.error('[MongoDB] createSession error:', err.message);
      return null;
    }
  }

  async findSessionByTokenHash(tokenHash) {
    if (!tokenHash || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection('sessions').findOne({ tokenHash });
      return doc ? this._formatDoc(doc) : null;
    } catch (err) {
      return null;
    }
  }

  async deleteSession(tokenHash) {
    if (!tokenHash || !(await this.isAvailable())) return false;
    try {
      await this.db.collection('sessions').deleteOne({ tokenHash });
      return true;
    } catch {
      return false;
    }
  }

  async findOrganizationById(id) {
    if (!id || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection('organizations').findOne({ id });
      return doc ? this._formatDoc(doc) : null;
    } catch {
      return null;
    }
  }

  async createOrganization(orgDoc) {
    if (!(await this.isAvailable())) return null;
    try {
      await this.db.collection('organizations').updateOne(
        { id: orgDoc.id },
        { $set: orgDoc },
        { upsert: true }
      );
      return this._formatDoc(orgDoc);
    } catch {
      return null;
    }
  }

  async findMembership(organizationId, userId) {
    if (!organizationId || !userId || !(await this.isAvailable())) return null;
    try {
      const doc = await this.db.collection('memberships').findOne({ organizationId, userId });
      return doc ? this._formatDoc(doc) : null;
    } catch {
      return null;
    }
  }

  async createMembership(memDoc) {
    if (!(await this.isAvailable())) return null;
    try {
      await this.db.collection('memberships').updateOne(
        { id: memDoc.id || `${memDoc.organizationId}:${memDoc.userId}` },
        { $set: memDoc },
        { upsert: true }
      );
      return this._formatDoc(memDoc);
    } catch {
      return null;
    }
  }

  _formatDoc(doc) {
    if (!doc) return null;
    const { _id, ...safe } = doc;
    return safe;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.isConnected = false;
      this.db = null;
    }
  }
}

module.exports = new MongoDBService();
module.exports.MongoDBService = MongoDBService;
