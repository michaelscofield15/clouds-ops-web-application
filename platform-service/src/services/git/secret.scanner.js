const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9\/+=]{40})["']?/i },
  { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub Personal Access Token', regex: /(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{82}/ },
  { name: 'Slack Token', regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/ },
  { name: 'Stripe API Key', regex: /(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,34}/ },
  { name: 'Generic Password / Secret in .env', regex: /(?:password|secret|api_key|token|auth_key)\s*=\s*(?!["']?(?:true|false|none|null|undefined|sample|example|test|dev|123456)["']?)(["']?[^\s\r\n]{8,}["']?)/i }
];

const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.env.example']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

class SecretScanner {
  /**
   * Scans a workspace directory recursively for exposed secrets
   */
  scanDirectory(projectDir) {
    const findings = [];

    const scan = (currentDir) => {
      if (!fs.existsSync(currentDir)) return;

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(projectDir, fullPath);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            scan(fullPath);
          }
        } else if (entry.isFile()) {
          if (IGNORED_FILES.has(entry.name)) {
            continue;
          }

          // Flag real .env files with secrets
          if (entry.name === '.env') {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              if (content.trim().length > 0 && !content.includes('example')) {
                findings.push({
                  file: relPath,
                  rule: 'Unencrypted .env file',
                  description: 'Environment file .env should not be committed to Git'
                });
              }
            } catch {
              // ignore read errors
            }
          }

          // Scan content for pattern matches
          try {
            const stats = fs.statSync(fullPath);
            // Skip binary or huge files (> 2MB)
            if (stats.size > 2 * 1024 * 1024) continue;

            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split(/\r?\n/);

            for (let lineNum = 0; lineNum < lines.length; lineNum++) {
              const line = lines[lineNum];
              for (const pattern of SECRET_PATTERNS) {
                if (pattern.regex.test(line)) {
                  findings.push({
                    file: relPath,
                    line: lineNum + 1,
                    rule: pattern.name,
                    description: `Potential ${pattern.name} detected`
                  });
                  break; // Only one finding per line
                }
              }
            }
          } catch {
            // ignore binary/read errors
          }
        }
      }
    };

    scan(projectDir);

    return {
      passed: findings.length === 0,
      findingsCount: findings.length,
      findings
    };
  }
}

module.exports = new SecretScanner();
