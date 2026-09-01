const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');

const terraformClient = require('../src/services/terraform/terraform.client');
const terraformGenerator = require('../src/services/terraform/terraform.generator');
const terraformPlanParser = require('../src/services/terraform/terraform.plan.parser');
const terraformStateService = require('../src/services/terraform/terraform.state.service');
const terraformEngine = require('../src/services/terraform');
const storageService = require('../src/services/storage.service');

describe('Phase 8: Real Terraform IaC Engine Unit & Integration Tests', () => {
  const testDir = path.join(__dirname, '../temporary/test-terraform-unit');

  before(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('1. should detect Terraform installation, version, and host architecture', async () => {
    const prereqs = await terraformClient.checkPrerequisites();
    assert.equal(typeof prereqs.terraformInstalled, 'boolean');
    if (prereqs.terraformInstalled) {
      assert.ok(prereqs.terraformVersion, 'Terraform version should be detected');
      assert.ok(prereqs.executablePath, 'Executable path should be detected');
      assert.ok(prereqs.os, 'OS should be detected');
      assert.ok(prereqs.arch, 'Architecture should be detected');
    }
  });

  it('2. should generate structured Terraform configuration files from project analysis', () => {
    const projectAnalysis = {
      projectId: 'test-tf-gen-01',
      project: { name: 'sample-express-service' },
      port: { value: 4000 },
      runtime: { name: 'Node.js', version: '20' }
    };

    const workspace = path.join(testDir, 'gen-test');
    const result = terraformGenerator.generate(workspace, projectAnalysis, {
      region: 'ap-south-1',
      environment: 'staging'
    });

    assert.equal(result.projectId, 'test-tf-gen-01');
    assert.ok(result.filesGenerated.includes('versions.tf'));
    assert.ok(result.filesGenerated.includes('provider.tf'));
    assert.ok(result.filesGenerated.includes('variables.tf'));
    assert.ok(result.filesGenerated.includes('locals.tf'));
    assert.ok(result.filesGenerated.includes('network.tf'));
    assert.ok(result.filesGenerated.includes('security.tf'));
    assert.ok(result.filesGenerated.includes('iam.tf'));
    assert.ok(result.filesGenerated.includes('ecr.tf'));
    assert.ok(result.filesGenerated.includes('ec2.tf'));
    assert.ok(result.filesGenerated.includes('outputs.tf'));
    assert.ok(result.filesGenerated.includes('terraform.tfvars'));

    const variablesContent = fs.readFileSync(path.join(workspace, 'variables.tf'), 'utf8');
    assert.ok(variablesContent.includes('variable "project_id"'));
    assert.ok(variablesContent.includes('variable "application_port"'));

    const tfvarsContent = fs.readFileSync(path.join(workspace, 'terraform.tfvars'), 'utf8');
    assert.ok(tfvarsContent.includes('application_port    = 4000'));
    assert.ok(tfvarsContent.includes('aws_region          = "ap-south-1"'));
  });

  it('3. should parse structured Terraform show JSON plan correctly', () => {
    const samplePlanJson = {
      format_version: '1.2',
      terraform_version: '1.15.8',
      resource_changes: [
        {
          address: 'aws_vpc.app',
          type: 'aws_vpc',
          name: 'app',
          change: { actions: ['create'] }
        },
        {
          address: 'aws_security_group.app',
          type: 'aws_security_group',
          name: 'app',
          change: { actions: ['update'] }
        },
        {
          address: 'aws_instance.app',
          type: 'aws_instance',
          name: 'app',
          change: { actions: ['delete'] }
        }
      ]
    };

    const parsed = terraformPlanParser.parseJsonPlan(samplePlanJson);
    assert.equal(parsed.toAdd, 1);
    assert.equal(parsed.toChange, 1);
    assert.equal(parsed.toDestroy, 1);
    assert.equal(parsed.isDestructive, true);
    assert.equal(parsed.isIdempotent, false);
    assert.ok(parsed.summary.includes('1 to add, 1 to change, 1 to destroy'));
  });

  it('4. should detect idempotent plan (0 to add, 0 to change, 0 to destroy)', () => {
    const sampleIdempotentPlan = {
      resource_changes: [
        {
          address: 'aws_vpc.app',
          type: 'aws_vpc',
          name: 'app',
          change: { actions: ['no-op'] }
        }
      ]
    };

    const parsed = terraformPlanParser.parseJsonPlan(sampleIdempotentPlan);
    assert.equal(parsed.toAdd, 0);
    assert.equal(parsed.toChange, 0);
    assert.equal(parsed.toDestroy, 0);
    assert.equal(parsed.isIdempotent, true);
    assert.equal(parsed.isDestructive, false);
  });

  it('5. should enforce workspace concurrency locking per project', () => {
    const pId = 'proj-lock-test';
    terraformClient.acquireLock(pId);
    assert.throws(
      () => {
        terraformClient.acquireLock(pId);
      },
      /Concurrent Terraform operation in progress/
    );
    terraformClient.releaseLock(pId);
    assert.doesNotThrow(() => {
      terraformClient.acquireLock(pId);
      terraformClient.releaseLock(pId);
    });
  });

  it('6. should mask sensitive AWS access keys and tokens in output', () => {
    const sensitive = 'Exporting AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and AKIAIOSFODNN7EXAMPLE';
    const masked = terraformClient._maskOutput(sensitive);
    assert.ok(!masked.includes('wJalrXUtnFEMI'));
    assert.ok(masked.includes('AKIA****************'));
  });

  it('7. should execute real terraform init and validate on generated configuration', async () => {
    if (!terraformClient.executablePath) return;

    const workspace = path.join(testDir, 'real-init-test');
    terraformGenerator.generate(workspace, {
      projectId: 'real-init-p1',
      project: { name: 'real-app' },
      port: { value: 3000 }
    });

    const initRes = await terraformClient.init(workspace);
    assert.equal(initRes.success, true);
    assert.ok(fs.existsSync(path.join(workspace, '.terraform')));

    const valRes = await terraformClient.validate(workspace);
    assert.equal(valRes.isValid, true);
  });

  it('8. should enforce destroy safety gate when apply contains destructive actions', async () => {
    const pId = 'proj-destroy-safety';
    storageService.createWorkspace(pId);
    storageService.saveAnalysis(pId, { project: { name: 'app' }, port: { value: 3000 } });

    // Mock a destructive state in plan
    terraformStateService.saveState(pId, {
      status: 'PLANNED',
      plan: {
        toAdd: 0,
        toChange: 0,
        toDestroy: 1,
        isDestructive: true
      }
    });

    await assert.rejects(
      async () => {
        await terraformEngine.apply(pId, { confirmDestroy: false });
      },
      /Safety Alert: Terraform plan contains 1 destructive action/
    );

    storageService.deleteWorkspace(pId);
  });

  it('9. should handle GET /api/terraform/status and project endpoints', async () => {
    const res1 = await request(app).get('/api/terraform/status');
    assert.equal(res1.status, 200);
    assert.ok('terraformInstalled' in res1.body);

    const pId = 'proj-api-tf-test';
    storageService.createWorkspace(pId);
    storageService.saveAnalysis(pId, { project: { name: 'api-app' }, port: { value: 3000 } });

    const res2 = await request(app).get(`/api/projects/${pId}/terraform/status`);
    assert.equal(res2.status, 200);
    assert.equal(res2.body.status, 'NOT_INITIALIZED');

    const res3 = await request(app).post(`/api/projects/${pId}/terraform/generate`).send({ port: 8080 });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.success, true);

    const res4 = await request(app).get(`/api/projects/${pId}/terraform/logs`);
    assert.equal(res4.status, 200);
    assert.ok(res4.body.logs.length > 0);

    storageService.deleteWorkspace(pId);
  });
});
