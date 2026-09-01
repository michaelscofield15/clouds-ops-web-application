const assert = require('assert');
const path = require('path');
const fs = require('fs');

const testBaseDir = path.resolve(__dirname, '../temporary/test-agent-suite');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const dbService = require('../src/services/db/db.service');
const agentService = require('../src/services/agent/agent.service');

function runAgentServiceTests() {
  console.log('===============================================================');
  console.log('TEST SUITE: CloudOps Local Docker Agent Engine & Pairing');
  console.log('===============================================================');

  const orgId = 'org-local-dev-100';
  const userId = 'usr-alice-100';

  // Seed organization
  dbService.insert('organizations', {
    id: orgId,
    name: 'DevOps Engineering Team',
    ownerId: userId
  });

  // 1. Initial State: Agent is NOT_CONNECTED
  console.log('[Test 1] Verify initial agent status...');
  const initStatus = agentService.getAgentStatus(orgId);
  assert.strictEqual(initStatus.connected, false);
  assert.strictEqual(initStatus.status, 'NOT_CONNECTED');
  console.log('✔ Initial state verified: NOT_CONNECTED');

  // 2. Generate Pairing Code
  console.log('[Test 2] Generate short-lived pairing code...');
  const pairCodeObj = agentService.createPairingCode({ organizationId: orgId, userId });
  assert(pairCodeObj.code && pairCodeObj.code.startsWith('PAIR-'));
  assert(pairCodeObj.expiresAt);
  assert.strictEqual(pairCodeObj.ttlSeconds, 600);
  console.log(`✔ Pairing code generated: ${pairCodeObj.code} (TTL: ${pairCodeObj.ttlSeconds}s)`);

  // 3. Exchange Pairing Code (Simulating CLI agent handshake)
  console.log('[Test 3] Exchange pairing code with machine telemetry...');
  const exchangeResult = agentService.exchangePairingCode({
    code: pairCodeObj.code,
    machineInfo: {
      hostname: 'macbook-pro-m3.local',
      os: 'Darwin 25.5.0',
      arch: 'arm64',
      dockerVersion: 'Docker version 29.7.2',
      agentVersion: '1.0.0'
    }
  });
  assert(exchangeResult.agentId);
  assert(exchangeResult.agentToken);
  assert.strictEqual(exchangeResult.organizationId, orgId);
  assert.strictEqual(exchangeResult.organizationName, 'DevOps Engineering Team');
  console.log(`✔ Agent paired: Agent ID = ${exchangeResult.agentId}`);

  // 4. Replay Prevention (Single-Use Defense)
  console.log('[Test 4] Verify single-use defense (replaying code must fail)...');
  assert.throws(() => {
    agentService.exchangePairingCode({
      code: pairCodeObj.code,
      machineInfo: { hostname: 'attacker-box' }
    });
  }, /Invalid or already used pairing code/);
  console.log('✔ Replay defense verified: Stale code rejected');

  // 5. Query Online Agent Status
  console.log('[Test 5] Verify agent status is ONLINE with machine specs...');
  const activeStatus = agentService.getAgentStatus(orgId);
  assert.strictEqual(activeStatus.connected, true);
  assert.strictEqual(activeStatus.status, 'ONLINE');
  assert.strictEqual(activeStatus.machineInfo.hostname, 'macbook-pro-m3.local');
  assert.strictEqual(activeStatus.machineInfo.arch, 'arm64');
  console.log(`✔ Agent online on ${activeStatus.machineInfo.hostname} (${activeStatus.machineInfo.arch})`);

  // 6. Record Heartbeat
  console.log('[Test 6] Record heartbeat pulse...');
  const beatRes = agentService.recordHeartbeat(exchangeResult.agentId, exchangeResult.agentToken, {
    running: true,
    version: 'Docker 29.7.2',
    containersCount: 4,
    imagesCount: 15
  });
  assert.strictEqual(beatRes.success, true);
  assert.strictEqual(beatRes.status, 'ONLINE');
  console.log('✔ Heartbeat acknowledged and recorded');

  // 7. Unpair / Disconnect Agent
  console.log('[Test 7] Disconnect agent and purge tokens...');
  const disconnRes = agentService.disconnectAgent(orgId);
  assert.strictEqual(disconnRes.success, true);

  const postDisconn = agentService.getAgentStatus(orgId);
  assert.strictEqual(postDisconn.connected, false);
  assert.strictEqual(postDisconn.status, 'NOT_CONNECTED');
  console.log('✔ Agent unlinked and status reset to NOT_CONNECTED');

  console.log('\n===============================================================');
  console.log('✔ ALL 7 LOCAL DOCKER AGENT TESTS PASSED!');
  console.log('===============================================================\n');

  // Cleanup
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(0);
}

try {
  runAgentServiceTests();
} catch (err) {
  console.error('\n✖ Agent Test Suite Failed:', err);
  process.exit(1);
}
