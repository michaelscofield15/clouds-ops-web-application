const fs = require('fs');
const path = require('path');

/**
 * Detects package manager from lockfiles and package.json configuration.
 */
function analyzePackageManager(projectDir, nodeInfo = {}) {
  const hasNpmLock = fs.existsSync(path.join(projectDir, 'package-lock.json'));
  const hasYarnLock = fs.existsSync(path.join(projectDir, 'yarn.lock'));
  const hasPnpmLock = fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'));

  const detected = [];
  if (hasNpmLock) detected.push('npm');
  if (hasYarnLock) detected.push('yarn');
  if (hasPnpmLock) detected.push('pnpm');

  if (detected.length > 1) {
    return {
      packageManager: 'conflict',
      conflict: true,
      detectedLockfiles: detected,
      details: `Multiple conflicting lockfiles detected: ${detected.join(', ')}`
    };
  }

  if (detected.length === 1) {
    return {
      packageManager: detected[0],
      conflict: false,
      confidence: 'high'
    };
  }

  // Check package.json `packageManager` field (corepack / modern npm)
  if (nodeInfo && nodeInfo.engines && nodeInfo.engines.npm) {
    return {
      packageManager: 'npm',
      conflict: false,
      confidence: 'medium'
    };
  }

  // Default fallback if package.json exists but no lockfile
  if (nodeInfo && nodeInfo.isNode) {
    return {
      packageManager: 'npm',
      conflict: false,
      confidence: 'medium',
      note: 'Inferred from standard Node.js project structure'
    };
  }

  return {
    packageManager: 'unknown',
    conflict: false,
    confidence: 'none'
  };
}

module.exports = {
  analyzePackageManager
};
