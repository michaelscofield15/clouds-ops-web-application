const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB
const DANGEROUS_EXTENSIONS = ['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.vbs'];

class ZipService {
  /**
   * Calculates cryptographic SHA-256 checksum of a buffer for upload audit integrity
   */
  calculateChecksum(buffer) {
    if (!buffer) return '';
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Validates if buffer starts with standard ZIP magic bytes (PK\x03\x04 or PK\x05\x06)
   */
  isValidZipBuffer(buffer) {
    if (!buffer || buffer.length < 4) {
      return false;
    }
    // Check standard PK signature: 0x50, 0x4B
    return buffer[0] === 0x50 && buffer[1] === 0x4B;
  }

  /**
   * Safely extracts a ZIP buffer into a target directory with Zip Slip protection
   * @param {Buffer} zipBuffer 
   * @param {string} destinationDir 
   * @returns {{ effectiveProjectRoot: string, checksum: string, fileCount: number, totalBytes: number }}
   */
  extractSafely(zipBuffer, destinationDir) {
    if (!zipBuffer || zipBuffer.length === 0) {
      throw new Error('Archive is empty');
    }

    if (zipBuffer.length > MAX_ZIP_BYTES) {
      throw new Error(`Archive exceeds maximum allowable size of ${MAX_ZIP_BYTES / (1024 * 1024)}MB`);
    }

    if (!this.isValidZipBuffer(zipBuffer)) {
      throw new Error('Invalid archive format: ZIP header signature missing');
    }

    const checksum = this.calculateChecksum(zipBuffer);
    const resolvedDestination = path.resolve(destinationDir);

    let zip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new Error(`Malformed ZIP archive: ${err.message}`);
    }

    const zipEntries = zip.getEntries();
    if (!zipEntries || zipEntries.length === 0) {
      throw new Error('ZIP archive contains no entries');
    }

    let totalUncompressedBytes = 0;
    let fileCount = 0;

    // Pass 1: Security Inspection for Zip Slip, dangerous extensions, and absolute paths
    for (const entry of zipEntries) {
      const rawName = entry.entryName;

      // Skip macOS resource fork metadata
      if (rawName.startsWith('__MACOSX/')) {
        continue;
      }

      // Disallow absolute paths in archive entries
      if (path.isAbsolute(rawName) || /^[a-zA-Z]:[\\/]/.test(rawName)) {
        throw new Error(`Dangerous archive structure: absolute path '${rawName}' detected`);
      }

      // Check path traversal
      const targetPath = path.resolve(resolvedDestination, rawName);
      if (!targetPath.startsWith(resolvedDestination + path.sep) && targetPath !== resolvedDestination) {
        throw new Error(`Zip Slip path traversal attack detected in entry '${rawName}'`);
      }

      // Check dangerous extensions at root level
      const ext = path.extname(rawName).toLowerCase();
      if (!entry.isDirectory && DANGEROUS_EXTENSIONS.includes(ext) && !rawName.includes('/')) {
        throw new Error(`Dangerous executable file '${rawName}' blocked by security gate`);
      }

      if (!entry.isDirectory) {
        totalUncompressedBytes += entry.header.size || 0;
        fileCount++;
      }
    }

    // Pass 2: Extract files safely
    for (const entry of zipEntries) {
      const rawName = entry.entryName;
      if (rawName.startsWith('__MACOSX/')) {
        continue;
      }

      const targetPath = path.resolve(resolvedDestination, rawName);

      if (entry.isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true });
      } else {
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const content = entry.getData();
        fs.writeFileSync(targetPath, content);
      }
    }

    // Determine the effective project root
    const effectiveProjectRoot = this.findEffectiveProjectRoot(resolvedDestination);

    return {
      effectiveProjectRoot,
      checksum,
      fileCount,
      totalBytes: totalUncompressedBytes
    };
  }

  /**
   * If the ZIP extracted all files into a single root folder (e.g. `cloudops-demo-app/`),
   * resolve to that folder if package.json or source files reside there.
   */
  findEffectiveProjectRoot(baseDir) {
    const items = fs.readdirSync(baseDir).filter((item) => !item.startsWith('.') && item !== '__MACOSX');

    if (items.length === 1) {
      const candidatePath = path.join(baseDir, items[0]);
      if (fs.statSync(candidatePath).isDirectory()) {
        const subItems = fs.readdirSync(candidatePath);
        // If the single subfolder contains code files, use it as the root
        if (subItems.some((file) => ['package.json', 'requirements.txt', 'pom.xml', 'go.mod', 'Dockerfile', 'index.js', 'main.py', 'app.js'].includes(file))) {
          return candidatePath;
        }
      }
    }

    return baseDir;
  }
}

module.exports = new ZipService();
module.exports.ZipService = ZipService;
