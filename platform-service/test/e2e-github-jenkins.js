const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const githubAuth = require('../src/services/github/github.auth');
const githubClient = require('../src/services/github/github.client');
const gitClient = require('../src/services/git/git.client');
const secretScanner = require('../src/services/git/secret.scanner');
const pipelineGenerator = require('../src/services/jenkins/pipeline.generator');
const jenkinsClient = require('../src/services/jenkins/jenkins.client');
const storageService = require('../src/services/storage.service');
const zipService = require('../src/services/zip.service');

async function runRealGitHubJenkinsE2E() {
  console.log('================================================================');
  console.log('PHASE 4 REAL GITHUB → JENKINS E2E PRODUCTION VERIFICATION');
  console.log('================================================================\n');

  // Step 1: Retrieve GitHub token from system keychain / environment
  let token = process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      const creds = execSync('printf "protocol=https\\nhost=github.com\\n" | git credential-osxkeychain get', { encoding: 'utf8' });
      for (const line of creds.split('\n')) {
        if (line.startsWith('password=')) token = line.slice(9).trim();
      }
    } catch {
      // ignore
    }
  }

  if (!token) {
    throw new Error('AUTHENTICATION_REQUIRED: No valid GitHub token found in environment or keychain.');
  }

  githubAuth.setToken(token);

  // Step 2: Authenticate and retrieve user account
  console.log('1. Authenticating with GitHub API...');
  const account = await githubClient.getAccount(token);
  console.log(`✔ Authenticated as GitHub user: @${account.username} (${account.name || 'N/A'})`);

  // Step 3: Retrieve real GitHub repositories
  console.log('\n2. Retrieving repositories via GitHub API...');
  const repos = await githubClient.listRepositories(token);
  console.log(`✔ Found ${repos.length} accessible repositories:`);
  repos.slice(0, 5).forEach(r => console.log(`   - ${r.fullName} (private: ${r.private})`));

  // Step 4: Target real repository (use existing or create a dedicated live test repo)
  let targetRepoFullName = process.env.GITHUB_REPO || 'jaswanthyalavarthi23-svg/Capstone-project-main';
  const repoExists = repos.some(r => r.fullName.toLowerCase() === targetRepoFullName.toLowerCase());
  
  if (!repoExists) {
    // If not found in list, pick the user's primary repo
    const userRepo = repos.find(r => r.owner.toLowerCase() === account.username.toLowerCase());
    if (userRepo) {
      targetRepoFullName = userRepo.fullName;
    } else {
      console.log(`\nRepository '${targetRepoFullName}' not found. Creating dedicated test repository...`);
      const newRepo = await githubClient.createRepository(token, {
        name: 'cloudops-live-workload',
        description: 'Automated test repository for Autonomous DevOps Platform',
        private: true
      });
      targetRepoFullName = newRepo.fullName;
      console.log(`✔ Created repository: ${targetRepoFullName}`);
    }
  }
  console.log(`✔ Selected Target Repository: ${targetRepoFullName}`);

  const [owner, repoName] = targetRepoFullName.split('/');

  // Step 5: Query existing branches
  console.log(`\n3. Querying branches for ${targetRepoFullName}...`);
  try {
    const branches = await githubClient.listBranches(token, owner, repoName);
    console.log(`✔ Found ${branches.length} branches: ${branches.map(b => b.name).join(', ')}`);
  } catch (err) {
    console.log(`(Repository is currently empty or initialized: ${err.message})`);
  }

  // Step 6: Ingest and prepare real project workspace
  console.log('\n4. Ingesting Phase 1 cloudops-demo-app project...');
  const zipPath = path.resolve('../cloudops-demo-app.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Test archive not found at ${zipPath}`);
  }
  const zipBuffer = fs.readFileSync(zipPath);
  const projectId = storageService.generateProjectId();
  const workspace = storageService.createWorkspace(projectId);
  zipService.extractSafely(zipBuffer, workspace.extractDir);
  console.log(`✔ Extracted to workspace: ${workspace.extractDir}`);

  // Step 7: Pre-push Secret Scan
  console.log('\n5. Executing Pre-Push Secret Scan on project workspace...');
  const scanResult = secretScanner.scanDirectory(workspace.extractDir);
  if (!scanResult.passed) {
    throw new Error(`PRE-PUSH SECRET SCAN FAILED: ${scanResult.findingsCount} secrets detected! Halting push.`);
  }
  console.log('✔ Pre-Push Secret Scan PASSED: Zero credentials or secret keys detected.');

  // Step 8: Generate production Dockerfile & Jenkinsfile
  console.log('\n6. Generating Phase 3 Dockerfile and Declarative Jenkinsfile for GitHub CI/CD...');
  const dockerfileGenerator = require('../src/services/docker/dockerfile.generator');
  dockerfileGenerator.prepareDockerfile(workspace.extractDir, {
    project: { name: 'cloudops-demo-app' },
    packageManager: 'npm',
    entryPoint: { value: 'src/server.js' },
    port: { value: 3000 }
  });
  console.log('✔ Dockerfile generated.');

  const jenkinsfile = pipelineGenerator.generate({
    project: { name: 'cloudops-demo-app' },
    packageManager: 'npm',
    port: { value: 3000 }
  });
  fs.writeFileSync(path.join(workspace.extractDir, 'Jenkinsfile'), jenkinsfile, 'utf8');
  console.log('✔ Jenkinsfile written to project root.');

  // Step 9: Initialize Git, Commit, and Push to REAL GitHub
  const targetBranch = `cloudops/live-ci-${Date.now().toString().slice(-6)}`;
  console.log(`\n7. Pushing actual project files to GitHub repository: ${targetRepoFullName} on branch: ${targetBranch}...`);

  await gitClient.init(workspace.extractDir);
  await gitClient.checkoutBranch(workspace.extractDir, targetBranch);
  const commitRes = await gitClient.addAndCommit(workspace.extractDir, `feat: automated CloudOps CI/CD provisioning [build-${projectId.slice(0, 8)}]`);
  console.log(`✔ Created local Git commit SHA: ${commitRes.hash}`);

  const authUrl = `https://x-access-token:${token}@github.com/${targetRepoFullName}.git`;
  await gitClient.push(workspace.extractDir, authUrl, targetBranch, true);
  console.log(`✔ Successfully pushed to GitHub: https://github.com/${targetRepoFullName}/tree/${targetBranch}`);

  // Step 10: Verify commit via GitHub REST API
  console.log('\n8. Verifying commit via GitHub REST API...');
  const ghCommit = await githubClient.verifyCommit(token, owner, repoName, commitRes.hash);
  const authorName = typeof ghCommit.author === 'string' ? ghCommit.author : (ghCommit.author?.login || account.username);
  console.log(`✔ Verified on GitHub API: SHA ${ghCommit.sha.slice(0, 7)} exists! Author: @${authorName}, Message: "${ghCommit.message.split('\n')[0]}"`);

  // Step 11: Configure Real Jenkins Pipeline Job with GitHub SCM
  console.log('\n9. Configuring Real Jenkins Pipeline Job with GitHub SCM...');
  const jenkinsJobName = `cloudops-github-e2e-${Date.now().toString().slice(-6)}`;
  const gitHubHttpsUrl = `https://github.com/${targetRepoFullName}.git`;

  // Provision GitHub token credential into Jenkins credential store
  await jenkinsClient.ensureGitHubCredentials('cloudops-github-token', token);

  const jobRes = await jenkinsClient.createOrUpdateJob(jenkinsJobName, {
    gitRepoUrl: gitHubHttpsUrl,
    branchName: targetBranch,
    credentialsId: 'cloudops-github-token'
  });
  console.log(`✔ Jenkins Pipeline Job provisioned: ${jobRes.jobName} (URL: ${jobRes.url})`);

  // Step 12: Trigger Build on Jenkins
  console.log('\n10. Triggering build on Jenkins server...');
  const triggerRes = await jenkinsClient.triggerBuild(jenkinsJobName);
  const buildNumber = triggerRes.buildNumber || 1;
  console.log(`✔ Build triggered! Waiting for Build #${buildNumber} execution...`);

  // Step 13: Poll Jenkins build status
  let buildInfo;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    buildInfo = await jenkinsClient.getBuildInfo(jenkinsJobName, buildNumber);
    if (buildInfo && !buildInfo.building && buildInfo.result) {
      break;
    }
    process.stdout.write(`   Polling build status: ${buildInfo ? (buildInfo.building ? 'BUILDING' : buildInfo.result) : 'QUEUED'}...\r`);
  }
  console.log('\n');

  // Step 14: Retrieve and verify real Jenkins Console Logs
  console.log('11. Retrieving live Jenkins Console Logs...');
  const logsData = await jenkinsClient.getBuildLogs(jenkinsJobName, buildNumber);
  console.log('================================================================');
  console.log(`JENKINS CONSOLE LOGS (${jenkinsJobName} #${buildNumber})`);
  console.log('================================================================');
  console.log(logsData.logs.slice(-2500));
  console.log('================================================================\n');

  // Cleanup test job on Jenkins
  await jenkinsClient.deleteJob(jenkinsJobName);
  console.log(`✔ Cleaned up test job: ${jenkinsJobName}`);

  // Final verification assertion
  if (buildInfo.result !== 'SUCCESS') {
    throw new Error(`REAL JENKINS BUILD FAILED with status: ${buildInfo.result}`);
  }

  console.log('================================================================');
  console.log('✔ PHASE 4 REAL GITHUB → JENKINS E2E WORKFLOW PASSED 100%');
  console.log('================================================================');
}

runRealGitHubJenkinsE2E().catch(err => {
  console.error('\n✖ E2E Verification Failed:', err.message);
  process.exit(1);
});
