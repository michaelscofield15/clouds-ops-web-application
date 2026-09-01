const fs = require('fs');
const path = require('path');

/**
 * Statically detects application port from code files and configuration templates.
 */
function analyzePort(projectDir, entryPointInfo = {}) {
  // Candidate files to search in order of relevance
  const candidateFiles = [];

  if (entryPointInfo.value && entryPointInfo.value !== 'unknown') {
    candidateFiles.push(entryPointInfo.value);
  }

  // Add other likely files
  const searchFiles = [
    'src/server.js',
    'src/app.js',
    'src/index.js',
    'src/main.js',
    'server.js',
    'app.js',
    'index.js',
    'main.js',
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'next.config.js',
    '.env.example',
    'config.js',
    'src/config/index.js',
    'src/config.js'
  ];

  for (const f of searchFiles) {
    if (!candidateFiles.includes(f)) {
      candidateFiles.push(f);
    }
  }

  // Regex patterns to detect port declarations in source code (Express, Fastify, NestJS, HTTP)
  const codePatterns = [
    // const PORT = process.env.PORT || 3000;
    /(?:PORT|port)\s*=\s*(?:process\.env\.PORT\s*\|\|\s*|parseInt\([^)]+\)\s*\|\|\s*)(\d{2,5})/i,
    // process.env.PORT || 3000
    /process\.env\.PORT\s*\|\|\s*(\d{2,5})/,
    // app.listen(3000) or .listen(process.env.PORT || 3000)
    /\.listen\(\s*(?:process\.env\.PORT\s*\|\|\s*|['"]?)(\d{2,5})/i,
    // fastify.listen({ port: 5000 }) or { port: process.env.PORT || 5000 }
    /\.listen\(\s*\{\s*(?:.*?\s*)?port\s*:\s*(?:process\.env\.PORT\s*\|\|\s*)?(\d{2,5})/i,
    // port: 5000 in config or options
    /\bport\s*:\s*(\d{2,5})\b/i
  ];

  // Check code files first
  for (const relFile of candidateFiles) {
    const fullPath = path.join(projectDir, relFile);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      continue;
    }

    for (const pattern of codePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const portNum = parseInt(match[1], 10);
        if (portNum > 0 && portNum <= 65535) {
          return {
            value: portNum,
            source: `application source (${relFile})`,
            confidence: 'high'
          };
        }
      }
    }
  }

  // Check .env.example / .env.sample / .env.template
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.defaults'];
  for (const envFile of envFiles) {
    const fullPath = path.join(projectDir, envFile);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const match = content.match(/^PORT\s*=\s*(\d{2,5})/m);
        if (match && match[1]) {
          const portNum = parseInt(match[1], 10);
          if (portNum > 0 && portNum <= 65535) {
            return {
              value: portNum,
              source: `configuration template (${envFile})`,
              confidence: 'high'
            };
          }
        }
      } catch (e) {
        // ignore
      }
    }
  }

  return {
    value: 'unknown',
    source: 'not detected',
    confidence: 'none'
  };
}

module.exports = {
  analyzePort
};
