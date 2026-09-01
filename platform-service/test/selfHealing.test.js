process.env.ALLOW_DEV_ANONYMOUS = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = require('../src/app');
const storageService = require('../src/services/storage.service');
const selfHealingEngine = require('../src/services/selfHealing');
const { Incident, INCIDENT_STATUSES, INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('../src/services/selfHealing/incident.model');
const { RemediationAction, ACTION_STATUSES, ACTION_TYPES } = require('../src/services/selfHealing/remediationAction.model');
const remediationPolicyService = require('../src/services/selfHealing/remediationPolicy.service');
const { RECOVERY_MODES } = remediationPolicyService;
const incidentDetector = require('../src/services/selfHealing/incident.detector.service');
const selfHealingStorage = require('../src/services/selfHealing/selfHealing.storage');

describe('Phase 9: Real Autonomous Self-Healing & Automatic Recovery Engine Tests', () => {
  let server;
  let port;
  const testProjectId = 'proj-self-heal-test';

  before(async () => {
    // Start temporary express server for endpoint integration tests
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    storageService.createWorkspace(testProjectId);
    storageService.saveAnalysis(testProjectId, {
      project: { name: 'self-healing-app' },
      port: { value: 3000 },
      runtime: { name: 'Node.js', version: '20' }
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    storageService.deleteWorkspace(testProjectId);
  });

  // 1. Incident Data Model & State Machine
  it('1. should create, mutate timeline, and transition incident lifecycle states correctly', () => {
    const inc = new Incident({
      projectId: testProjectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      severity: INCIDENT_SEVERITIES.CRITICAL,
      resourceId: 'cloudops-demo-container',
      failureMessage: 'Container stopped unexpectedly'
    });

    assert.equal(inc.status, INCIDENT_STATUSES.DETECTED);
    assert.equal(inc.timeline.length, 1);
    assert.equal(inc.remediationAttempts, 0);

    // Transition to REMEDIATING
    inc.transitionTo(INCIDENT_STATUSES.REMEDIATING, 'Operator initiated remediation');
    assert.equal(inc.status, INCIDENT_STATUSES.REMEDIATING);
    assert.equal(inc.timeline.length, 2);

    // Transition to RESOLVED
    inc.transitionTo(INCIDENT_STATUSES.RESOLVED, 'Health check returned 200 OK');
    assert.equal(inc.status, INCIDENT_STATUSES.RESOLVED);
    assert.equal(inc.verificationStatus, 'VERIFIED_HEALTHY');
    assert.ok(inc.resolvedAt);

    const json = inc.toJSON();
    assert.equal(json.incidentId, inc.incidentId);
    assert.equal(json.status, INCIDENT_STATUSES.RESOLVED);
  });

  // 2. Remediation Action Model
  it('2. should manage remediation action lifecycle and calculate execution duration', async () => {
    const act = new RemediationAction({
      incidentId: 'inc-123',
      projectId: testProjectId,
      actionType: ACTION_TYPES.RESTART_CONTAINER,
      attempt: 1
    });

    assert.equal(act.status, ACTION_STATUSES.PENDING);
    act.markRunning({ instanceId: 'i-test123' });
    assert.equal(act.status, ACTION_STATUSES.RUNNING);

    await new Promise(r => setTimeout(r, 10));
    act.markSuccess({ commandId: 'ssm-cmd-999' }, { isHealthy: true, httpStatus: 200 });

    assert.equal(act.status, ACTION_STATUSES.SUCCESS);
    assert.equal(act.commandId, 'ssm-cmd-999');
    assert.ok(act.durationMs >= 5);
    assert.equal(act.verificationResult.isHealthy, true);
  });

  // 3. Policy Engine Matrix & Recovery Modes
  it('3. should evaluate remediation permissions according to safety policy matrix', () => {
    const inc = new Incident({
      projectId: testProjectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      severity: INCIDENT_SEVERITIES.CRITICAL,
      resourceId: 'container-1'
    });

    // In SAFE mode, container restart should be allowed
    const safePerm = remediationPolicyService.evaluateRemediationPermission(inc, { recoveryMode: RECOVERY_MODES.SAFE });
    assert.equal(safePerm.allowed, true);
    assert.equal(safePerm.actionType, ACTION_TYPES.START_CONTAINER);

    // In DISABLED mode, automated remediation must be blocked
    const disabledPerm = remediationPolicyService.evaluateRemediationPermission(inc, { recoveryMode: RECOVERY_MODES.DISABLED });
    assert.equal(disabledPerm.allowed, false);
    assert.ok(disabledPerm.reason.includes('disabled'));

    // If global switch is OFF, all automated remediations must be blocked
    const globalOffPerm = remediationPolicyService.evaluateRemediationPermission(inc, { recoveryMode: RECOVERY_MODES.SAFE }, false);
    assert.equal(globalOffPerm.allowed, false);
    assert.ok(globalOffPerm.reason.includes('SAFETY_LOCK'));

    // High CPU or IAM failure must NEVER auto-remediate
    const cpuInc = new Incident({ projectId: testProjectId, type: INCIDENT_TYPES.HIGH_CPU_UTILIZATION });
    const cpuPerm = remediationPolicyService.evaluateRemediationPermission(cpuInc, { recoveryMode: RECOVERY_MODES.STANDARD });
    assert.equal(cpuPerm.allowed, false);

    const iamInc = new Incident({ projectId: testProjectId, type: INCIDENT_TYPES.IAM_PERMISSION_FAILURE });
    const iamPerm = remediationPolicyService.evaluateRemediationPermission(iamInc, { recoveryMode: RECOVERY_MODES.STANDARD });
    assert.equal(iamPerm.allowed, false);
  });

  // 4. Circuit Breaker & Retry Limits
  it('4. should enforce max attempts limit and trigger escalation when exhausted', () => {
    const inc = new Incident({
      projectId: testProjectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      maxAttempts: 2,
      remediationAttempts: 2
    });

    const perm = remediationPolicyService.evaluateRemediationPermission(inc, { recoveryMode: RECOVERY_MODES.SAFE, maxAttempts: 2 });
    assert.equal(perm.allowed, false);
    assert.equal(perm.escalate, true);
    assert.ok(perm.reason.includes('Maximum remediation attempts reached'));
  });

  // 5. Cooldown Window Enforcement
  it('5. should enforce remediation cooldown window between successive recovery attempts', () => {
    const inc = new Incident({
      projectId: testProjectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      maxAttempts: 3,
      remediationAttempts: 1
    });
    inc.lastRemediatedAt = new Date().toISOString(); // Just remediated 0s ago

    const perm = remediationPolicyService.evaluateRemediationPermission(inc, { recoveryMode: RECOVERY_MODES.SAFE, cooldownSeconds: 300 });
    assert.equal(perm.allowed, false);
    assert.ok(perm.reason.includes('cooldown in effect'));
  });

  // 6. Incident Detection & Symptom Correlation
  it('6. should detect root failures and correlate dependent symptoms', () => {
    const fakeSnapshot = {
      projectId: testProjectId,
      status: 'UNHEALTHY',
      docker: {
        daemon: { status: 'running', isActive: true },
        container: { name: 'cloudops-app', status: 'stopped', restarts: 0, isRunning: false }
      },
      application: {
        status: 'UNHEALTHY',
        isHealthy: false,
        httpStatus: null,
        error: 'Connection refused'
      },
      ssm: { pingStatus: 'Online' },
      ec2: { state: 'running', instanceId: 'i-test999' }
    };

    const detected = incidentDetector.detectIncidents(testProjectId, fakeSnapshot, []);
    assert.equal(detected.length, 1, 'Should correlate health check failure as a symptom of container stopped');
    assert.equal(detected[0].type, INCIDENT_TYPES.CONTAINER_STOPPED);
    assert.equal(detected[0].resourceId, 'cloudops-app');
  });

  // 7. Crash Loop Detection & Immediate Escalation
  it('7. should detect crash restart loops (>=3 restarts) and flag container restart loop', () => {
    const fakeCrashLoopSnapshot = {
      projectId: testProjectId,
      status: 'UNHEALTHY',
      docker: {
        daemon: { status: 'running', isActive: true },
        container: { name: 'cloudops-app', status: 'running', restarts: 4, isRunning: true }
      },
      application: { isHealthy: false, httpStatus: 502 },
      ssm: { pingStatus: 'Online' },
      ec2: { state: 'running', instanceId: 'i-test999' }
    };

    const detected = incidentDetector.detectIncidents(testProjectId, fakeCrashLoopSnapshot, []);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].type, INCIDENT_TYPES.CONTAINER_RESTART_LOOP);
    assert.equal(detected[0].severity, INCIDENT_SEVERITIES.CRITICAL);
  });

  // 8. SelfHealingStorage Persistence & Stats
  it('8. should persist incidents, remediations, and project settings with correct stats aggregation', () => {
    const inc = new Incident({
      projectId: testProjectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      resourceId: 'container-test'
    });

    selfHealingStorage.saveIncident(testProjectId, inc);
    const retrieved = selfHealingStorage.getIncident(testProjectId, inc.incidentId);
    assert.equal(retrieved.incidentId, inc.incidentId);

    const act = new RemediationAction({
      incidentId: inc.incidentId,
      projectId: testProjectId,
      actionType: ACTION_TYPES.RESTART_CONTAINER,
      status: 'SUCCESS'
    });
    selfHealingStorage.saveRemediation(testProjectId, act);

    const remediations = selfHealingStorage.getRemediations(testProjectId);
    assert.equal(remediations.length >= 1, true);

    const stats = selfHealingStorage.getProjectStats(testProjectId);
    assert.equal(stats.totalIncidents >= 1, true);
    assert.equal(stats.totalRemediationsCount >= 1, true);
  });

  // 9. REST API Integration Endpoints
  it('9. should handle global and project-scoped Self-Healing REST APIs', async () => {
    // 1. GET /api/recovery/status
    const resGlobal = await makeRequest('GET', '/api/recovery/status');
    assert.equal(resGlobal.status, 200);
    assert.equal(resGlobal.body.engineStatus, 'ACTIVE');

    // 2. POST /api/recovery/pause & resume
    const resPause = await makeRequest('POST', '/api/recovery/pause');
    assert.equal(resPause.status, 200);
    assert.equal(resPause.body.globalAutoRecovery, false);

    const resResume = await makeRequest('POST', '/api/recovery/resume');
    assert.equal(resResume.status, 200);
    assert.equal(resResume.body.globalAutoRecovery, true);

    // 3. GET /api/projects/:projectId/recovery/status
    const resProjStatus = await makeRequest('GET', `/api/projects/${testProjectId}/recovery/status`);
    assert.equal(resProjStatus.status, 200);
    assert.equal(resProjStatus.body.projectId, testProjectId);

    // 4. POST /api/projects/:projectId/recovery/settings
    const resSettings = await makeRequest('POST', `/api/projects/${testProjectId}/recovery/settings`, {
      recoveryMode: 'STANDARD',
      maxAttempts: 3
    });
    assert.equal(resSettings.status, 200);
    assert.equal(resSettings.body.settings.recoveryMode, 'STANDARD');
    assert.equal(resSettings.body.settings.maxAttempts, 3);

    // 5. GET /api/projects/:projectId/incidents
    const resIncidents = await makeRequest('GET', `/api/projects/${testProjectId}/incidents`);
    assert.equal(resIncidents.status, 200);
    assert.ok(Array.isArray(resIncidents.body.incidents));

    // 6. Acknowledge & Resolve Incident endpoints
    const testInc = selfHealingStorage.getIncidents(testProjectId)[0];
    if (testInc) {
      const resAck = await makeRequest('POST', `/api/projects/${testProjectId}/incidents/${testInc.incidentId}/acknowledge`, { operator: 'Alice' });
      assert.equal(resAck.status, 200);
      assert.equal(resAck.body.incident.status, INCIDENT_STATUSES.ACKNOWLEDGED);

      const resResolve = await makeRequest('POST', `/api/projects/${testProjectId}/incidents/${testInc.incidentId}/resolve`, { notes: 'Fixed' });
      assert.equal(resResolve.status, 200);
      assert.equal(resResolve.body.incident.status, INCIDENT_STATUSES.RESOLVED);
    }
  });

  function makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(body ? { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {})
          }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: data ? JSON.parse(data) : {}
              });
            } catch {
              resolve({ status: res.statusCode, headers: res.headers, body: data });
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
});
