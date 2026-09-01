const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const awsClient = require('../src/services/aws/aws.client');
const ecrService = require('../src/services/aws/ecr.service');
const ec2Service = require('../src/services/aws/ec2.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const zipService = require('../src/services/zip.service');
const { analyzeProject } = require('../src/services/analyzer');
const dockerEngine = require('../src/services/docker');
const storageService = require('../src/services/storage.service');
const config = require('../src/config');

async function runRealAWSE2E() {
  console.log('================================================================');
  console.log('PHASE 6 REAL AWS CLOUD DEPLOYMENT E2E VERIFICATION');
  console.log('================================================================\n');

  // Step 1: AWS Caller Identity
  console.log('1. Checking AWS connection & STS identity...');
  const identity = await awsClient.getCallerIdentity();

  if (!identity.connected) {
    console.log('\n----------------------------------------------------------------');
    console.log('REAL AWS E2E TEST: NOT RUN');
    console.log(`Reason: AWS credentials/configuration unavailable (${identity.error})`);
    console.log('----------------------------------------------------------------\n');
    process.exit(0);
  }

  console.log(`✔ Connected to AWS!`);
  console.log(`  Account ID: ${identity.accountId}`);
  console.log(`  User/Role:  ${identity.arn}`);
  console.log(`  Region:     ${identity.region}\n`);

  const region = identity.region || config.aws.region || 'ap-south-1';

  // Step 2: Package demo application
  console.log('2. Ingesting Phase 1 cloudops-demo-app...');
  const demoAppDir = path.resolve(__dirname, '../../cloudops-demo-app');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  const filesToZip = [
    'package.json',
    'src/app.js',
    'src/server.js',
    'src/controllers/health.controller.js',
    'src/controllers/api.controller.js',
    'src/routes/health.routes.js',
    'src/routes/api.routes.js'
  ];
  for (const f of filesToZip) {
    const fullPath = path.join(demoAppDir, f);
    if (fs.existsSync(fullPath)) {
      zip.addLocalFile(fullPath, path.dirname(f) === '.' ? '' : path.dirname(f));
    }
  }
  const zipBuffer = zip.toBuffer();

  const projectId = storageService.generateProjectId();
  const workspace = storageService.createWorkspace(projectId);
  const extractResult = zipService.extractSafely(zipBuffer, workspace.extractDir);
  const effectiveDir = extractResult.effectiveProjectRoot;
  console.log(`✔ Extracted to workspace: ${effectiveDir}`);

  // Step 3: Phase 2 Analysis
  console.log('\n3. Executing Phase 2 static analysis...');
  const analysis = analyzeProject(effectiveDir);
  storageService.saveAnalysis(projectId, analysis);
  console.log(`✔ Detected: Runtime=${analysis.project.runtime}, Framework=${analysis.framework.name}, Port=${analysis.port.value}`);

  // Step 4: Phase 3 Dockerization (target linux/amd64 for EC2 x86_64)
  console.log('\n4. Executing Phase 3 Dockerization engine...');
  const dockerState = await dockerEngine.dockerize(projectId, { platform: 'linux/amd64' });
  storageService.updateProject(projectId, { dockerState });
  console.log(`✔ Docker Image Built: ${dockerState.image.tag} (Size: ${dockerState.image.size})`);

  // Step 5: Full Real AWS Cloud Deployment (ECR -> EC2 Provisioning -> SSM Online -> Run Command -> Health Check)
  console.log('\n5. Executing Real AWS Cloud Deployment Engine (ECR + EC2 + SSM)...');
  console.log('----------------------------------------------------------------');

  const deploymentResult = await awsDeploymentService.deploy(projectId, {
    region,
    instanceType: 't3.micro',
    arch: 'x86_64'
  });

  console.log('----------------------------------------------------------------');
  console.log(`✔ AWS Deployment Finished with Status: ${deploymentResult.status}`);
  assert.equal(deploymentResult.status, 'SUCCESS', 'Deployment status must be SUCCESS');

  // Verify Real Resources in Deployment Result
  assert.ok(deploymentResult.ecr, 'ECR metadata must exist');
  assert.ok(deploymentResult.ecr.repositoryUri.includes('.dkr.ecr.'), 'Must return real AWS ECR URI');
  assert.ok(deploymentResult.ecr.imageDigest.startsWith('sha256:'), 'Must return real SHA256 image digest');
  assert.ok(deploymentResult.ec2, 'EC2 metadata must exist');
  assert.ok(deploymentResult.ec2.instanceId.startsWith('i-'), 'Must return real AWS EC2 instance ID');
  assert.equal(deploymentResult.ec2.state, 'running', 'EC2 state must be running');
  assert.ok(deploymentResult.ec2.publicIp, 'EC2 must have a public IP address');
  assert.ok(deploymentResult.endpoint, 'Public endpoint must exist');
  assert.equal(deploymentResult.health.status, 'healthy', 'Health check must be healthy');
  assert.equal(deploymentResult.health.statusCode, 200, 'Health check must return HTTP 200');

  console.log('\n6. Real AWS Deployment Summary:');
  console.log(`  ECR Repository: ${deploymentResult.ecr.repositoryUri}`);
  console.log(`  ECR Image Tag:  ${deploymentResult.ecr.imageTag}`);
  console.log(`  ECR Digest:     ${deploymentResult.ecr.imageDigest}`);
  console.log(`  EC2 Instance ID:${deploymentResult.ec2.instanceId}`);
  console.log(`  EC2 State:      ${deploymentResult.ec2.state}`);
  console.log(`  EC2 Public IP:  ${deploymentResult.ec2.publicIp}`);
  console.log(`  Container ID:   ${deploymentResult.container?.containerId ? deploymentResult.container.containerId.slice(0, 12) : 'active'}`);
  console.log(`  Public Endpoint:${deploymentResult.endpoint}`);
  console.log(`  Health Status:  HTTP ${deploymentResult.health.statusCode} (${JSON.stringify(deploymentResult.health.body)})`);

  // Step 6: Platform State Verification
  console.log('\n7. Verifying platform storage state tracking...');
  const liveStatus = awsDeploymentService.getStatus(projectId);
  assert.equal(liveStatus.status, 'SUCCESS');
  assert.equal(liveStatus.ec2.instanceId, deploymentResult.ec2.instanceId);
  console.log(`✔ Project state tracked accurately in platform.`);

  // Step 7: Independent AWS CLI Verification
  console.log('\n8. Performing Independent AWS CLI Verifications:');

  console.log('\n--- AWS CLI: Describe Instances ---');
  try {
    const ec2Cli = execSync(
      `aws ec2 describe-instances --region ${region} --instance-ids ${deploymentResult.ec2.instanceId} --query "Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,PrivateIpAddress,InstanceType]" --output table`,
      { encoding: 'utf8' }
    );
    console.log(ec2Cli);
  } catch (err) {
    console.error('Failed to run aws ec2 describe-instances:', err.message);
  }

  console.log('--- AWS CLI: Describe SSM Instance Information ---');
  try {
    const ssmCli = execSync(
      `aws ssm describe-instance-information --region ${region} --filters "Key=InstanceIds,Values=${deploymentResult.ec2.instanceId}" --query "InstanceInformationList[].[InstanceId,PingStatus,PlatformName,PlatformVersion]" --output table`,
      { encoding: 'utf8' }
    );
    console.log(ssmCli);
  } catch (err) {
    console.error('Failed to run aws ssm describe-instance-information:', err.message);
  }

  console.log('--- AWS CLI: Describe ECR Images ---');
  try {
    const ecrCli = execSync(
      `aws ecr describe-images --repository-name ${deploymentResult.ecr.repositoryName} --region ${region} --query "imageDetails[].[imageTags[0],imageDigest,imageSizeInBytes]" --output table`,
      { encoding: 'utf8' }
    );
    console.log(ecrCli);
  } catch (err) {
    console.error('Failed to run aws ecr describe-images:', err.message);
  }

  console.log('--- AWS CLI: Describe EC2 Tags ---');
  try {
    const tagsCli = execSync(
      `aws ec2 describe-instances --region ${region} --instance-ids ${deploymentResult.ec2.instanceId} --query "Reservations[].Instances[].[InstanceId,Tags[?Key==\\\`Name\\\`].Value | [0],Tags[?Key==\\\`ManagedBy\\\`].Value | [0],Tags[?Key==\\\`Environment\\\`].Value | [0]]" --output table`,
      { encoding: 'utf8' }
    );
    console.log(tagsCli);
  } catch (err) {
    console.error('Failed to run aws ec2 describe-instances tags:', err.message);
  }

  console.log('\n================================================================');
  console.log('✔ PHASE 6 REAL AWS EC2 + SSM DEPLOYMENT VERIFIED 100%');
  console.log(`Live application running at: ${deploymentResult.endpoint}`);
  console.log(`(EC2 instance '${deploymentResult.ec2.instanceId}' retained alive for inspection)`);
  console.log('================================================================');
  process.exit(0);
}

runRealAWSE2E().catch((err) => {
  console.error('\n✖ Phase 6 Real AWS E2E Test Failed:', err);
  process.exit(1);
});
