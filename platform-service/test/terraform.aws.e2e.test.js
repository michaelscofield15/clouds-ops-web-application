const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const terraformEngine = require('../src/services/terraform');
const terraformClient = require('../src/services/terraform/terraform.client');
const terraformGenerator = require('../src/services/terraform/terraform.generator');
const terraformPlanParser = require('../src/services/terraform/terraform.plan.parser');
const ecrService = require('../src/services/aws/ecr.service');
const awsClient = require('../src/services/aws/aws.client');
const storageService = require('../src/services/storage.service');

describe('Phase 8: Real AWS Cloud Terraform IaC Engine E2E Test', () => {
  const timestamp = Date.now();
  const shortId = timestamp.toString().slice(-6);
  const testProjectId = `tf-e2e-${shortId}`;
  const testProjectName = `tf-safe-${shortId}`;
  const region = 'ap-south-1';
  let workspaceDir;
  let tfOutputs = {};

  before(() => {
    storageService.createWorkspace(testProjectId);
    storageService.saveAnalysis(testProjectId, {
      project: { name: testProjectName },
      port: { value: 3000 },
      runtime: { name: 'Node.js', version: '20' }
    });
    workspaceDir = terraformEngine.stateService.getWorkspaceDir(testProjectId);
  });

  after(async () => {
    // Teardown test workspace directory
    try {
      storageService.deleteWorkspace(testProjectId);
    } catch {
      // Clean up
    }
  });

  it('1. should verify real Terraform CLI installation and AWS STS credentials', async () => {
    console.log('\n[E2E] 1. Checking Terraform CLI & AWS STS Identity...');
    const prereqs = await terraformEngine.checkPrerequisites();

    console.log(`   - Terraform Installed: ${prereqs.terraformInstalled} (Version: ${prereqs.terraformVersion})`);
    console.log(`   - Terraform Executable: ${prereqs.executablePath}`);
    console.log(`   - AWS Connected: ${prereqs.awsReady} (Account: ${prereqs.awsAccount}, Region: ${prereqs.awsRegion})`);

    assert.equal(prereqs.terraformInstalled, true, 'Terraform must be installed');
    assert.equal(prereqs.awsReady, true, 'AWS STS must be authenticated');
    assert.equal(prereqs.awsAccount, '892748150267', 'Must connect to the verified AWS Account 892748150267');
  });

  it('2. should generate isolated, production-grade Terraform configuration', () => {
    console.log(`\n[E2E] 2. Generating Terraform configuration for project '${testProjectId}'...`);
    const genResult = terraformGenerator.generate(
      workspaceDir,
      {
        projectId: testProjectId,
        project: { name: testProjectName },
        port: { value: 3000 }
      },
      {
        region,
        environment: 'e2e-test'
      }
    );

    console.log(`   - Workspace: ${genResult.workspaceDir}`);
    console.log(`   - Files Generated: ${genResult.filesGenerated.join(', ')}`);

    assert.ok(fs.existsSync(path.join(workspaceDir, 'versions.tf')));
    assert.ok(fs.existsSync(path.join(workspaceDir, 'provider.tf')));
    assert.ok(fs.existsSync(path.join(workspaceDir, 'ecr.tf')));
    assert.ok(fs.existsSync(path.join(workspaceDir, 'terraform.tfvars')));
  });

  it('3. should execute real terraform init and validate configuration', async () => {
    console.log('\n[E2E] 3. Executing real terraform init & validate...');
    const initRes = await terraformEngine.init(testProjectId, { region });
    console.log(`   - Init Status: ${initRes.status} (Duration: ${initRes.durationMs}ms)`);
    assert.equal(initRes.success, true);

    const valRes = await terraformEngine.validate(testProjectId, { region });
    console.log(`   - Validate Status: ${valRes.status} (Valid: ${valRes.isValid})`);
    assert.equal(valRes.isValid, true);
  });

  it('4. should execute real terraform plan and parse resource actions', async () => {
    console.log('\n[E2E] 4. Executing real terraform plan...');
    const planRes = await terraformEngine.plan(testProjectId, { region });

    console.log(`   - Plan Summary: ${planRes.plan.summary}`);
    console.log(`   - Resources to Add: ${planRes.plan.toAdd}`);
    console.log(`   - Resources to Change: ${planRes.plan.toChange}`);
    console.log(`   - Resources to Destroy: ${planRes.plan.toDestroy}`);

    assert.equal(planRes.success, true);
    assert.ok(planRes.plan.toAdd > 0, 'Plan should contain resources to add');
    assert.equal(planRes.plan.toDestroy, 0, 'Plan should contain 0 resources to destroy on initial creation');
  });

  it('5. should execute real terraform plan with target resource to test real AWS apply & verification', async () => {
    console.log('\n[E2E] 5. Planning and Applying targeted test resource (aws_ecr_repository.app)...');

    // Generate a targeted plan for ECR to run a safe, quick, and non-destructive real AWS verification
    const planTargetRes = await terraformClient.execute(
      workspaceDir,
      ['plan', '-no-color', '-target=aws_ecr_repository.app', '-out=tfplan_ecr'],
      { region }
    );
    assert.equal(planTargetRes.success, true);

    const applyRes = await terraformClient.execute(
      workspaceDir,
      ['apply', '-no-color', '-auto-approve', 'tfplan_ecr'],
      { region }
    );
    console.log(`   - Real Terraform Apply Output:\n${applyRes.stdout.split('\n').filter(l => l.includes('Apply complete') || l.includes('aws_ecr_repository')).join('\n')}`);
    assert.equal(applyRes.success, true);

    // Retrieve outputs
    tfOutputs = await terraformClient.output(workspaceDir);
    console.log(`   - Terraform Output ECR Repo Name: ${tfOutputs.ecr_repository_name || `cloudops-${testProjectName}`}`);
    console.log(`   - Terraform Output ECR Repo URL: ${tfOutputs.ecr_repository_url}`);

    assert.ok(tfOutputs.ecr_repository_url, 'ECR Repository URL output must be present');
  });

  it('6. should independently verify created AWS ECR repository via AWS SDK & AWS CLI', async () => {
    console.log('\n[E2E] 6. Independently verifying resource in AWS account 892748150267...');
    const repoName = tfOutputs.ecr_repository_name || `cloudops-${testProjectName}`;

    // 1. AWS SDK verification
    const sdkRepo = await ecrService.describeRepository(repoName, region);
    console.log(`   - AWS SDK Verified ECR Repo URI: ${sdkRepo.repositoryUri}`);
    assert.equal(sdkRepo.repositoryName, repoName);

    // 2. AWS CLI verification
    const cliOut = execSync(
      `aws ecr describe-repositories --repository-names ${repoName} --region ${region} --query 'repositories[0].[repositoryName,repositoryUri]' --output text`,
      { encoding: 'utf8' }
    ).trim();
    console.log(`   - AWS CLI Output: ${cliOut}`);
    assert.ok(cliOut.includes(repoName));
  });

  it('7. should confirm plan idempotency on second run', async () => {
    console.log('\n[E2E] 7. Running second terraform plan (targeted) to confirm idempotency...');
    const secondPlan = await terraformClient.execute(
      workspaceDir,
      ['plan', '-no-color', '-target=aws_ecr_repository.app'],
      { region }
    );

    const parsedSecond = terraformPlanParser.parseTextPlan(secondPlan.stdout);
    console.log(`   - Idempotency Summary: ${parsedSecond.summary}`);
    console.log(`   - Is Idempotent: ${parsedSecond.isIdempotent}`);

    assert.equal(parsedSecond.toAdd, 0, 'No resources should be added');
    assert.equal(parsedSecond.toChange, 0, 'No resources should be changed');
    assert.equal(parsedSecond.toDestroy, 0, 'No resources should be destroyed');
    assert.equal(parsedSecond.isIdempotent, true, 'Terraform must be completely idempotent');
  });

  it('8. should safely destroy test resources and verify cleanup in AWS', async () => {
    console.log('\n[E2E] 8. Executing real terraform destroy for test resources...');
    const destroyRes = await terraformClient.execute(
      workspaceDir,
      ['destroy', '-no-color', '-auto-approve', '-target=aws_ecr_repository.app'],
      { region }
    );
    console.log(`   - Destroy Output: ${destroyRes.stdout.split('\n').filter(l => l.includes('Destroy complete')).join(' ')}`);
    assert.equal(destroyRes.success, true);

    // Verify deletion in AWS
    const repoName = tfOutputs.ecr_repository_name || `cloudops-${testProjectName}`;
    try {
      await ecrService.describeRepository(repoName, region);
      assert.fail('ECR repository should no longer exist in AWS');
    } catch (err) {
      console.log(`   - AWS Verification: ECR Repository '${repoName}' successfully removed from AWS (${err.name || err.message}).`);
      assert.ok(err.name === 'RepositoryNotFoundException' || err.message.includes('does not exist') || err.statusCode === 404);
    }
  });
});
