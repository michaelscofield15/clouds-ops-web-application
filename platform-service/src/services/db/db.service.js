const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DatabaseService {
  constructor(baseDirOverride) {
    this.baseDir = baseDirOverride || process.env.DB_BASE_DIR || path.resolve(process.cwd(), 'temporary/db');
    this.collections = new Map(); // collectionName -> Map<id, record>
    this.collectionNames = [
      'users',
      'organizations',
      'memberships',
      'projects',
      'deployments',
      'connections',
      'sessions',
      'audit_events',
      'docker_agents',
      'agent_pairings',
      'infrastructure_resources',
      'incidents'
    ];
    this.ensureBaseDir();
    this._loadAllCollections();
  }

  ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  _getCollectionFilePath(collectionName) {
    return path.join(this.baseDir, `${collectionName}.json`);
  }

  _loadAllCollections() {
    for (const name of this.collectionNames) {
      const map = new Map();
      const filePath = this._getCollectionFilePath(name);
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          for (const item of data) {
            if (item && item.id) {
              map.set(item.id, item);
            }
          }
        } catch (err) {
          console.error(`[DB] Error reading collection ${name}:`, err.message);
        }
      }
      this.collections.set(name, map);
    }
  }

  _persistCollection(collectionName) {
    const map = this.collections.get(collectionName);
    if (!map) return;
    try {
      this.ensureBaseDir();
      const list = Array.from(map.values());
      const targetPath = this._getCollectionFilePath(collectionName);
      fs.writeFileSync(targetPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error(`[DB] Error persisting collection ${collectionName}:`, err.message);
    }
  }

  _getMap(collectionName) {
    if (!this.collections.has(collectionName)) {
      this.collections.set(collectionName, new Map());
    }
    const map = this.collections.get(collectionName);
    const filePath = this._getCollectionFilePath(collectionName);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (!this._mtimes) this._mtimes = new Map();
        const lastMtime = this._mtimes.get(collectionName) || 0;
        if (stat.mtimeMs > lastMtime) {
          this._mtimes.set(collectionName, stat.mtimeMs);
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          map.clear();
          for (const item of data) {
            if (item && item.id) {
              map.set(item.id, item);
            }
          }
        }
      } catch {
        // Ignore
      }
    }
    return map;
  }

  /**
   * Inserts a record into a collection
   */
  insert(collectionName, record) {
    const map = this._getMap(collectionName);
    const id = record.id || `${collectionName.slice(0, 3)}-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const doc = {
      ...record,
      id,
      createdAt: record.createdAt || timestamp,
      updatedAt: timestamp
    };
    map.set(id, doc);
    this._persistCollection(collectionName);
    return { ...doc };
  }

  /**
   * Finds a record by ID
   */
  findById(collectionName, id) {
    const map = this._getMap(collectionName);
    const doc = map.get(id);
    return doc ? { ...doc } : null;
  }

  /**
   * Finds one record matching criteria predicate or query object
   */
  findOne(collectionName, query) {
    const map = this._getMap(collectionName);
    const predicate = typeof query === 'function'
      ? query
      : (item) => Object.entries(query).every(([k, v]) => item[k] === v);

    for (const item of map.values()) {
      if (predicate(item)) {
        return { ...item };
      }
    }
    return null;
  }

  /**
   * Finds all records matching criteria
   */
  find(collectionName, query = {}) {
    const map = this._getMap(collectionName);
    const predicate = typeof query === 'function'
      ? query
      : (item) => Object.entries(query).every(([k, v]) => item[k] === v);

    const results = [];
    for (const item of map.values()) {
      if (predicate(item)) {
        results.push({ ...item });
      }
    }
    return results;
  }

  /**
   * Updates a record by ID
   */
  update(collectionName, id, updates) {
    const map = this._getMap(collectionName);
    const existing = map.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...updates,
      id, // Preserve ID
      updatedAt: new Date().toISOString()
    };

    map.set(id, updated);
    this._persistCollection(collectionName);
    return { ...updated };
  }

  /**
   * Deletes a record by ID
   */
  delete(collectionName, id) {
    const map = this._getMap(collectionName);
    if (map.has(id)) {
      map.delete(id);
      this._persistCollection(collectionName);
      return true;
    }
    return false;
  }

  /**
   * Counts records matching query
   */
  count(collectionName, query = {}) {
    return this.find(collectionName, query).length;
  }

  /**
   * Clears all collections (for test isolation)
   */
  clearAll() {
    for (const name of this.collectionNames) {
      const map = this.collections.get(name);
      if (map) map.clear();
      const filePath = this._getCollectionFilePath(name);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore
        }
      }
    }
  }

  /**
   * Retrieves all deployments for a project, sorted by createdAt descending
   */
  findDeploymentsByProject(projectId) {
    const list = this.find('deployments', (d) => d.projectId === projectId);
    return list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  /**
   * Retrieves the currently active live deployment for a project
   */
  getLiveDeployment(projectId) {
    return this.findOne('deployments', (d) => d.projectId === projectId && d.isLive === true && d.status === 'SUCCESS');
  }
}

module.exports = new DatabaseService();
module.exports.DatabaseService = DatabaseService;
