const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const testBaseDir = path.resolve(__dirname, '../temporary/test-agent-cli-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');
const dbService = require('../src/services/db/db.service');
const agentService = require('../src/services/agent/agent.service');

const CLI_PATH = path.resolve(__dirname, '../bin/cloudops-agent');

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', reject);
    child.on('close', code => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

async function runStandaloneAgentCliTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: STANDALONE LOCAL DOCKER AGENT CLI TEST SUITE');
  console.log('========================================================================\n');

  // Start HTTP server on dynamic port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  console.log(`[Setup] Control Plane test server running at ${serverUrl}`);

  // Create isolated scratch home directory for CLI config tests
  const fakeHome = path.join(testBaseDir, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });

  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLOUDOPS_SERVER: serverUrl
  };

  // Seed test tenant
  const orgId = 'org-standalone-cli-test';
  const userId = 'usr-standalone-tester';
  dbService.insert('organizations', {
    id: orgId,
    name: 'Standalone CLI Testing Workspace',
    ownerId: userId
  });

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    console.log(`▶ Testing: ${name}...`);
    try {
      await fn();
      console.log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      console.error(`✖ FAIL: ${name}`);
      console.error(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  // 1. Help and Version from Arbitrary Outside Working Directory
  const outsideWorkingDir = path.join(testBaseDir, 'some-outside-dir');
  fs.mkdirSync(outsideWorkingDir, { recursive: true });

  await test('1. CLI displays help and version when executed from arbitrary directory', async () => {
    const helpRes = await runCliAsync(['help'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('CloudOps Local Docker Agent CLI'));
    assert.ok(helpRes.stdout.includes('connect'));
    assert.ok(helpRes.stdout.includes('docker-status'));
    assert.ok(helpRes.stdout.includes('containers'));

    const verRes = await runCliAsync(['--version'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(verRes.status, 0);
    assert.ok(verRes.stdout.includes('cloudops-agent v1.0.0'));
  });

  // 2. Status when not paired
  await test('2. CLI status reports NOT PAIRED when no credentials exist', async () => {
    const statusRes = await runCliAsync(['status'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(statusRes.status, 0);
    assert.ok(statusRes.stdout.includes('NOT PAIRED'));
  });

  // 3. Connect / Pairing
  let pairingCode;
  await test('3. CLI connects and pairs successfully with pairing code', async () => {
    const pairObj = agentService.createPairingCode({ organizationId: orgId, userId });
    pairingCode = pairObj.code;

    const connectRes = await runCliAsync(['connect', '--code', pairingCode, '--server', serverUrl], {
      cwd: outsideWorkingDir,
      env
    });

    assert.strictEqual(connectRes.status, 0);
    assert.ok(connectRes.stdout.includes('Successfully paired with organization'));
    assert.ok(connectRes.stdout.includes('Standalone CLI Testing Workspace'));

    // Check config saved securely
    const configFile = path.join(fakeHome, '.cloudops', 'agent.json');
    assert.ok(fs.existsSync(configFile));
    const savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.strictEqual(savedConfig.organizationId, orgId);
    assert.ok(savedConfig.agentToken);
    assert.ok(savedConfig.agentId);
  });

  // 4. Status when paired
  await test('4. CLI status reports paired organization and agent identity', async () => {
    const statusRes = await runCliAsync(['status'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(statusRes.status, 0);
    assert.ok(statusRes.stdout.includes('Standalone CLI Testing Workspace'));
    assert.ok(statusRes.stdout.includes(serverUrl));
  });

  // 5. Heartbeat pulse
  await test('5. CLI sends heartbeat pulse and receives acknowledgment', async () => {
    const beatRes = await runCliAsync(['heartbeat'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(beatRes.status, 0);
    assert.ok(beatRes.stdout.includes('Heartbeat acknowledged'));
  });

  // 6. Replay Attack Prevention
  await test('6. Replaying used pairing code is rejected', async () => {
    const replayRes = await runCliAsync(['connect', '--code', pairingCode, '--server', serverUrl], {
      cwd: outsideWorkingDir,
      env
    });
    assert.strictEqual(replayRes.status, 1);
    assert.ok(replayRes.stderr.includes('Invalid or already used pairing code') || replayRes.stdout.includes('Invalid or already used pairing code'));
  });

  // 7. Expired Pairing Code Rejection
  await test('7. Expired pairing code is rejected', async () => {
    const expiredPairing = {
      id: 'pair-expired-test',
      code: 'PAIR-EXPIRED1',
      organizationId: orgId,
      userId,
      used: false,
      expiresAt: new Date(Date.now() - 60000).toISOString()
    };
    dbService.insert('agent_pairings', expiredPairing);

    const expRes = await runCliAsync(['connect', '--code', 'PAIR-EXPIRED1', '--server', serverUrl], {
      cwd: outsideWorkingDir,
      env
    });
    assert.strictEqual(expRes.status, 1);
    assert.ok(expRes.stderr.includes('expired') || expRes.stdout.includes('expired'));
  });

  // 8. Build Path Traversal & Missing Dockerfile Protection
  await test('8. CLI build rejects missing directory and missing Dockerfile', async () => {
    const nonExistentDir = path.join(testBaseDir, 'does-not-exist');
    const noDirRes = await runCliAsync(['build', '--dir', nonExistentDir], {
      cwd: outsideWorkingDir,
      env
    });
    assert.strictEqual(noDirRes.status, 1);
    assert.ok(noDirRes.stderr.includes('does not exist'));

    // Directory without Dockerfile
    const emptyDir = path.join(testBaseDir, 'empty-context');
    fs.mkdirSync(emptyDir, { recursive: true });
    const noDockerRes = await runCliAsync(['build', '--dir', emptyDir], {
      cwd: outsideWorkingDir,
      env
    });
    assert.strictEqual(noDockerRes.status, 1);
    assert.ok(noDockerRes.stderr.includes('No Dockerfile found'));
  });

  // 9. Disconnect and Credential Purge
  await test('9. CLI disconnect unpairs agent and purges local credentials', async () => {
    const disRes = await runCliAsync(['disconnect'], { cwd: outsideWorkingDir, env });
    assert.strictEqual(disRes.status, 0);
    assert.ok(disRes.stdout.includes('disconnected and credentials purged'));

    const configFile = path.join(fakeHome, '.cloudops', 'agent.json');
    assert.strictEqual(fs.existsSync(configFile), false);

    // Status after disconnect
    const postStatusRes = await runCliAsync(['status'], { cwd: outsideWorkingDir, env });
    assert.ok(postStatusRes.stdout.includes('NOT PAIRED'));
  });

  console.log('========================================================================');
  console.log(`STANDALONE CLI TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  // Close server and cleanup
  server.close();
  fs.rmSync(testBaseDir, { recursive: true, force: true });

  if (failed > 0) {
    process.exit(1);
  }
}

runStandaloneAgentCliTests().catch(err => {
  console.error('Fatal CLI test suite error:', err);
  process.exit(1);
});
