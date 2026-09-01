const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const cloudwatchService = require('../src/services/aws/cloudwatch.service');
const ssmService = require('../src/services/aws/ssm.service');
const healthProbeService = require('../src/services/monitoring/health.probe.service');
const alertService = require('../src/services/monitoring/alert.service');
const monitoringWorker = require('../src/services/monitoring/monitoring.worker');
const storageService = require('../src/services/storage.service');
const config = require('../src/config');

describe('Phase 7: Real AWS Cloud Infrastructure Monitoring & Observability E2E Test', { timeout: 120000 }, () => {
  const instanceId = 'i-0e4f06a59698d1afa';
  const region = 'ap-south-1';
  const publicIp = '43.205.144.97';
  const containerName = 'cloudops-b3715b9c';
  const projectId = 'b3715b9c-d4bd-4f4f-b34e-4a6363addae3';

  it('1. should query real AWS CloudWatch metrics for live EC2 instance', async () => {
    console.log(`\n[E2E] 1. Querying AWS CloudWatch for instance '${instanceId}' in '${region}'...`);
    const metrics = await cloudwatchService.getAllEC2Metrics(instanceId, { region, windowMinutes: 60 });

    console.log('   - CloudWatch CPU Status:', metrics.cpu.status, 'Value:', metrics.cpu.value, '% Source:', metrics.cpu.source);
    console.log('   - CloudWatch NetworkIn Status:', metrics.network.networkIn.status, 'Value:', metrics.network.networkIn.value, 'Bytes');
    console.log('   - CloudWatch NetworkOut Status:', metrics.network.networkOut.status, 'Value:', metrics.network.networkOut.value, 'Bytes');

    assert.equal(metrics.cpu.source, 'AWS CloudWatch');
    assert.ok(metrics.cpu.status === 'AVAILABLE' || metrics.cpu.status === 'NO_DATA');
    if (metrics.cpu.status === 'AVAILABLE') {
      assert.equal(typeof metrics.cpu.value, 'number');
      assert.ok(metrics.cpu.value >= 0 && metrics.cpu.value <= 100);
    }
  });

  it('2. should verify AWS Systems Manager (SSM) agent connectivity on live EC2 instance', async () => {
    console.log(`\n[E2E] 2. Checking SSM connectivity for instance '${instanceId}'...`);
    const ssmInfo = await ssmService.getInstanceInformation(instanceId, region);

    console.log('   - SSM Ping Status:', ssmInfo.pingStatus);
    console.log('   - SSM Agent Version:', ssmInfo.agentVersion);
    console.log('   - SSM Platform:', ssmInfo.platformName, ssmInfo.platformVersion);

    assert.equal(ssmInfo.source, 'AWS Systems Manager');
    assert.equal(ssmInfo.isOnline, true);
    assert.equal(ssmInfo.pingStatus, 'Online');
  });

  it('3. should execute real OS and Docker monitoring probe via SSM', async () => {
    console.log(`\n[E2E] 3. Executing live SSM probe on instance '${instanceId}'...`);
    const probe = await ssmService.getFullMonitoringProbe(instanceId, containerName, 50, region);

    console.log('   - Guest Memory Total MB:', probe.memory.totalMB, 'Used MB:', probe.memory.usedMB, `(${probe.memory.usedPercentage}%)`);
    console.log('   - Guest Root Disk Total GB:', probe.disk.totalGB, 'Used GB:', probe.disk.usedGB, `(${probe.disk.usedPercentage}%)`);
    console.log('   - Docker Daemon Status:', probe.daemon.status, 'Active:', probe.daemon.isActive);
    console.log('   - Container Status:', probe.container.name, probe.container.status, 'Restarts:', probe.container.restarts);
    console.log('   - Container Stats CPU:', probe.stats.cpuPercent, '% Mem:', probe.stats.memoryPercent, '%');
    console.log('   - Container Log Lines Count:', probe.logs.linesCount);

    assert.equal(probe.memory.source, 'EC2 via SSM');
    assert.equal(probe.memory.status, 'AVAILABLE');
    assert.ok(probe.memory.usedPercentage > 0 && probe.memory.usedPercentage <= 100);

    assert.equal(probe.disk.source, 'EC2 via SSM');
    assert.equal(probe.disk.status, 'AVAILABLE');
    assert.ok(probe.disk.usedPercentage > 0 && probe.disk.usedPercentage <= 100);

    assert.equal(probe.daemon.isActive, true);
    assert.equal(probe.container.status, 'running');
    assert.ok(probe.logs.linesCount >= 0);
  });

  it('4. should probe real live application HTTP endpoint', async () => {
    const endpoint = `http://${publicIp}:3000/health`;
    console.log(`\n[E2E] 4. Probing application endpoint '${endpoint}'...`);
    const probe = await healthProbeService.probeEndpoint(endpoint, { timeoutMs: 8000 });

    console.log('   - HTTP Status:', probe.httpStatus);
    console.log('   - Probe Latency:', probe.durationMs, 'ms');
    console.log('   - Health State:', probe.status);
    console.log('   - Response Body:', JSON.stringify(probe.body));

    assert.equal(probe.source, 'HTTP Health Check');
    assert.equal(probe.isHealthy, true);
    assert.equal(probe.httpStatus, 200);
    assert.ok(typeof probe.durationMs === 'number' && probe.durationMs > 0);
    assert.equal(probe.body?.status, 'healthy');
  });

  it('5. should execute full integrated monitoring cycle & evaluate alerts', async () => {
    console.log(`\n[E2E] 5. Running complete performMonitoringCycle for project '${projectId}'...`);
    
    // Ensure project state is present in storage
    storageService.createWorkspace(projectId);
    storageService.saveAnalysis(projectId, {
      project: { name: 'cloudops-demo-app', runtime: 'Node.js' },
      awsState: {
        status: 'SUCCESS',
        endpoint: `http://${publicIp}:3000/health`,
        ec2: {
          instanceId,
          publicIp,
          state: 'running',
          region
        },
        deployment: {
          containerName,
          port: 3000
        }
      }
    });

    const snapshot = await monitoringWorker.performMonitoringCycle(projectId);

    console.log('   - Consolidated Health:', snapshot.status);
    console.log('   - EC2 CPU:', snapshot.ec2.cpu.value, '% (' + snapshot.ec2.cpu.source + ')');
    console.log('   - OS Memory:', snapshot.os.memory.usedPercentage, '% (' + snapshot.os.memory.source + ')');
    console.log('   - Docker Container:', snapshot.docker.container.status, '(' + snapshot.docker.container.source + ')');
    console.log('   - Active Alerts Count:', snapshot.alerts.activeCount);

    assert.equal(snapshot.status, 'HEALTHY');
    assert.equal(snapshot.ec2.state, 'running');
    assert.equal(snapshot.ssm.isOnline, true);
    assert.equal(snapshot.application.isHealthy, true);
  });

  it('6. should match independent AWS CLI and curl verification', () => {
    console.log(`\n[E2E] 6. Verifying independent AWS CLI outputs...`);

    // 1. Independent EC2 instance verification
    const cliEc2State = execSync(
      `aws ec2 describe-instances --instance-ids ${instanceId} --region ${region} --query "Reservations[0].Instances[0].State.Name" --output text`,
      { encoding: 'utf8' }
    ).trim();

    // 2. Independent SSM status verification
    const cliSsmStatus = execSync(
      `aws ssm describe-instance-information --filters "Key=InstanceIds,Values=${instanceId}" --region ${region} --query "InstanceInformationList[0].PingStatus" --output text`,
      { encoding: 'utf8' }
    ).trim();

    // 3. Independent curl HTTP probe
    const curlOutput = execSync(
      `curl -s -w "\\n%{http_code}" http://${publicIp}:3000/health`,
      { encoding: 'utf8' }
    ).trim();

    const [body, httpCode] = curlOutput.split('\n');

    console.log('   - Independent AWS CLI EC2 State:', cliEc2State);
    console.log('   - Independent AWS CLI SSM PingStatus:', cliSsmStatus);
    console.log('   - Independent curl HTTP Status Code:', httpCode);
    console.log('   - Independent curl Response Body:', body);

    assert.equal(cliEc2State, 'running');
    assert.equal(cliSsmStatus, 'Online');
    assert.equal(httpCode, '200');
    assert.ok(body.includes('"status":"healthy"'));
  });
});
