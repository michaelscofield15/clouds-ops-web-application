const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  {
    type: 'possible AWS Access Key ID',
    regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/
  },
  {
    type: 'possible Private Key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/
  },
  {
    type: 'possible GitHub Personal Access Token',
    regex: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/
  },
  {
    type: 'possible Slack Token',
    regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/
  },
  {
    type: 'possible Stripe API Key',
    regex: /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,99}/
  }
];

function scanDirectory(dir, maxFiles = 200, count = { current: 0 }) {
  if (count.current > maxFiles) return [];
  let files = [];

  try {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      if (item === 'node_modules' || item === '.git' || item === '__MACOSX') continue;
      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          files = files.concat(scanDirectory(fullPath, maxFiles, count));
        } else if (stat.isFile()) {
          count.current++;
          files.push(fullPath);
        }
      } catch (e) {
        // Skip unreadable
      }
    }
  } catch (e) {
    // Skip
  }

  return files;
}

/**
 * Statically inspects files for secrets without exposing secret values
 */
function analyzeSecurity(projectDir) {
  const allFiles = scanDirectory(projectDir);
  const findings = [];

  for (const filePath of allFiles) {
    const relPath = path.relative(projectDir, filePath);
    const fileName = path.basename(filePath);

    // Check for committed actual .env file (as opposed to .env.example / .env.sample)
    if (fileName === '.env' || fileName === '.env.production' || fileName === '.env.staging') {
      findings.push({
        type: 'Committed environment file (.env)',
        file: relPath
      });
    }

    // Skip binary files and very large files (> 1MB)
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 1024 * 1024) continue;

      const content = fs.readFileSync(filePath, 'utf8');

      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(content)) {
          findings.push({
            type: pattern.type,
            file: relPath
          });
          break; // Avoid multiple duplicate alerts for the same file
        }
      }
    } catch (e) {
      // Ignore binary decoding failures
    }
  }

  return {
    possibleSecretsDetected: findings.length > 0,
    findingsCount: findings.length,
    findings: findings.map((f) => ({
      type: f.type,
      file: f.file
    }))
  };
}

module.exports = {
  analyzeSecurity
};
