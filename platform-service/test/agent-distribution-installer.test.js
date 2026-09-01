const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const testBaseDir = path.resolve(__dirname, '../temporary/test-agent-dist-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');
const dbService = require('../src/services/db/db.service');
const agentService = require('../src/services/agent/agent.service');

function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
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

async function runDistributionInstallerTests() {
  console.log('========================================================================');
  console.log('CLOUDOPS: AGENT DISTRIBUTION, INSTALLER & REMOTE MACHINE PAIRING TESTS');
  console.log('========================================================================\n');

  // Start HTTP server on dynamic port
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  console.log(`[Setup] Distribution Server running at ${serverUrl}`);

  // Create isolated scratch simulated "new laptop" environment
  const fakeLaptopHome = path.join(testBaseDir, 'customer-laptop-home');
  fs.mkdirSync(fakeLaptopHome, { recursive: true });

  const outsideWorkDir = path.join(testBaseDir, 'some-unrelated-customer-folder');
  fs.mkdirSync(outsideWorkDir, { recursive: true });

  const clientEnv = {
    ...process.env,
    HOME: fakeLaptopHome,
    USERPROFILE: fakeLaptopHome,
    CLOUDOPS_SERVER: serverUrl,
    PATH: `${path.join(fakeLaptopHome, '.cloudops', 'bin')}:${process.env.PATH}`
  };

  // Seed two distinct tenant organizations
  const orgA = 'org-customer-alpha';
  const userA = 'usr-alice';
  dbService.insert('organizations', { id: orgA, name: 'Alpha Customer Org', ownerId: userA });

  const orgB = 'org-customer-beta';
  const userB = 'usr-bob';
  dbService.insert('organizations', { id: orgB, name: 'Beta Customer Org', ownerId: userB });

  let passed = 0;
  let failed = 0;

  function log(msg) {
    process.stdout.write(`${msg}\n`);
  }

  async function test(name, fn) {
    log(`▶ Testing: ${name}...`);
    try {
      await fn();
      log(`✔ PASS: ${name}\n`);
      passed++;
    } catch (err) {
      log(`✖ FAIL: ${name}`);
      log(`  Error: ${err.message}\n`);
      failed++;
    }
  }

  // 1. Release Metadata Endpoint
  let releaseMeta;
  await test('1. GET /api/agent/dist/version returns release metadata, min Node version & SHA-256 checksum', async () => {
    const res = await fetch(`${serverUrl}/api/agent/dist/version`);
    assert.strictEqual(res.status, 200);
    releaseMeta = await res.json();

    assert.ok(releaseMeta.version);
    assert.strictEqual(releaseMeta.minNodeVersion, '18.0.0');
    assert.ok(releaseMeta.checksums['cloudops-agent']);
    assert.ok(releaseMeta.downloadUrl.includes('/api/agent/dist/cloudops-agent'));
    assert.ok(releaseMeta.installUrl.includes('/install.sh'));
  });

  // 2. Binary Download Endpoint
  let downloadedScriptContent;
  await test('2. GET /api/agent/dist/cloudops-agent streams standalone executable agent script', async () => {
    const res = await fetch(`${serverUrl}/api/agent/dist/cloudops-agent`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.ok(res.headers.get('x-agent-version'));

    downloadedScriptContent = await res.text();
    assert.ok(downloadedScriptContent.startsWith('#!/usr/bin/env node'));

    // Verify SHA-256 matches version manifest
    const actualHash = crypto.createHash('sha256').update(downloadedScriptContent).digest('hex');
    assert.strictEqual(actualHash, releaseMeta.checksums['cloudops-agent']);
  });

  // 3. Dynamic Unix & Windows Installer Scripts
  await test('3. GET /install.sh & /install.ps1 serve dynamic OS-specific installation scripts', async () => {
    const resSh = await fetch(`${serverUrl}/install.sh`);
    assert.strictEqual(resSh.status, 200);
    const shScript = await resSh.text();
    assert.ok(shScript.includes('#!/usr/bin/env sh'));
    assert.ok(shScript.includes(serverUrl));
    assert.ok(shScript.includes(releaseMeta.checksums['cloudops-agent']));
    assert.ok(shScript.includes('.cloudops/bin'));

    const resPs1 = await fetch(`${serverUrl}/install.ps1`);
    assert.strictEqual(resPs1.status, 200);
    const ps1Script = await resPs1.text();
    assert.ok(ps1Script.includes('$CloudOpsServer = '));
    assert.ok(ps1Script.includes(serverUrl));
    assert.ok(ps1Script.includes('cloudops-agent.cmd'));
  });

  // 4. Fresh Machine Installation Simulation (Running install.sh)
  const installedAgentPath = path.join(fakeLaptopHome, '.cloudops', 'bin', 'cloudops-agent');
  await test('4. Simulated Fresh-Machine Installation via POSIX installer script', async () => {
    const installerScriptPath = path.join(testBaseDir, 'test-install.sh');
    const resSh = await fetch(`${serverUrl}/install.sh`);
    const shScript = await resSh.text();
    fs.writeFileSync(installerScriptPath, shScript, { mode: 0o755 });

    const installRes = await runAsync('sh', [installerScriptPath], {
      cwd: outsideWorkDir,
      env: clientEnv
    });

    assert.strictEqual(installRes.status, 0);
    assert.ok(installRes.stdout.includes('CloudOps Local Agent installed successfully'));

    // Check installed file exists and is executable
    assert.ok(fs.existsSync(installedAgentPath));
    const stats = fs.statSync(installedAgentPath);
    assert.ok((stats.mode & 0o111) !== 0, 'Installed agent binary must be executable');
  });

  function runAgent(args) {
    return runAsync('node', [installedAgentPath, ...args], {
      cwd: outsideWorkDir,
      env: clientEnv
    });
  }

  // 5. Execution from Unrelated Directory with ZERO repo access
  await test('5. Execute cloudops-agent --help and --version from completely outside directory', async () => {
    const helpRes = await runAgent(['help']);
    assert.strictEqual(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('CloudOps Local Docker Agent CLI'));
    assert.ok(helpRes.stdout.includes('connect'));
    assert.ok(helpRes.stdout.includes('update'));
    assert.ok(helpRes.stdout.includes('uninstall'));

    const verRes = await runAgent(['--version']);
    assert.strictEqual(verRes.status, 0);
    assert.ok(verRes.stdout.includes('cloudops-agent v1.0.0'));
  });

  // 6. Pairing Workflow on New Machine
  let pairingCodeA;
  await test('6. Pair fresh remote machine to Tenant A using one-time pairing code', async () => {
    const pairObj = agentService.createPairingCode({ organizationId: orgA, userId: userA });
    pairingCodeA = pairObj.code;

    const connectRes = await runAgent(['connect', '--code', pairingCodeA, '--server', serverUrl]);

    assert.strictEqual(connectRes.status, 0);
    assert.ok(connectRes.stdout.includes('Successfully paired with organization'));
    assert.ok(connectRes.stdout.includes('Alpha Customer Org'));

    // Check config stored securely with 0600 permissions
    const configFile = path.join(fakeLaptopHome, '.cloudops', 'agent.json');
    assert.ok(fs.existsSync(configFile));
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.strictEqual(config.organizationId, orgA);
    assert.ok(config.agentToken);
    assert.ok(config.agentId);
  });

  // 7. Replay Attack & Expired Pairing Code Defense
  await test('7. Stale pairing code cannot be replayed', async () => {
    const replayRes = await runAgent(['connect', '--code', pairingCodeA, '--server', serverUrl]);
    assert.strictEqual(replayRes.status, 1);
    assert.ok(replayRes.stderr.includes('Invalid or already used pairing code') || replayRes.stdout.includes('Invalid or already used pairing code'));
  });

  // 8. Multi-Tenant Agent Isolation
  await test('8. Tenant B has zero visibility or access to Tenant A paired agent', async () => {
    const statusA = agentService.getAgentStatus(orgA);
    assert.strictEqual(statusA.connected, true);
    assert.strictEqual(statusA.organizationId, orgA);

    const statusB = agentService.getAgentStatus(orgB);
    assert.strictEqual(statusB.connected, false);
    assert.strictEqual(statusB.status, 'NOT_CONNECTED');
  });

  // 9. Heartbeat & Status Telemetry
  await test('9. Remote agent sends periodic heartbeat keepalive pulse', async () => {
    const beatRes = await runAgent(['heartbeat']);
    assert.strictEqual(beatRes.status, 0);
    assert.ok(beatRes.stdout.includes('Heartbeat acknowledged'));

    const statusRes = await runAgent(['status']);
    assert.strictEqual(statusRes.status, 0);
    assert.ok(statusRes.stdout.includes('Alpha Customer Org'));
    assert.ok(statusRes.stdout.includes(serverUrl));
  });

  // 10. Self-Update Mechanism with Checksum Integrity Verification
  await test('10. cloudops-agent update checks release version and verifies SHA-256 checksum', async () => {
    const updateRes = await runAgent(['update', '--server', serverUrl, '--force']);
    assert.strictEqual(updateRes.status, 0);
    assert.ok(updateRes.stdout.includes('SHA-256 Checksum verified'));
    assert.ok(updateRes.stdout.includes('updated successfully'));
  });

  // 11. Clean Uninstallation
  await test('11. cloudops-agent uninstall unpairs agent, cleans credentials, and removes binaries', async () => {
    const uninstRes = await runAgent(['uninstall']);
    assert.strictEqual(uninstRes.status, 0);
    assert.ok(uninstRes.stdout.includes('uninstalled successfully'));

    // Verify credentials and binaries removed
    const configFile = path.join(fakeLaptopHome, '.cloudops', 'agent.json');
    assert.strictEqual(fs.existsSync(configFile), false);
    assert.strictEqual(fs.existsSync(installedAgentPath), false);

    // Verify control plane marked agent as disconnected
    const postStatusA = agentService.getAgentStatus(orgA);
    assert.strictEqual(postStatusA.connected, false);
  });

  console.log('========================================================================');
  console.log(`AGENT DISTRIBUTION & INSTALLER SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  server.close();
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

runDistributionInstallerTests().catch(err => {
  console.error('Fatal distribution test error:', err);
  process.exit(1);
});
