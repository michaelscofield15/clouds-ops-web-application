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
   * Ensures unique indexes on users collection
   */
  async ensureIndexes() {
    if (!this.isConnected || !this.db) return;
    try {
      const usersCol = this.db.collection('users');
      await usersCol.createIndex({ email: 1 }, { unique: true });
      await usersCol.createIndex({ googleId: 1 }, { unique: true, sparse: true });
      console.log('[MongoDB] Unique indexes ensured on users collection (email, googleId)');
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
