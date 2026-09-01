const fs = require('fs');
const path = require('path');

/**
 * Determines application entry point based on package.json, scripts, and filesystem evidence.
 */
function analyzeEntryPoint(projectDir, nodeInfo = {}) {
  const candidates = [];

  // 1. Check package.json main field
  if (nodeInfo.main) {
    const normalizedMain = nodeInfo.main.replace(/^\.\//, '');
    if (fs.existsSync(path.join(projectDir, normalizedMain))) {
      candidates.push({
        value: normalizedMain,
        confidence: 'high',
        source: 'package.json main'
      });
    }
  }

  // 2. Check package.json scripts (start, dev)
  const scripts = nodeInfo.scripts || {};
  const startScript = scripts.start || scripts.dev || '';
  if (startScript) {
    // Look for node <path> or nodemon <path>
    const match = startScript.match(/(?:node|nodemon|ts-node|tsx)\s+(?:--[\w-]+\s+)*([\w./\\-]+\.js|\.mjs|\.cjs|\.ts)/);
    if (match && match[1]) {
      const scriptEntry = match[1].replace(/^\.\//, '');
      if (fs.existsSync(path.join(projectDir, scriptEntry))) {
        candidates.push({
          value: scriptEntry,
          confidence: 'high',
          source: 'package.json start script'
        });
      }
    }
  }

  // 3. Check common standard entry point file locations
  const commonFiles = [
    'src/server.js',
    'src/index.js',
    'src/main.js',
    'src/app.js',
    'server.js',
    'index.js',
    'main.js',
    'app.js'
  ];

  for (const file of commonFiles) {
    if (fs.existsSync(path.join(projectDir, file))) {
      // If not already in candidates, add it with medium confidence
      if (!candidates.some((c) => c.value === file)) {
        candidates.push({
          value: file,
          confidence: 'medium',
          source: 'common file convention'
        });
      }
    }
  }

  if (candidates.length > 0) {
    // Return highest confidence candidate
    const best = candidates[0];
    return {
      value: best.value,
      confidence: best.confidence,
      source: best.source,
      candidates: candidates.map((c) => c.value)
    };
  }

  return {
    value: 'unknown',
    confidence: 'none',
    source: 'none',
    candidates: []
  };
}

module.exports = {
  analyzeEntryPoint
};
