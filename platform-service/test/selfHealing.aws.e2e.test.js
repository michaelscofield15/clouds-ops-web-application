const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');

const selfHealingEngine = require('../src/services/selfHealing');
const remediationExecutor = require('../src/services/selfHealing/remediation.executor.service');
const remediationPolicy = require('../src/services/selfHealing/remediationPolicy.service');
const { Incident, INCIDENT_STATUSES, INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('../src/services/selfHealing/incident.model');
const { ACTION_TYPES } = require('../src/services/selfHealing/remediationAction.model');
const ssmService = require('../src/services/aws/ssm.service');
const healthProbeService = require('../src/services/monitoring/health.probe.service');
const storageService = require('../src/services/storage.service');
const config = require('../src/config');

describe('Phase 9: Real AWS Autonomous Self-Healing & Automatic Recovery E2E Test', { timeout: 180000 }, () => {
  const instanceId = 'i-0e4f06a59698d1afa';
  const region = 'ap-south-1';
  const publicIp = '43.205.144.97';
  const containerName = 'cloudops-b3715b9c';
  const port = 3000;
  const projectId = 'b3715b9c-d4bd-4f4f-b34e-4a6363addae3';
  const endpoint = `http://${publicIp}:${port}/health`;

  before(() => {
    // Setup workspace record in storageService so self-healing can query AWS state
    storageService.createWorkspace(projectId);
    storageService.saveAnalysis(projectId, {
      project: { name: 'cloudops-demo-app' },
      port: { value: port },
      awsState: {
        status: 'SUCCESS',
        deploymentId: 'aws-dep-b3715b9c-initial',
        endpoint: `http://${publicIp}:${port}`,
        containerName,
        ec2: {
          instanceId,
          publicIp,
          region,
          state: 'running'
        },
        deployment: {
          containerName,
          port
        }
      }
    });
  });

  // 1. Verify Real Live EC2 & SSM Connectivity
  it('1. should verify live AWS EC2 instance is running and SSM Agent is Online', async () => {
    console.log(`\n[E2E] 1. Checking SSM connectivity for live instance '${instanceId}' in '${region}'...`);
    const ssmInfo = await ssmService.getInstanceInformation(instanceId, region);

    console.log('   - SSM Ping Status:', ssmInfo.pingStatus);
    console.log('   - SSM Agent Version:', ssmInfo.agentVersion);
    console.log('   - Platform:', ssmInfo.platformName, ssmInfo.platformVersion);

    assert.equal(ssmInfo.source, 'AWS Systems Manager');
    assert.equal(ssmInfo.isOnline, true);
    assert.equal(ssmInfo.pingStatus, 'Online');
  });

  // 2. Verify Initial Live Application Health
  it('2. should verify live HTTP health endpoint is reachable and returning HTTP 200', async () => {
    console.log(`\n[E2E] 2. Probing live endpoint '${endpoint}'...`);
    const probe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 5000 });

    console.log('   - Probe isHealthy:', probe.isHealthy);
    console.log('   - HTTP Status:', probe.httpStatus);
    console.log('   - Response Time:', probe.durationMs, 'ms');

    assert.equal(probe.isHealthy, true);
    assert.equal(probe.httpStatus, 200);
  });

  // 3. Evaluate Live Healthy State via Self-Healing Engine
  it('3. should evaluate live healthy monitoring snapshot without triggering false positives', async () => {
    console.log(`\n[E2E] 3. Running Self-Healing evaluation on live healthy snapshot...`);
    const dockerMetrics = await ssmService.getDockerMetrics(instanceId, containerName, region);
    const healthProbe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 5000 });

    const liveSnapshot = {
      projectId,
      timestamp: new Date().toISOString(),
      status: 'HEALTHY',
      ec2: { instanceId, state: 'running' },
      ssm: { isOnline: true, pingStatus: 'Online' },
      docker: {
        daemon: dockerMetrics.daemon,
        container: dockerMetrics.container
      },
      application: {
        status: 'HEALTHY',
        isHealthy: healthProbe.isHealthy,
        httpStatus: healthProbe.httpStatus
      },
      alerts: { active: [], activeCount: 0 }
    };

    const evaluation = await selfHealingEngine.evaluateProject(projectId, liveSnapshot);
    console.log('   - Evaluation Processed:', evaluation.evaluated);
    console.log('   - Incidents Processed:', evaluation.incidentsProcessed);

    assert.equal(evaluation.evaluated, true);
    const stats = selfHealingEngine.storage.getProjectStats(projectId);
    assert.equal(stats.activeIncidentsCount, 0);
  });

  // 4. Real AWS SSM Container Restart & Post-Remediation Health Verification
  it('4. should execute real SSM container restart and verify post-remediation HTTP 200 health', async () => {
    console.log(`\n[E2E] 4. Executing real SSM container restart remediation on '${instanceId}'...`);
    const incident = new Incident({
      projectId,
      type: INCIDENT_TYPES.CONTAINER_STOPPED,
      severity: INCIDENT_SEVERITIES.CRITICAL,
      resourceId: containerName,
      failureMessage: 'Test incident: simulated container stopped event for real AWS verification'
    });

    selfHealingEngine.storage.saveIncident(projectId, incident);

    const actionResult = await remediationExecutor.execute(incident, ACTION_TYPES.RESTART_CONTAINER, {
      healthCheckRetries: 4,
      retryDelayMs: 2000
    });

    console.log('   - Action Status:', actionResult.status);
    console.log('   - SSM Command ID:', actionResult.commandId);
    console.log('   - Execution Duration:', actionResult.durationMs, 'ms');
    console.log('   - Post-Remediation Health:', actionResult.verificationResult?.isHealthy);
    console.log('   - Post-Remediation HTTP Status:', actionResult.verificationResult?.httpStatus);

    assert.equal(actionResult.status, 'SUCCESS');
    assert.ok(actionResult.commandId);
    assert.equal(actionResult.verificationResult?.isHealthy, true);
    assert.equal(actionResult.verificationResult?.httpStatus, 200);

    incident.transitionTo(INCIDENT_STATUSES.RESOLVED, 'Verified healthy following real SSM restart', {
      actionId: actionResult.actionId,
      verification: actionResult.verificationResult
    });
    selfHealingEngine.storage.saveIncident(projectId, incident);
  });

  // 5. Test Circuit Breaker & Max Retries Escalation
  it('5. should enforce circuit breaker and escalate incident when max attempts are exceeded', async () => {
    console.log(`\n[E2E] 5. Testing circuit breaker policy on exhausted retries...`);
    const persistentIncident = new Incident({
      projectId,
      type: INCIDENT_TYPES.CONTAINER_CRASHED,
      severity: INCIDENT_SEVERITIES.CRITICAL,
      resourceId: containerName,
      maxAttempts: 2,
      remediationAttempts: 2,
      failureMessage: 'Repeated application crash in startup code'
    });

    const permission = remediationPolicy.evaluateRemediationPermission(persistentIncident, {
      autoRecovery: true,
      recoveryMode: 'SAFE',
      maxAttempts: 2
    });

    console.log('   - Policy Permission Allowed:', permission.allowed);
    console.log('   - Policy Action:', permission.actionType);
    console.log('   - Escalation Flag:', permission.escalate);
    console.log('   - Policy Reason:', permission.reason);

    assert.equal(permission.allowed, false);
    assert.equal(permission.escalate, true);
    assert.equal(permission.actionType, ACTION_TYPES.ESCALATE_TO_HUMAN);

    persistentIncident.transitionTo(INCIDENT_STATUSES.ESCALATED, permission.reason);
    assert.equal(persistentIncident.status, INCIDENT_STATUSES.ESCALATED);
    assert.equal(persistentIncident.escalationRequired, true);
  });

  // 6. Test Deployment Rollback Safety Policy & Target Validation
  it('6. should validate previous deployment state for safe rollback execution', async () => {
    console.log(`\n[E2E] 6. Testing deployment rollback safety validation...`);
    const rollbackIncident = new Incident({
      projectId,
      type: INCIDENT_TYPES.DEPLOYMENT_HEALTH_FAILURE,
      severity: INCIDENT_SEVERITIES.CRITICAL,
      resourceId: containerName,
      failureMessage: 'New deployment build failed HTTP health checks'
    });

    // In SAFE mode, rollback is not auto-permitted (requires STANDARD mode)
    const safeModePerm = remediationPolicy.evaluateRemediationPermission(rollbackIncident, { recoveryMode: 'SAFE' });
    assert.equal(safeModePerm.allowed, false);

    // In STANDARD mode, rollback is policy approved
    const standardModePerm = remediationPolicy.evaluateRemediationPermission(rollbackIncident, { recoveryMode: 'STANDARD' });
    assert.equal(standardModePerm.allowed, true);
    assert.equal(standardModePerm.actionType, ACTION_TYPES.ROLLBACK_DEPLOYMENT);
    console.log('   - Rollback Policy Approved in STANDARD mode:', standardModePerm.allowed);
  });

  // 7. Verify Final Production Workload State
  it('7. should independently verify final container is running and healthy on live AWS EC2', async () => {
    console.log(`\n[E2E] 7. Independent AWS verification of container and endpoint...`);
    const finalProbe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 5000 });
    const dockerMetrics = await ssmService.getDockerMetrics(instanceId, containerName, region);

    console.log('   - Final Container Status:', dockerMetrics.container.status);
    console.log('   - Final Container Running:', dockerMetrics.container.isRunning);
    console.log('   - Final HTTP Status:', finalProbe.httpStatus);
    console.log('   - Final Health:', finalProbe.isHealthy);

    assert.equal(dockerMetrics.container.isRunning, true);
    assert.equal(dockerMetrics.container.status, 'running');
    assert.equal(finalProbe.isHealthy, true);
    assert.equal(finalProbe.httpStatus, 200);
  });
});
