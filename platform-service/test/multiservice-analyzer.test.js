const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { analyzeProject } = require('../src/services/analyzer');

const testDir = path.resolve(__dirname, '../temporary/test-multiservice-app');
if (fs.existsSync(testDir)) {
  fs.rmSync(testDir, { recursive: true, force: true });
}
fs.mkdirSync(testDir, { recursive: true });

// Create a fullstack monorepo project
// 1. Frontend: React / Vite on port 5173
const frontendDir = path.join(testDir, 'frontend');
fs.mkdirSync(frontendDir, { recursive: true });
fs.writeFileSync(path.join(frontendDir, 'package.json'), JSON.stringify({
  name: 'cloudops-frontend',
  version: '1.0.0',
  scripts: { dev: 'vite', build: 'vite build' },
  dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
  devDependencies: { vite: '^5.0.0' }
}), 'utf8');
fs.writeFileSync(path.join(frontendDir, 'vite.config.js'), `
export default {
  server: { port: 5173 }
};
`, 'utf8');

// 2. Backend: Express on port 5000
const backendDir = path.join(testDir, 'backend');
fs.mkdirSync(backendDir, { recursive: true });
fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({
  name: 'cloudops-backend',
  version: '1.0.0',
  scripts: { start: 'node server.js' },
  dependencies: { express: '^4.18.2', cors: '^2.8.5' }
}), 'utf8');
fs.writeFileSync(path.join(backendDir, 'server.js'), `
const express = require('express');
const app = express();
const PORT = process.env.PORT || 5000;
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log('Listening on ' + PORT));
`, 'utf8');

function runAnalyzerTests() {
  console.log('===============================================================');
  console.log('TEST SUITE: Multi-Service Monorepo Topology Analyzer');
  console.log('===============================================================');

  const report = analyzeProject(testDir);
  console.log('Analysis Report Topology:', JSON.stringify(report.topology, null, 2));

  // 1. Verify Topology Detection
  assert.strictEqual(report.topology.type, 'monorepo', 'Should detect monorepo topology');
  assert.strictEqual(report.topology.serviceCount, 2, 'Should detect 2 distinct services');
  console.log('✔ Detected Monorepo Architecture with 2 services');

  // 2. Verify Frontend Service
  const frontendService = report.topology.services.find(s => s.name === 'frontend');
  assert(frontendService, 'Frontend service must be identified');
  assert.strictEqual(frontendService.role, 'frontend');
  assert.strictEqual(frontendService.runtime, 'Node.js');
  assert.strictEqual(frontendService.port, 5173, 'Frontend port must be 5173');
  console.log(`✔ Frontend Service detected: Role=${frontendService.role}, Port=${frontendService.port}`);

  // 3. Verify Backend Service
  const backendService = report.topology.services.find(s => s.name === 'backend');
  assert(backendService, 'Backend service must be identified');
  assert.strictEqual(backendService.role, 'backend');
  assert.strictEqual(backendService.runtime, 'Node.js');
  assert.strictEqual(backendService.port, 5000, 'Backend port must be 5000');
  console.log(`✔ Backend Service detected: Role=${backendService.role}, Port=${backendService.port}`);

  console.log('\n===============================================================');
  console.log('✔ ALL MULTI-SERVICE TOPOLOGY ANALYZER TESTS PASSED!');
  console.log('===============================================================\n');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(0);
}

try {
  runAnalyzerTests();
} catch (err) {
  console.error('\n✖ Multi-Service Analyzer Test Failed:', err);
  process.exit(1);
}
