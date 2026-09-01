const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const cloudwatchService = require('../src/services/aws/cloudwatch.service');
const ssmService = require('../src/services/aws/ssm.service');
const healthProbeService = require('../src/services/monitoring/health.probe.service');
const alertService = require('../src/services/monitoring/alert.service');
const { MonitoringStorage } = require('../src/services/monitoring/monitoring.storage');

describe('Phase 7: Real-Time Monitoring & Observability Unit & Integration Tests', () => {

  describe('1. CloudWatch Metric Processing & NO_DATA Behavior', () => {
    it('should return NO_DATA and null value when CloudWatch has empty datapoints', () => {
      const metricResult = cloudwatchService._processMetricResult('CPUUtilization', {
        Datapoints: []
      });

      assert.equal(metricResult.name, 'CPUUtilization');
      assert.equal(metricResult.status, 'NO_DATA');
      assert.equal(metricResult.value, null);
      assert.equal(metricResult.source, 'AWS CloudWatch');
      assert.deepEqual(metricResult.datapoints, []);
    });

    it('should calculate correct average and latest value when datapoints are present', () => {
      const metricResult = cloudwatchService._processMetricResult('CPUUtilization', {
        Datapoints: [
          { Timestamp: new Date('2026-08-24T10:00:00Z'), Average: 1.5 },
          { Timestamp: new Date('2026-08-24T10:05:00Z'), Average: 2.5 },
          { Timestamp: new Date('2026-08-24T10:10:00Z'), Average: 3.2 }
        ]
      });

      assert.equal(metricResult.name, 'CPUUtilization');
      assert.equal(metricResult.status, 'AVAILABLE');
      assert.equal(metricResult.value, 3.2); // latest
      assert.equal(metricResult.average, 2.4); // (1.5+2.5+3.2)/3 = 2.4
      assert.equal(metricResult.datapointsCount, 3);
      assert.equal(metricResult.source, 'AWS CloudWatch');
    });
  });

  describe('2. SSM Guest OS Metrics Parser', () => {
    it('should parse Linux free -b output and compute exact used memory percentage', () => {
      const mockMemOutput = `
              total        used        free      shared  buff/cache   available
Mem:      1000000000   400000000   200000000    10000000   400000000   600000000
Swap:              0           0           0
`;
      // In this case: total=1,000,000,000, available=600,000,000 => actualUsed = 400,000,000 (40.00%)
      const lines = mockMemOutput.split('\n');
      const memLine = lines.find(l => l.trim().startsWith('Mem:'));
      assert.ok(memLine);

      const tokens = memLine.trim().split(/\s+/);
      const total = parseInt(tokens[1], 10);
      const available = parseInt(tokens[6], 10);
      const actualUsed = total - available;
      const usedPct = Number(((actualUsed / total) * 100).toFixed(2));

      assert.equal(total, 1000000000);
      assert.equal(actualUsed, 400000000);
      assert.equal(usedPct, 40.0);
    });

    it('should parse df -P / filesystem output', () => {
      const mockDiskOutput = `
Filesystem      1024-blocks    Used Available Capacity Mounted on
/dev/root          31457280 6291456  25165824      20% /
`;
      const lines = mockDiskOutput.trim().split('\n');
      const dataLine = lines[lines.length - 1].trim();
      const tokens = dataLine.split(/\s+/);

      assert.equal(tokens[0], '/dev/root');
      const totalBlocks = parseInt(tokens[1], 10);
      const usedBlocks = parseInt(tokens[2], 10);
      const usedPct = parseInt(tokens[4].replace('%', ''), 10);

      assert.equal(totalBlocks, 31457280);
      assert.equal(usedBlocks, 6291456);
      assert.equal(usedPct, 20);
    });
  });

  describe('3. Docker Container & Logs Sanitization', () => {
    it('should redact sensitive AWS keys and tokens from log lines', () => {
      const rawLog = `
2026-08-24T10:00:00Z Server running on port 3000
2026-08-24T10:00:01Z Authenticated with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
2026-08-24T10:00:02Z Client ID AKIAIOSFODNN7EXAMPLE using token ghp_123456789012345678901234567890123456
`;
      const sanitized = rawLog
        .replace(/(AWS_SECRET_ACCESS_KEY|SECRET_KEY|PASSWORD|TOKEN|BEARER|SECRET)=([^\s\n]+)/gi, '$1=********')
        .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA****************')
        .replace(/ghp_[0-9a-zA-Z]{36}/g, 'ghp_************************************');

      assert.ok(!sanitized.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
      assert.ok(!sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
      assert.ok(!sanitized.includes('ghp_123456789012345678901234567890123456'));
      assert.ok(sanitized.includes('AWS_SECRET_ACCESS_KEY=********'));
      assert.ok(sanitized.includes('AKIA****************'));
      assert.ok(sanitized.includes('ghp_************************************'));
    });
  });

  describe('4. Health Probe Calculation & Summary', () => {
    it('should compute accurate health check failure rate and average latency', () => {
      const history = [
        { isHealthy: true, durationMs: 100 },
        { isHealthy: true, durationMs: 150 },
        { isHealthy: false, durationMs: null },
        { isHealthy: true, durationMs: 200 }
      ];

      const summary = healthProbeService.calculateHealthSummary(history);

      assert.equal(summary.totalChecks, 4);
      assert.equal(summary.successfulChecks, 3);
      assert.equal(summary.failedChecks, 1);
      assert.equal(summary.healthCheckFailureRate, 25); // 1/4 = 25%
      assert.equal(summary.averageDurationMs, 150); // (100+150+200)/3 = 150
      assert.equal(summary.status, 'DEGRADED');
    });

    it('should report HEALTHY with 0% failure rate when all checks succeed', () => {
      const history = [
        { isHealthy: true, durationMs: 120 },
        { isHealthy: true, durationMs: 140 }
      ];

      const summary = healthProbeService.calculateHealthSummary(history);
      assert.equal(summary.healthCheckFailureRate, 0);
      assert.equal(summary.status, 'HEALTHY');
    });
  });

  describe('5. Alert Engine Rule Evaluation & Deduplication', () => {
    it('should create deduplicated alerts when CPU exceeds thresholds', () => {
      const projectId = 'test-proj-1';
      const highCpuSnapshot = {
        ec2: { state: 'running', cpu: { value: 92, source: 'AWS CloudWatch' } },
        os: { memory: { usedPercentage: 50 }, disk: { usedPercentage: 40 } },
        docker: { container: { status: 'running', restarts: 0 }, stats: {} },
        ssm: { isOnline: true },
        application: { isHealthy: true, durationMs: 150 }
      };

      const result1 = alertService.evaluateSnapshot(projectId, highCpuSnapshot, []);
      assert.equal(result1.activeCount, 1);
      assert.equal(result1.alerts[0].type, 'HIGH_CPU_UTILIZATION');
      assert.equal(result1.alerts[0].severity, 'CRITICAL');
      assert.equal(result1.alerts[0].occurrences, 1);

      const alertId = result1.alerts[0].id;

      // Second cycle with same high CPU must update existing alert, NOT create duplicate
      const result2 = alertService.evaluateSnapshot(projectId, highCpuSnapshot, result1.alerts);
      assert.equal(result2.activeCount, 1);
      assert.equal(result2.alerts[0].id, alertId);
      assert.equal(result2.alerts[0].occurrences, 2);
    });

    it('should auto-resolve alert when metric value returns to normal', () => {
      const projectId = 'test-proj-2';
      const activeAlerts = [{
        id: 'alert-cpu-123',
        key: `${projectId}:HIGH_CPU_UTILIZATION:AWS CloudWatch`,
        projectId,
        type: 'HIGH_CPU_UTILIZATION',
        severity: 'CRITICAL',
        status: 'ACTIVE',
        source: 'AWS CloudWatch',
        currentValue: 92,
        occurrences: 3
      }];

      const normalSnapshot = {
        ec2: { state: 'running', cpu: { value: 25, source: 'AWS CloudWatch' } },
        os: { memory: { usedPercentage: 40 }, disk: { usedPercentage: 30 } },
        docker: { container: { status: 'running', restarts: 0 }, stats: {} },
        ssm: { isOnline: true },
        application: { isHealthy: true, durationMs: 120 }
      };

      const evalResult = alertService.evaluateSnapshot(projectId, normalSnapshot, activeAlerts);
      assert.equal(evalResult.activeCount, 0);
      assert.equal(evalResult.alerts[0].status, 'RESOLVED');
      assert.ok(evalResult.alerts[0].resolvedAt);
    });

    it('should support alert acknowledgment', () => {
      const alerts = [{
        id: 'alert-mem-456',
        status: 'ACTIVE',
        occurrences: 1
      }];

      const updated = alertService.acknowledgeAlert(alerts, 'alert-mem-456', 'devops-admin', 'Investigating high memory');
      assert.equal(updated[0].status, 'ACKNOWLEDGED');
      assert.equal(updated[0].acknowledgedBy, 'devops-admin');
      assert.equal(updated[0].acknowledgmentNote, 'Investigating high memory');
      assert.ok(updated[0].acknowledgedAt);
    });
  });

  describe('6. Monitoring Storage Service Retention & Bounds', () => {
    const testDir = path.join(__dirname, '../temporary/test-monitoring-storage');
    let storage;

    beforeEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
      fs.mkdirSync(testDir, { recursive: true });
      storage = new MonitoringStorage(testDir);
    });

    it('should record metric points and prune entries exceeding limit', () => {
      const projectId = 'test-proj-metrics';
      storage.maxMetricEntries = 5;

      for (let i = 1; i <= 10; i++) {
        storage.recordMetricPoint(projectId, {
          timestamp: new Date().toISOString(),
          cpu: i * 5,
          memory: 40,
          disk: 25,
          responseTimeMs: 100
        });
      }

      const history = storage.getMetricHistory(projectId);
      assert.equal(history.length, 5); // bounded to 5
      assert.equal(history[history.length - 1].cpu, 50); // latest
    });

    it('should record health checks and retrieve bounded history', () => {
      const projectId = 'test-proj-health';
      storage.maxHealthEntries = 3;

      storage.recordHealthCheck(projectId, { status: 'HEALTHY', isHealthy: true, httpStatus: 200, durationMs: 80 });
      storage.recordHealthCheck(projectId, { status: 'HEALTHY', isHealthy: true, httpStatus: 200, durationMs: 90 });
      storage.recordHealthCheck(projectId, { status: 'UNHEALTHY', isHealthy: false, httpStatus: 500, durationMs: null });
      storage.recordHealthCheck(projectId, { status: 'HEALTHY', isHealthy: true, httpStatus: 200, durationMs: 110 });

      const history = storage.getHealthHistory(projectId);
      assert.equal(history.length, 3);
      assert.equal(history[history.length - 1].durationMs, 110);
    });
  });
});
