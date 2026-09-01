const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const db = require('../src/services/db/db.service');
const storageService = require('../src/services/storage.service');
const ec2Service = require('../src/services/aws/ec2.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');

describe('Autonomous CloudOps Deployment Lifecycle & Persistence Suite', () => {
  const testOrgId = 'org-test-lifecycle-123';
  const testUserId = 'usr-test-lifecycle-123';
  const testProjectId = 'proj-lifecycle-test-app';

  beforeEach(() => {
    // Clear test collections for isolation
    db.clearAll();
  });

  it('1. Database correctly stores and queries multiple immutable deployment records per project', () => {
    const dep1 = {
      id: 'dep-test-001',
      projectId: testProjectId,
      organizationId: testOrgId,
      status: 'SUCCESS',
      isLive: true,
      publicUrl: 'http://15.206.74.0:3000',
      ec2InstanceId: 'i-0874001b523dee3c4',
      ec2Architecture: 'x86_64',
      imageTag: 'cloudops/app:build-001',
      imageDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      createdAt: '2026-09-01T10:00:00.000Z',
      logs: ['[DEPLOY] Success 1']
    };

    const dep2 = {
      id: 'dep-test-002',
      projectId: testProjectId,
      organizationId: testOrgId,
      status: 'FAILED',
      isLive: false,
      publicUrl: null,
      ec2InstanceId: 'i-0874001b523dee3c4',
      ec2Architecture: 'x86_64',
      imageTag: 'cloudops/app:build-002',
      imageDigest: null,
      errorMessage: 'Build syntax error in Dockerfile',
      createdAt: '2026-09-01T10:30:00.000Z',
      logs: ['[DEPLOY] Failure 2']
    };

    db.insert('deployments', dep1);
    db.insert('deployments', dep2);

    const allDeployments = db.findDeploymentsByProject(testProjectId);
    assert.strictEqual(allDeployments.length, 2, 'Should find exactly 2 deployment records');
    assert.strictEqual(allDeployments[0].id, 'dep-test-002', 'Deployments should be sorted by newest createdAt first');
    assert.strictEqual(allDeployments[1].id, 'dep-test-001');

    const liveDep = db.getLiveDeployment(testProjectId);
    assert.ok(liveDep, 'Live deployment should exist');
    assert.strictEqual(liveDep.id, 'dep-test-001');
    assert.strictEqual(liveDep.isLive, true);
    assert.strictEqual(liveDep.publicUrl, 'http://15.206.74.0:3000');
  });

  it('2. StorageService maintains liveDeployment vs latestDeployment metadata', () => {
    // Create initial project
    db.insert('projects', {
      id: testProjectId,
      name: 'Lifecycle Test App',
      organizationId: testOrgId,
      status: 'READY',
      analysisJson: JSON.stringify({ project: { name: 'Lifecycle Test App' }, port: 3000 })
    });

    // Successful deployment updates liveDeployment and latestDeployment
    storageService.updateProject(testProjectId, {
      liveDeploymentId: 'dep-test-001',
      liveUrl: 'http://15.206.74.0:3000',
      liveInstanceId: 'i-0874001b523dee3c4',
      liveStatus: 'LIVE',
      latestDeploymentId: 'dep-test-001',
      latestStatus: 'SUCCESS',
      targetInstanceId: 'i-0874001b523dee3c4'
    });

    let proj = storageService.getProject(testProjectId);
    assert.strictEqual(proj.liveDeploymentId, 'dep-test-001');
    assert.strictEqual(proj.liveUrl, 'http://15.206.74.0:3000');
    assert.strictEqual(proj.latestStatus, 'SUCCESS');
    assert.strictEqual(proj.targetInstanceId, 'i-0874001b523dee3c4');

    // Subsequent failed deployment updates latestDeployment WITHOUT touching live deployment
    storageService.updateProject(testProjectId, {
      latestDeploymentId: 'dep-test-002',
      latestStatus: 'FAILED'
    });

    proj = storageService.getProject(testProjectId);
    assert.strictEqual(proj.liveDeploymentId, 'dep-test-001', 'liveDeploymentId must NOT be changed on failed deployment');
    assert.strictEqual(proj.liveUrl, 'http://15.206.74.0:3000', 'liveUrl must NOT be cleared on failed deployment');
    assert.strictEqual(proj.liveStatus, 'LIVE');
    assert.strictEqual(proj.latestDeploymentId, 'dep-test-002');
    assert.strictEqual(proj.latestStatus, 'FAILED');
  });

  it('3. EC2 Quota checker rejects provisioning when vCPU capacity is exhausted', async () => {
    // Mock client that returns 4 running t3.micro instances (8 vCPUs)
    const mockClient = {
      getEC2Client: () => ({
        send: async () => ({
          Reservations: [
            { Instances: [{ InstanceId: 'i-1', InstanceType: 't3.micro', State: { Name: 'running' } }] },
            { Instances: [{ InstanceId: 'i-2', InstanceType: 't3.micro', State: { Name: 'running' } }] },
            { Instances: [{ InstanceId: 'i-3', InstanceType: 't3.micro', State: { Name: 'running' } }] },
            { Instances: [{ InstanceId: 'i-4', InstanceType: 't3.micro', State: { Name: 'running' } }] }
          ]
        })
      })
    };

    const quotaResult = await ec2Service.checkVcpuQuota('ap-south-1', 2, mockClient, 8);
    assert.strictEqual(quotaResult.currentUsage, 8, 'Current usage should be 8 vCPUs (4 x 2)');
    assert.strictEqual(quotaResult.quota, 8);
    assert.strictEqual(quotaResult.available, 0);
    assert.strictEqual(quotaResult.allowed, false, 'Provisioning additional instance must be disallowed');
  });

  it('4. EC2 Quota checker permits provisioning when capacity is available', async () => {
    // Mock client that returns 1 running t3.micro instance (2 vCPUs)
    const mockClient = {
      getEC2Client: () => ({
        send: async () => ({
          Reservations: [
            { Instances: [{ InstanceId: 'i-1', InstanceType: 't3.micro', State: { Name: 'running' } }] }
          ]
        })
      })
    };

    const quotaResult = await ec2Service.checkVcpuQuota('ap-south-1', 2, mockClient, 8);
    assert.strictEqual(quotaResult.currentUsage, 2);
    assert.strictEqual(quotaResult.available, 6);
    assert.strictEqual(quotaResult.allowed, true);
  });

  it('5. EC2 Service finds and reuses compatible project instance', async () => {
    const mockClient = {
      getEC2Client: () => ({
        send: async (cmd) => {
          return {
            Reservations: [{
              Instances: [{
                InstanceId: 'i-0874001b523dee3c4',
                InstanceType: 't3.micro',
                State: { Name: 'running' },
                PublicIpAddress: '15.206.74.0',
                PublicDnsName: 'ec2-15-206-74-0.ap-south-1.compute.amazonaws.com',
                Architecture: 'x86_64',
                Placement: { AvailabilityZone: 'ap-south-1a' },
                Tags: [
                  { Key: 'TenantId', Value: testOrgId },
                  { Key: 'ProjectId', Value: testProjectId },
                  { Key: 'ManagedBy', Value: 'CloudOps' }
                ]
              }]
            }]
          };
        }
      })
    };

    const instance = await ec2Service.findCompatibleProjectInstance(testProjectId, testOrgId, 'ap-south-1', mockClient);
    assert.ok(instance, 'Should find matching compatible instance');
    assert.strictEqual(instance.instanceId, 'i-0874001b523dee3c4');
    assert.strictEqual(instance.publicIp, '15.206.74.0');
    assert.strictEqual(instance.architecture, 'x86_64');
    assert.strictEqual(instance.platform, 'linux/amd64');
  });

  it('6. Cleanup preserves live instance and deletes only ephemeral failed instance', async () => {
    const terminatedIds = [];
    const mockClient = {
      getEC2Client: () => ({
        send: async (cmd) => {
          if (cmd.constructor.name === 'TerminateInstancesCommand') {
            terminatedIds.push(cmd.input.InstanceIds[0]);
            return { TerminatingInstances: [{ InstanceId: cmd.input.InstanceIds[0], CurrentState: { Name: 'shutting-down' } }] };
          }
          return {};
        }
      })
    };

    // Case A: Newly provisioned ephemeral instance fails -> should terminate
    const resA = await ec2Service.cleanupFailedDeploymentResources(
      'dep-fail-1',
      { instanceId: 'i-ephemeral-fail' },
      'i-0874001b523dee3c4', // live instance
      'ap-south-1',
      mockClient
    );
    assert.strictEqual(resA.cleaned, true);
    assert.strictEqual(resA.terminatedInstanceId, 'i-ephemeral-fail');
    assert.ok(terminatedIds.includes('i-ephemeral-fail'));

    // Case B: Failure on existing live instance -> MUST NEVER terminate live instance
    const resB = await ec2Service.cleanupFailedDeploymentResources(
      'dep-fail-2',
      { instanceId: 'i-0874001b523dee3c4' }, // matches live instance
      'i-0874001b523dee3c4',
      'ap-south-1',
      mockClient
    );
    assert.strictEqual(resB.cleaned, true);
    assert.strictEqual(terminatedIds.length, 1, 'Live instance must NOT be in terminatedIds');
  });

  it('7. AWSDeploymentService getStatus properly separates liveDeployment and latestDeployment', () => {
    // Insert historical deployments
    db.insert('deployments', {
      id: 'dep-001',
      projectId: testProjectId,
      status: 'SUCCESS',
      isLive: true,
      publicUrl: 'http://15.206.74.0:3000',
      ec2InstanceId: 'i-0874001b523dee3c4',
      ec2Architecture: 'x86_64',
      imageTag: 'cloudops/app:v1',
      createdAt: '2026-09-01T10:00:00.000Z',
      logs: ['[DEPLOY] v1 Success']
    });

    db.insert('deployments', {
      id: 'dep-002',
      projectId: testProjectId,
      status: 'FAILED',
      isLive: false,
      publicUrl: null,
      errorMessage: 'SSM timeout',
      createdAt: '2026-09-01T10:15:00.000Z',
      logs: ['[DEPLOY] v2 Failure']
    });

    const status = awsDeploymentService.getStatus(testProjectId);
    assert.strictEqual(status.status, 'FAILED', 'Overall status reflects latest deployment attempt');
    assert.strictEqual(status.liveStatus, 'LIVE', 'Live status remains LIVE');
    assert.ok(status.liveDeployment, 'liveDeployment object is present');
    assert.strictEqual(status.liveDeployment.id, 'dep-001');
    assert.strictEqual(status.liveDeployment.publicUrl, 'http://15.206.74.0:3000');
    assert.strictEqual(status.endpoint, 'http://15.206.74.0:3000');
    assert.strictEqual(status.liveUrl, 'http://15.206.74.0:3000');
    assert.ok(status.latestDeployment, 'latestDeployment object is present');
    assert.strictEqual(status.latestDeployment.id, 'dep-002');
  });
});
