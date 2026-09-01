const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class SecretVault {
  constructor(masterKeyOverride) {
    this.algorithm = 'aes-256-gcm';
    this.key = this._resolveMasterKey(masterKeyOverride);
    this.storage = new Map(); // secretReference -> { encryptedData, iv, tag, createdAt }
    this._storageFilePath = path.resolve(process.cwd(), 'temporary/db/vault.json');
    this._loadVault();
  }

  _resolveMasterKey(keyOverride) {
    const rawKey = keyOverride || process.env.CLOUDOPS_MASTER_KEY || process.env.ENCRYPTION_KEY || 'cloudops-default-secure-master-key-32b!';
    // Ensure deterministic 32-byte key using SHA-256
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  _loadVault() {
    if (fs.existsSync(this._storageFilePath)) {
      try {
        const raw = fs.readFileSync(this._storageFilePath, 'utf8');
        const data = JSON.parse(raw);
        for (const [ref, record] of Object.entries(data)) {
          this.storage.set(ref, record);
        }
      } catch (err) {
        console.error('[SecretVault] Failed to load encrypted vault from disk:', err.message);
      }
    }
  }

  _persistVault() {
    try {
      const dir = path.dirname(this._storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj = Object.fromEntries(this.storage);
      fs.writeFileSync(this._storageFilePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('[SecretVault] Failed to persist vault to disk:', err.message);
    }
  }

  /**
   * Encrypts plaintext data and stores it in the vault under a unique reference ID
   * @param {string|object} secretValue 
   * @returns {string} secretReference ID
   */
  encrypt(secretValue) {
    if (secretValue === undefined || secretValue === null) {
      return null;
    }

    const plaintext = typeof secretValue === 'object' ? JSON.stringify(secretValue) : String(secretValue);
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const secretReference = `sec-${crypto.randomUUID()}`;
    const record = {
      secretReference,
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      tag: authTag,
      algorithm: this.algorithm,
      createdAt: new Date().toISOString()
    };

    this.storage.set(secretReference, record);
    this._persistVault();

    return secretReference;
  }

  /**
   * Decrypts a secret by reference ID
   * @param {string} secretReference 
   * @param {boolean} parseJson If true, parses JSON objects
   * @returns {string|object|null}
   */
  decrypt(secretReference, parseJson = false) {
    if (!secretReference || !this.storage.has(secretReference)) {
      return null;
    }

    const record = this.storage.get(secretReference);
    try {
      const iv = Buffer.from(record.iv, 'hex');
      const authTag = Buffer.from(record.tag, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(record.encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      if (parseJson) {
        try {
          return JSON.parse(decrypted);
        } catch {
          return decrypted;
        }
      }
      return decrypted;
    } catch (err) {
      console.error(`[SecretVault] Decryption failed for reference '${secretReference}':`, err.message);
      return null;
    }
  }

  /**
   * Deletes a secret from the vault
   */
  deleteSecret(secretReference) {
    if (this.storage.has(secretReference)) {
      this.storage.delete(secretReference);
      this._persistVault();
      return true;
    }
    return false;
  }

  /**
   * Clears all secrets in the vault (test utility)
   */
  clear() {
    this.storage.clear();
    this._persistVault();
  }
}

module.exports = new SecretVault();
module.exports.SecretVault = SecretVault;
