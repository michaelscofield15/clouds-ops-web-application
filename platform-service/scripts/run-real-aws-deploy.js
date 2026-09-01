const fs = require('fs');
const path = require('path');
const db = require('../src/services/db/db.service');
const zipService = require('../src/services/zip.service');
const storageService = require('../src/services/storage.service');
const { analyzeProject } = require('../src/services/analyzer');
const dockerEngine = require('../src/services/docker');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');

function print(msg) {
  process.stdout.write(msg + '\n');
}

(async () => {
  try {
    const orgId = 'org-1f259383-f35e-4604-a8b0-fb1e0a0df7b7';
    const userId = 'usr-041a18da-fd35-4413-94a4-a797e946f56b';
    const zipPath = path.resolve('../cloudops-demo-app.zip');

    print('========================================================================');
    print('CLOUDOPS REAL AUTONOMOUS AWS PRODUCTION DEPLOYMENT');
    print('========================================================================\n');

    print('[1/8] Ingesting and verifying cloudops-demo-app.zip...');
    const zipBuffer = fs.readFileSync(zipPath);
    const projectId = 'cloudops-demo-' + Date.now().toString(36);

    const workspace = storageService.createWorkspace(projectId, orgId);
    const extractRes = zipService.extractSafely(zipBuffer, workspace.extractDir);
    print(`  ✔ Extracted ${extractRes.fileCount} files (SHA256: ${extractRes.checksum})`);

    print('\n[2/8] Analyzing project architecture & runtime requirements...');
    const analysis = analyzeProject(workspace.extractDir);
    storageService.saveAnalysis(projectId, analysis);
    const port = analysis.port?.value || 3000;
    print(`  ✔ Detected Runtime: ${analysis.project?.runtime || 'Node.js'} | Target Port: ${port}`);

    db.insert('projects', {
      id: projectId,
      organizationId: orgId,
      createdByUserId: userId,
      name: 'cloudops-demo-app',
      status: 'ANALYZED',
      runtime: analysis.project?.runtime || 'Node.js',
      analysisJson: JSON.stringify(analysis),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    print('\n[3/8] Building Docker container image with .dockerignore protection...');
    const dockerRes = await dockerEngine.dockerize(projectId);
    print(`  ✔ Docker image created: ${dockerRes.image?.tag || dockerRes.imageTag} (${dockerRes.image?.platform || 'native'})`);

    print('\n[4/8] Executing Real AWS Cloud Deployment Engine (ECR -> EC2 via SSM)...');
    const deployRes = await awsDeploymentService.deploy(projectId, {
      organizationId: orgId,
      region: 'ap-south-1'
    });

    print('\n========================================================================');
    print('✔ PRODUCTION DEPLOYMENT SUCCEEDED AND VERIFIED LIVE ON REAL AWS!');
    print('========================================================================');
    print(`Status:          ${deployRes.status}`);
    print(`Target Instance: ${deployRes.ec2?.instanceId} (${deployRes.ec2?.architecture} / ${deployRes.ec2?.platform})`);
    print(`Public IP:       ${deployRes.ec2?.publicIp}`);
    print(`Public DNS:      ${deployRes.ec2?.publicDns || 'N/A'}`);
    print(`ECR Repo URI:    ${deployRes.ecr?.repositoryUri}`);
    print(`ECR Image Tag:   ${deployRes.ecr?.imageTag}`);
    print(`ECR Manifest:    ${deployRes.ecr?.imageDigest}`);
    print(`Container Name:  ${deployRes.containerName}`);
    print(`Container ID:    ${deployRes.container?.containerId}`);
    print(`Port:            ${deployRes.port}`);
    print(`Live Endpoint:   ${deployRes.endpoint}`);
    print(`Health Check:    HTTP ${deployRes.health?.statusCode} (${deployRes.health?.status})`);
    print('========================================================================\n');

    process.exit(0);
  } catch (err) {
    print(`\n✖ DEPLOYMENT FAILED: ${err.message}`);
    if (err.stack) print(err.stack);
    process.exit(1);
  }
})();
