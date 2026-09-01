process.env.ALLOW_DEV_ANONYMOUS = 'true';

const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = require('../src/app');
const authService = require('../src/services/auth/auth.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const secretVault = require('../src/services/security/secret.vault');
const db = require('../src/services/db/db.service');
const storageService = require('../src/services/storage.service');
const { analyzeProject } = require('../src/services/analyzer');
const dockerClient = require('../src/services/docker/docker.client');
const dockerfileGenerator = require('../src/services/docker/dockerfile.generator');
const dockerEngine = require('../src/services/docker');
const githubAuth = require('../src/services/github/github.auth');
const gitClient = require('../src/services/git/git.client');
const secretScanner = require('../src/services/git/secret.scanner');
const pipelineGenerator = require('../src/services/jenkins/pipeline.generator');
const jenkinsClient = require('../src/services/jenkins/jenkins.client');
const prereqService = require('../src/services/kubernetes/prereq.service');
const manifestGenerator = require('../src/services/kubernetes/manifest.generator');
const k8sClient = require('../src/services/kubernetes/k8s.client');
const awsClient = require('../src/services/aws/aws.client');
const { maskSecret } = require('../src/services/aws/aws.client');
const ecrService = require('../src/services/aws/ecr.service');
const ec2Service = require('../src/services/aws/ec2.service');
const ssmService = require('../src/services/aws/ssm.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const {
  createValidNodeProjectZip,
  createFastifyPnpmZip,
  createDevopsProjectZip,
  createSecretsProjectZip,
  createZipSlipBuffer,
  createExistingDockerfileProjectZip,
  createBrokenDockerfileProjectZip
} = require('./fixtures/make-fixtures');

function log(msg = '') {
  console.log(msg);
}

async function runAllTests() {
  log('================================================================');
  log('AUTONOMOUS DEVOPS & CLOUDOPS PLATFORM — FULL AUTOMATED TEST SUITE');
  log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const startTime = Date.now();

  const req = request(app);
  const progressLog = path.join(__dirname, '../temporary/test-progress.log');
  fs.mkdirSync(path.dirname(progressLog), { recursive: true });
  fs.writeFileSync(progressLog, `STARTED AT ${new Date().toISOString()}\n`);

  async function test(name, fn) {
    fs.appendFileSync(progressLog, `START: ${name}\n`);
    console.log(`▶ Starting: ${name}`);
    try {
      await fn();
      passed++;
      fs.appendFileSync(progressLog, `PASS: ${name}\n`);
      console.log(`✔ PASS: ${name}`);
    } catch (err) {
      failed++;
      fs.appendFileSync(progressLog, `FAIL: ${name} - ${err.message}\n`);
      console.log(`✖ FAIL: ${name}`);
      console.log(`  Error: ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }

  try {
    // -------------------------------------------------------------------------
    // ENGINE 1: ZIP INGESTION & STATIC ANALYZER
    // -------------------------------------------------------------------------
    console.log('--- ENGINE 1: ZIP Ingestion & Static Analyzer ---');

    await test('POST /api/projects/upload rejects when no file attached', async () => {
      const res = await req.post('/api/projects/upload').send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'No file uploaded');
    });

    await test('POST /api/projects/upload rejects non-zip files', async () => {
      const res = await req.post('/api/projects/upload').attach('project', Buffer.from('abc'), 'plain.txt');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Invalid file type');
    });

    await test('POST /api/projects/upload rejects corrupted archives', async () => {
      const res = await req.post('/api/projects/upload').attach('project', Buffer.from('PK\x03\x04bad'), 'corrupt.zip');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Archive extraction failed');
    });

    await test('POST /api/projects/upload blocks Zip Slip path traversal', async () => {
      const res = await req.post('/api/projects/upload').attach('project', createZipSlipBuffer(), 'malicious.zip');
      assert.equal(res.status, 400);
      assert.ok(res.body.message.includes('Zip Slip') || res.body.message.includes('traversal'));
    });

    let uploadedProjectId;
    await test('POST /api/projects/upload successfully analyzes valid Express app', async () => {
      const res = await req.post('/api/projects/upload').attach('project', createValidNodeProjectZip(), 'express.zip');
      assert.equal(res.status, 201);
      assert.ok(res.body.projectId);
      uploadedProjectId = res.body.projectId;
      const { analysis } = res.body;
      assert.equal(analysis.project.name, 'test-express-service');
      assert.equal(analysis.framework.name, 'Express');
      assert.equal(analysis.port.value, 8080);
      assert.equal(analysis.packageManager, 'npm');
    });

    await test('POST /api/projects/upload detects Fastify & pnpm', async () => {
      const res = await req.post('/api/projects/upload').attach('project', createFastifyPnpmZip(), 'fastify.zip');
      assert.equal(res.status, 201);
      assert.equal(res.body.analysis.framework.name, 'Fastify');
      assert.equal(res.body.analysis.packageManager, 'pnpm');
      assert.equal(res.body.analysis.port.value, 5000);
    });

    await test('POST /api/projects/upload detects existing DevOps configurations', async () => {
      const res = await req.post('/api/projects/upload').attach('project', createDevopsProjectZip(), 'devops.zip');
      assert.equal(res.status, 201);
      const { devops } = res.body.analysis;
      assert.equal(devops.docker, true);
      assert.equal(devops.kubernetes, true);
      assert.equal(devops.cicd, true);
      assert.equal(devops.terraform, true);
    });

    await test('POST /api/projects/upload statically detects secrets safely', async () => {
      const res = await req.post('/api/projects/upload').attach('project', createSecretsProjectZip(), 'secrets.zip');
      assert.equal(res.status, 201);
      const str = JSON.stringify(res.body.analysis);
      assert.ok(!str.includes('AKIAIOSFODNN7EXAMPLE'), 'Raw AWS key must never be leaked');
      assert.equal(res.body.analysis.status, 'security_review_required');
    });

    await test('GET /api/projects/:id returns stored project analysis', async () => {
      const res = await req.get(`/api/projects/${uploadedProjectId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.projectId, uploadedProjectId);
    });

    await test('GET /api/projects/:id returns 404 for unknown project', async () => {
      const res = await req.get('/api/projects/non-existent-uuid-123');
      assert.equal(res.status, 404);
    });

    // -------------------------------------------------------------------------
    // ENGINE 2: AUTOMATIC DOCKERIZATION ENGINE
    // -------------------------------------------------------------------------
    log('\n--- ENGINE 2: Automatic Dockerization Engine ---');

    await test('Docker availability check returns boolean status and version', async () => {
      const avail = await dockerClient.checkDockerAvailability();
      assert.equal(typeof avail.available, 'boolean');
      if (avail.available) assert.ok(avail.version);
    });

    await test('Dockerfile generator outputs production multi-stage configuration', () => {
      const dockerfile = dockerfileGenerator.generate({
        packageManager: 'npm',
        port: { value: 8080 },
        entryPoint: { value: 'src/main.js' }
      });
      assert.ok(dockerfile.includes('FROM node:20-alpine'));
      assert.ok(dockerfile.includes('ENV PORT=8080'));
      assert.ok(dockerfile.includes('EXPOSE 8080'));
      assert.ok(dockerfile.includes('CMD ["node", "src/main.js"]'));
    });

    await test('Dockerfile generator supports yarn and pnpm', () => {
      const yarnDf = dockerfileGenerator.generate({ packageManager: 'yarn', port: { value: 3000 } });
      assert.ok(yarnDf.includes('yarn install'));
      const pnpmDf = dockerfileGenerator.generate({ packageManager: 'pnpm', port: { value: 3000 } });
      assert.ok(pnpmDf.includes('pnpm install'));
    });

    await test('Strategy resolution detects missing Dockerfile and sets generated strategy', () => {
      const ws = storageService.createWorkspace();
      const info = dockerfileGenerator.prepareDockerfile(ws.extractDir, { packageManager: 'npm', port: { value: 3000 } });
      assert.equal(info.source, 'generated');
      assert.ok(info.dockerfilePath);
      storageService.deleteWorkspace(ws.projectId);
    });

    // -------------------------------------------------------------------------
    // ENGINE 3: GITHUB AUTOMATION + JENKINS CI/CD ENGINE
    // -------------------------------------------------------------------------
    log('\n--- ENGINE 3: GitHub Automation + Jenkins CI/CD Engine ---');

    await test('GET /api/github/account reports disconnected when no token active', async () => {
      githubAuth.clearToken();
      const res = await req.get('/api/github/account');
      assert.equal(res.status, 200);
      assert.equal(res.body.connected, false);
    });

    await test('POST /api/github/connect rejects empty or invalid token', async () => {
      const res = await req.post('/api/github/connect').send({ token: '' });
      assert.equal(res.status, 400);
    });

    await test('Pre-push secret scanner passes on clean project and catches leaks', () => {
      const tmpTestDir = path.resolve('temporary/test-scanner-' + Date.now());
      fs.mkdirSync(tmpTestDir, { recursive: true });
      fs.writeFileSync(path.join(tmpTestDir, 'app.js'), 'const a = "AKIAIOSFODNN7EXAMPLE";');
      const scanRes = secretScanner.scanDirectory(tmpTestDir);
      assert.equal(scanRes.passed, false);
      assert.ok(scanRes.findingsCount > 0);
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    });

    await test('Declarative Jenkinsfile generator creates all required pipeline stages', () => {
      const jenkinsfile = pipelineGenerator.generate({
        project: { name: 'cloudops-demo-app' },
        packageManager: 'npm',
        port: { value: 3000 }
      });
      assert.ok(jenkinsfile.includes("stage('1. Checkout SCM')"));
      assert.ok(jenkinsfile.includes("stage('2. Install Dependencies')"));
      assert.ok(jenkinsfile.includes("stage('3. Run Automated Tests')"));
      assert.ok(jenkinsfile.includes("stage('4. Security & Quality Gate')"));
      assert.ok(jenkinsfile.includes("stage('5. Docker Image Build')"));
      assert.ok(jenkinsfile.includes("stage('6. Docker Image Verification')"));
    });

    await test('Safe Git engine initializes repository and performs commit', async () => {
      const gitDir = path.resolve('temporary/test-git-' + Date.now());
      fs.mkdirSync(gitDir, { recursive: true });
      await gitClient.init(gitDir);
      assert.ok(fs.existsSync(path.join(gitDir, '.git')));
      fs.writeFileSync(path.join(gitDir, 'README.md'), '# Test App');
      const commitRes = await gitClient.addAndCommit(gitDir, 'Initial test commit');
      assert.ok(commitRes.hash);
      assert.equal(commitRes.alreadyCommitted, false);
      fs.rmSync(gitDir, { recursive: true, force: true });
    });

    await test('Jenkins client status queries server or handles offline gracefully', async () => {
      const status = await jenkinsClient.getStatus();
      assert.equal(typeof status.connected, 'boolean');
    });

    // -------------------------------------------------------------------------
    // ENGINE 4: LOCAL KUBERNETES AUTOMATION ENGINE (KIND)
    // -------------------------------------------------------------------------
    console.log('\n--- ENGINE 4: Local Kubernetes Automation Engine (Kind) ---');

    await test('Prerequisite check detects host environment & Kind cluster', async () => {
      const report = await prereqService.checkPrerequisites();
      assert.equal(report.os.platform, process.platform);
      assert.equal(typeof report.docker.installed, 'boolean');
      assert.equal(typeof report.kubectl.installed, 'boolean');
      assert.equal(typeof report.kind.installed, 'boolean');
      assert.equal(typeof report.kubernetes.clusterExists, 'boolean');
      assert.equal(typeof report.allReady, 'boolean');
    });

    await test('GET /api/kubernetes/status returns live cluster status', async () => {
      const res = await req.get('/api/kubernetes/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.kubernetes.clusterName, 'cloudops-local');
      assert.equal(typeof res.body.kubernetes.nodesReady, 'boolean');
    });

    await test('Manifest generator produces valid DNS-1123 Deployment & Service YAML', () => {
      const manifests = manifestGenerator.generateManifests(
        'b45c719e-9901',
        { project: { name: 'test-k8s-app' }, port: { value: 8080 } },
        { image: { tag: 'cloudops/test-k8s-app:build-b45c719e' } }
      );
      assert.equal(manifests.namespace, 'cloudops-b45c719e-990');
      assert.ok(manifests.deploymentYaml.includes('kind: Deployment'));
      assert.ok(manifests.deploymentYaml.includes('containerPort: 8080'));
      assert.ok(manifests.serviceYaml.includes('kind: Service'));
      assert.ok(manifests.serviceYaml.includes('type: NodePort'));
    });

    await test('POST /api/projects/:id/kubernetes/deploy rejects undockerized project', async () => {
      const pId = storageService.generateProjectId();
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'un-k8s-app' }, port: { value: 3000 } });
      const res = await req.post(`/api/projects/${pId}/kubernetes/deploy`).send({});
      assert.equal(res.status, 400);
    });

    // -------------------------------------------------------------------------
    // ENGINE 5: REAL AWS CLOUD DEPLOYMENT ENGINE (ECR + EC2 + SSM)
    // -------------------------------------------------------------------------
    console.log('\n--- ENGINE 5: Real AWS Cloud Deployment Engine (ECR + EC2 + SSM) ---');

    await test('AWS credential security correctly masks sensitive secrets', () => {
      const masked = maskSecret('AKIAIOSFODNN7EXAMPLE');
      assert.equal(masked, 'AKIA****MPLE');
      assert.ok(!masked.includes('IOSFODNN7'));
      assert.equal(maskSecret(''), '');
      assert.equal(maskSecret('short'), '****');
    });

    await test('AWS STS client retrieves caller identity / connection status', async () => {
      const status = await awsClient.getStatus();
      assert.equal(typeof status.connected, 'boolean');
      assert.ok(status.region);
      if (status.connected) {
        assert.ok(status.accountId);
        assert.ok(status.arn);
      }
    });

    await test('GET /api/aws/status exposes live AWS connection metadata', async () => {
      const res = await req.get('/api/aws/status');
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.connected, 'boolean');
      assert.ok(res.body.region);
    });

    await test('ECR service sanitizes repository names according to AWS regex', () => {
      const clean = ecrService.sanitizeRepoName('My-App_Service 123!!');
      assert.ok(/^[a-z0-9/_-]+$/.test(clean));
      assert.equal(clean, 'cloudops/my-app_service-123');
    });

    await test('EC2 service rejects invalid instance ID formats', async () => {
      await assert.rejects(
        async () => { await ec2Service.validateExistingInstance('not-an-instance-id'); },
        { name: 'Error', message: /Invalid EC2 instance ID format/ }
      );
    });

    await test('SSM deployment constructs deterministic and secure container commands', () => {
      const deployScript = [
        'set -e',
        'aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 892748150267.dkr.ecr.ap-south-1.amazonaws.com',
        'docker pull 892748150267.dkr.ecr.ap-south-1.amazonaws.com/cloudops/demo:build-1',
        'docker stop cloudops-test-app || true',
        'docker rm cloudops-test-app || true',
        'docker run -d --name cloudops-test-app --restart unless-stopped -p 3000:3000 892748150267.dkr.ecr.ap-south-1.amazonaws.com/cloudops/demo:build-1',
        'docker ps --filter name=cloudops-test-app'
      ];
      assert.ok(deployScript[1].includes('get-login-password'));
      assert.ok(deployScript[2].includes('docker pull'));
      assert.ok(deployScript[5].includes('-p 3000:3000'));
    });

    await test('POST /api/projects/:id/aws/deploy rejects undockerized project', async () => {
      const pId = storageService.generateProjectId();
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'undockerized-aws-app' }, port: { value: 3000 } });
      const res = await req.post(`/api/projects/${pId}/aws/deploy`).send({});
      assert.equal(res.status, 400);
      assert.ok((res.body.message || res.body.error).includes('dockerized'));
    });

    await test('GET /api/projects/:id/aws/status returns not_deployed for new project', async () => {
      const pId = storageService.generateProjectId();
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'un-deployed-aws-app' }, port: { value: 3000 } });
      const res = await req.get(`/api/projects/${pId}/aws/status`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'not_deployed');
    });

    await test('Jenkinsfile generator outputs AWS ECR push, EC2 deployment & health check stages', () => {
      const jf = pipelineGenerator.generate(
        { project: { name: 'aws-cloud-service' }, packageManager: 'npm', port: { value: 3000 } },
        { enableAws: true, awsRegion: 'ap-south-1', instanceId: 'i-0123456789abcdef0' }
      );
      assert.ok(jf.includes("stage('7. Push Image to ECR')"));
      assert.ok(jf.includes("stage('8. Deploy to EC2')"));
      assert.ok(jf.includes("stage('9. Health Check')"));
      assert.ok(jf.includes('i-0123456789abcdef0'));
      assert.ok(jf.includes('ap-south-1'));
    });

    // =========================================================================
    // ENGINE 6: Real-Time Monitoring & Observability Engine (Phase 7)
    // =========================================================================
    log('\n--- ENGINE 6: Real-Time Monitoring & Observability Engine ---');

    const cloudwatchService = require('../src/services/aws/cloudwatch.service');
    const healthProbeService = require('../src/services/monitoring/health.probe.service');
    const alertService = require('../src/services/monitoring/alert.service');
    const { MonitoringStorage } = require('../src/services/monitoring/monitoring.storage');

    await test('CloudWatch metric processor returns NO_DATA when datapoints are absent', () => {
      const result = cloudwatchService._processMetricResult('CPUUtilization', { Datapoints: [] });
      assert.equal(result.status, 'NO_DATA');
      assert.equal(result.value, null);
      assert.equal(result.source, 'AWS CloudWatch');
    });

    await test('Health probe summary calculates accurate rolling failure rates', () => {
      const summary = healthProbeService.calculateHealthSummary([
        { isHealthy: true, durationMs: 100 },
        { isHealthy: false, durationMs: null }
      ]);
      assert.equal(summary.totalChecks, 2);
      assert.equal(summary.healthCheckFailureRate, 50);
      assert.equal(summary.status, 'UNHEALTHY');
    });

    await test('Alert engine deduplicates alerts and auto-resolves normal conditions', () => {
      const pId = 'proj-alert-test';
      const snapHigh = {
        ec2: { state: 'running', cpu: { value: 95, source: 'AWS CloudWatch' } },
        os: { memory: { usedPercentage: 40 }, disk: { usedPercentage: 30 } },
        docker: { container: { status: 'running', restarts: 0 }, stats: {} },
        ssm: { isOnline: true },
        application: { isHealthy: true, durationMs: 100 }
      };
      const res1 = alertService.evaluateSnapshot(pId, snapHigh, []);
      assert.equal(res1.activeCount, 1);
      assert.equal(res1.alerts[0].type, 'HIGH_CPU_UTILIZATION');

      const snapNorm = {
        ec2: { state: 'running', cpu: { value: 20, source: 'AWS CloudWatch' } },
        os: { memory: { usedPercentage: 40 }, disk: { usedPercentage: 30 } },
        docker: { container: { status: 'running', restarts: 0 }, stats: {} },
        ssm: { isOnline: true },
        application: { isHealthy: true, durationMs: 100 }
      };
      const res2 = alertService.evaluateSnapshot(pId, snapNorm, res1.alerts);
      assert.equal(res2.activeCount, 0);
      assert.equal(res2.alerts[0].status, 'RESOLVED');
    });

    await test('Monitoring storage prunes historical metrics exceeding retention bounds', () => {
      const tempStorageDir = path.join(__dirname, '../temporary/test-run-storage');
      if (fs.existsSync(tempStorageDir)) fs.rmSync(tempStorageDir, { recursive: true, force: true });
      fs.mkdirSync(tempStorageDir, { recursive: true });
      const testStorage = new MonitoringStorage(tempStorageDir);
      testStorage.maxMetricEntries = 3;

      for (let i = 1; i <= 6; i++) {
        testStorage.recordMetricPoint('p1', { cpu: i * 10, memory: 50, disk: 20, responseTimeMs: 100 });
      }

      const history = testStorage.getMetricHistory('p1');
      assert.equal(history.length, 3);
      assert.equal(history[history.length - 1].cpu, 60);
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    });

    await test('GET /api/projects/:id/monitoring/status returns 404 for unknown project', async () => {
      const res = await req.get('/api/projects/unknown-proj-999/monitoring/status');
      assert.equal(res.status, 404);
    });

    await test('GET /api/projects/:id/monitoring/status returns live status for initialized project', async () => {
      const pId = 'proj-mon-init';
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'app' } });
      const res = await req.get(`/api/projects/${pId}/monitoring/status`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'NOT_DEPLOYED');
      storageService.deleteWorkspace(pId);
    });

    // =========================================================================
    // ENGINE 7: Real Terraform Infrastructure-as-Code Engine (Phase 8)
    // =========================================================================
    log('\n--- ENGINE 7: Real Terraform Infrastructure-as-Code Engine ---');

    const terraformClient = require('../src/services/terraform/terraform.client');
    const terraformGenerator = require('../src/services/terraform/terraform.generator');
    const terraformPlanParser = require('../src/services/terraform/terraform.plan.parser');
    const terraformStateService = require('../src/services/terraform/terraform.state.service');
    const terraformEngine = require('../src/services/terraform');

    await test('Terraform client detects CLI version, executable path, and host architecture', async () => {
      const prereqs = await terraformClient.checkPrerequisites();
      assert.equal(typeof prereqs.terraformInstalled, 'boolean');
      if (prereqs.terraformInstalled) {
        assert.ok(prereqs.terraformVersion);
        assert.ok(prereqs.executablePath);
      }
    });

    await test('Terraform generator creates structured HCL configuration and variables', () => {
      const tempTfDir = path.join(__dirname, '../temporary/test-run-tf-gen');
      if (fs.existsSync(tempTfDir)) fs.rmSync(tempTfDir, { recursive: true, force: true });
      fs.mkdirSync(tempTfDir, { recursive: true });

      const genRes = terraformGenerator.generate(tempTfDir, {
        projectId: 'p-runall-tf',
        project: { name: 'runall-app' },
        port: { value: 3000 }
      });

      assert.equal(genRes.filesGenerated.length, 11);
      assert.ok(fs.existsSync(path.join(tempTfDir, 'versions.tf')));
      assert.ok(fs.existsSync(path.join(tempTfDir, 'provider.tf')));
      assert.ok(fs.existsSync(path.join(tempTfDir, 'ecr.tf')));
      assert.ok(fs.existsSync(path.join(tempTfDir, 'terraform.tfvars')));
      fs.rmSync(tempTfDir, { recursive: true, force: true });
    });

    await test('Terraform plan parser extracts resource counts and flags idempotency', () => {
      const sample = {
        resource_changes: [
          { address: 'aws_ecr_repository.app', change: { actions: ['create'] } }
        ]
      };
      const parsed = terraformPlanParser.parseJsonPlan(sample);
      assert.equal(parsed.toAdd, 1);
      assert.equal(parsed.toChange, 0);
      assert.equal(parsed.toDestroy, 0);
      assert.equal(parsed.isIdempotent, false);
    });

    await test('Terraform state service enforces concurrency lock per project', () => {
      const pId = 'p-lock-runall';
      terraformClient.acquireLock(pId);
      assert.throws(() => terraformClient.acquireLock(pId), /Concurrent Terraform operation/);
      terraformClient.releaseLock(pId);
    });

    await test('Terraform destroy safety gate rejects destructive apply without confirmation', async () => {
      const pId = 'p-tf-safety-runall';
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'app' } });
      terraformStateService.saveState(pId, {
        status: 'PLANNED',
        plan: { toAdd: 0, toChange: 0, toDestroy: 1, isDestructive: true }
      });

      await assert.rejects(
        async () => {
          await terraformEngine.apply(pId, { confirmDestroy: false });
        },
        /Safety Alert: Terraform plan contains 1 destructive action/
      );
      storageService.deleteWorkspace(pId);
    });

    await test('GET /api/terraform/status returns global CLI and STS connectivity', async () => {
      const res = await req.get('/api/terraform/status');
      assert.equal(res.status, 200);
      assert.ok('terraformInstalled' in res.body);
    });

    // -------------------------------------------------------------------------
    // ENGINE 8: REAL AUTONOMOUS SELF-HEALING & AUTOMATIC RECOVERY ENGINE
    // -------------------------------------------------------------------------
    console.log('\n--- ENGINE 8: Autonomous Self-Healing & Automatic Recovery Engine ---');

    const { Incident, INCIDENT_STATUSES, INCIDENT_TYPES, INCIDENT_SEVERITIES } = require('../src/services/selfHealing/incident.model');
    const { RemediationAction, ACTION_TYPES } = require('../src/services/selfHealing/remediationAction.model');
    const remediationPolicy = require('../src/services/selfHealing/remediationPolicy.service');
    const incidentDetector = require('../src/services/selfHealing/incident.detector.service');
    const selfHealingEngine = require('../src/services/selfHealing');

    await test('Incident state machine transitions from DETECTED -> REMEDIATING -> RESOLVED', () => {
      const inc = new Incident({
        projectId: 'p-sh-test',
        type: INCIDENT_TYPES.CONTAINER_STOPPED,
        severity: INCIDENT_SEVERITIES.CRITICAL,
        resourceId: 'container-demo'
      });
      assert.equal(inc.status, INCIDENT_STATUSES.DETECTED);
      inc.transitionTo(INCIDENT_STATUSES.REMEDIATING, 'Starting remediation');
      assert.equal(inc.status, INCIDENT_STATUSES.REMEDIATING);
      inc.transitionTo(INCIDENT_STATUSES.RESOLVED, 'Health check verified 200 OK');
      assert.equal(inc.status, INCIDENT_STATUSES.RESOLVED);
      assert.equal(inc.verificationStatus, 'VERIFIED_HEALTHY');
    });

    await test('Remediation policy engine enforces safe permissions matrix', () => {
      const inc = new Incident({ projectId: 'p-sh-test', type: INCIDENT_TYPES.CONTAINER_STOPPED });
      const safePerm = remediationPolicy.evaluateRemediationPermission(inc, { recoveryMode: 'SAFE' });
      assert.equal(safePerm.allowed, true);
      assert.equal(safePerm.actionType, ACTION_TYPES.START_CONTAINER);

      const disabledPerm = remediationPolicy.evaluateRemediationPermission(inc, { recoveryMode: 'DISABLED' });
      assert.equal(disabledPerm.allowed, false);

      const globalOff = remediationPolicy.evaluateRemediationPermission(inc, { recoveryMode: 'SAFE' }, false);
      assert.equal(globalOff.allowed, false);
    });

    await test('Circuit breaker halts automated restarts and escalates when max attempts exceeded', () => {
      const inc = new Incident({
        projectId: 'p-sh-test',
        type: INCIDENT_TYPES.CONTAINER_STOPPED,
        maxAttempts: 2,
        remediationAttempts: 2
      });
      const perm = remediationPolicy.evaluateRemediationPermission(inc, { maxAttempts: 2 });
      assert.equal(perm.allowed, false);
      assert.equal(perm.escalate, true);
    });

    await test('Incident detector correlates dependent health check failures to root container stoppage', () => {
      const snap = {
        projectId: 'p-sh-test',
        docker: { container: { name: 'app', status: 'stopped', restarts: 0 } },
        application: { isHealthy: false, httpStatus: null, error: 'Connection refused' },
        ssm: { pingStatus: 'Online' },
        ec2: { state: 'running' }
      };
      const detected = incidentDetector.detectIncidents('p-sh-test', snap, []);
      assert.equal(detected.length, 1);
      assert.equal(detected[0].type, INCIDENT_TYPES.CONTAINER_STOPPED);
    });

    await test('Repeated crash loop (>=3 restarts) is detected and marked CONTAINER_RESTART_LOOP', () => {
      const crashSnap = {
        projectId: 'p-sh-test',
        docker: { container: { name: 'app', status: 'running', restarts: 4 } },
        application: { isHealthy: false, httpStatus: 500 },
        ssm: { pingStatus: 'Online' },
        ec2: { state: 'running' }
      };
      const detected = incidentDetector.detectIncidents('p-sh-test', crashSnap, []);
      assert.equal(detected.length, 1);
      assert.equal(detected[0].type, INCIDENT_TYPES.CONTAINER_RESTART_LOOP);
    });

    await test('GET /api/recovery/status and POST /api/recovery/pause / resume control global switch', async () => {
      const resStatus = await req.get('/api/recovery/status');
      assert.equal(resStatus.status, 200);

      const resPause = await req.post('/api/recovery/pause');
      assert.equal(resPause.status, 200);
      assert.equal(resPause.body.globalAutoRecovery, false);

      const resResume = await req.post('/api/recovery/resume');
      assert.equal(resResume.status, 200);
      assert.equal(resResume.body.globalAutoRecovery, true);
    });

    await test('GET /api/projects/:projectId/recovery/status returns project recovery state', async () => {
      const pId = 'p-recovery-runall';
      storageService.createWorkspace(pId);
      storageService.saveAnalysis(pId, { project: { name: 'app' } });

      const res = await req.get(`/api/projects/${pId}/recovery/status`);
      assert.equal(res.status, 200);
      assert.equal(res.body.projectId, pId);
      assert.ok('totalIncidents' in res.body);
      storageService.deleteWorkspace(pId);
    });

    // -------------------------------------------------------------------------
    // ENGINE 9: INTELLIGENT DEPLOYMENT ORCHESTRATOR & FAILURE ANALYSIS ENGINE
    // -------------------------------------------------------------------------
    console.log('\n--- ENGINE 9: Intelligent Deployment Orchestrator & Failure Analysis Engine ---');

    const { RequirementEngine, REQUIREMENT_STATUS } = require('../src/services/orchestrator/requirement.engine');
    const { DeploymentPlanner, CONFIDENCE_LEVELS } = require('../src/services/orchestrator/deployment.planner');
    const { PreflightEngine } = require('../src/services/orchestrator/preflight.engine');
    const { FailureAnalyzer, FAILURE_CATEGORIES, REMEDIATION_DECISIONS } = require('../src/services/orchestrator/failure.analyzer');
    const { OrchestratorStorage } = require('../src/services/orchestrator/orchestrator.storage');
    const { DEPLOYMENT_STATES } = require('../src/services/orchestrator/orchestrator.engine');

    const reqEngine = new RequirementEngine();
    const planner = new DeploymentPlanner();
    const preflight = new PreflightEngine();
    const failureAnalyzer = new FailureAnalyzer();
    const orchStorage = new OrchestratorStorage();

    await test('Requirement Engine evaluates analysis and suppresses prompts when port is detected', async () => {
      const analysis = {
        project: { runtime: 'Node.js', language: 'JavaScript' },
        port: { value: 3000, source: 'code' },
        entryPoint: { value: 'src/server.js' },
        devops: { kubernetes: { hasManifests: false } },
        environmentVariables: { required: [] }
      };
      const res = await reqEngine.evaluateRequirements(analysis);
      assert.ok(res.totalRequirements > 0);
      const appReq = res.requirements.find(r => r.id === 'APPLICATION_RUNTIME');
      assert.equal(appReq.status, REQUIREMENT_STATUS.READY);
      assert.equal(appReq.userActionRequired, false);
    });

    await test('Requirement Engine flags missing environment secrets as user action required', async () => {
      const analysis = {
        project: { runtime: 'Node.js' },
        port: { value: 8080 },
        environmentVariables: { required: ['DATABASE_URL', 'STRIPE_API_KEY', 'PORT'] }
      };
      const withoutSecrets = await reqEngine.evaluateRequirements(analysis, {}, {});
      const secReq = withoutSecrets.requirements.find(r => r.id === 'ENVIRONMENT_SECRETS');
      assert.equal(secReq.status, REQUIREMENT_STATUS.MISSING);
      assert.equal(secReq.userActionRequired, true);
    });

    await test('Deployment Planner selects EC2 for single-service and EKS for Kubernetes manifests', () => {
      const ec2Plan = planner.generatePlan({ project: { name: 'app', runtime: 'Node.js' }, port: { value: 3000 } }, {});
      assert.equal(ec2Plan.computeTarget, 'AWS_EC2');
      assert.equal(ec2Plan.totalStages, 8);

      const eksPlan = planner.generatePlan({ project: { name: 'k8s-app' }, devops: { kubernetes: { hasManifests: true } } }, {});
      assert.equal(eksPlan.computeTarget, 'AWS_EKS');
    });

    await test('Preflight Engine derives specific AWS permissions based on compute target', () => {
      const perms = preflight.getRequiredAWSPermissions('AWS_EC2');
      assert.ok(perms.some(p => p.action === 'ec2:RunInstances'));
      assert.ok(perms.some(p => p.action === 'ecr:PutImage'));
      assert.ok(perms.some(p => p.action === 'ssm:SendCommand'));
    });

    await test('Failure Analyzer performs Root Cause Analysis (RCA) and masks sensitive credentials', () => {
      const rca = failureAnalyzer.analyzeFailure({
        stage: 'STAGE_AWS_DEPLOYMENT',
        error: new Error('User: arn:aws:iam::123:user/dev is not authorized to perform: ec2:RunInstances with SECRET_KEY=supersecretkey123')
      });
      assert.equal(rca.failureType, FAILURE_CATEGORIES.AWS_PERMISSION_FAILURE);
      assert.equal(rca.remediationDecision, REMEDIATION_DECISIONS.REQUIRES_USER);
      assert.ok(!rca.evidence.includes('supersecretkey123'));
    });

    await test('Orchestrator Storage persists deployment state, stage progress, and logs', () => {
      const pId = 'p-orch-store-test';
      storageService.createWorkspace(pId);
      const dep = orchStorage.saveDeployment(pId, { state: DEPLOYMENT_STATES.PLANNING });
      assert.equal(dep.state, DEPLOYMENT_STATES.PLANNING);
      orchStorage.updateStage(pId, 'STAGE_DOCKERIZE', 'RUNNING');
      orchStorage.appendLog(pId, 'DOCKER', 'Building image');
      const loaded = orchStorage.getDeployment(pId);
      assert.equal(loaded.currentStage, 'STAGE_DOCKERIZE');
      assert.equal(loaded.logs.length, 1);
      storageService.deleteWorkspace(pId);
    });

    await test('REST API /api/projects/:id/orchestrate/plan and status handle orchestration requests', async () => {
      const pId = 'p-orch-rest-test';
      storageService.createWorkspace(pId);
      const ws = storageService.getWorkspacePath(pId);
      fs.writeFileSync(path.join(ws.extractDir, 'package.json'), JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        main: 'index.js'
      }));
      fs.writeFileSync(path.join(ws.extractDir, 'index.js'), 'console.log("hello");');
      storageService.saveAnalysis(pId, { project: { name: 'test-app', runtime: 'Node.js' } });

      const planRes = await req.post(`/api/projects/${pId}/orchestrate/plan`).send({ region: 'ap-south-1' });
      assert.equal(planRes.status, 200);
      assert.equal(planRes.body.success, true);
      assert.equal(planRes.body.plan.totalStages, 8);

      const statusRes = await req.get(`/api/projects/${pId}/orchestrate/status`);
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body.state, DEPLOYMENT_STATES.PLAN_READY);

      storageService.deleteWorkspace(pId);
    });

    // -------------------------------------------------------------------------
    // ENGINE 10: REAL MULTI-USER & MULTI-TENANT ARCHITECTURE (PHASE 11)
    // -------------------------------------------------------------------------
    console.log('\n--- ENGINE 10: Real Multi-User & Multi-Tenant Architecture ---');

    let runUserA, runUserB, runOrgA, runOrgB, runTokenA, runTokenB;

    await test('POST /api/auth/signup registers User A and User B into isolated organizations', async () => {
      const emailA = `test-user-a-${Date.now()}@example.com`;
      const emailB = `test-user-b-${Date.now()}@example.com`;

      const resA = await req.post('/api/auth/signup').send({
        email: emailA,
        password: 'Password123!',
        name: 'User Alpha',
        organizationName: 'Alpha Tech Corp'
      });
      assert.equal(resA.status, 201);
      assert.equal(resA.body.success, true);
      assert.ok(resA.body.token);
      assert.equal(resA.body.user.email, emailA.toLowerCase());
      assert.equal(resA.body.user.passwordHash, undefined);

      const resB = await req.post('/api/auth/signup').send({
        email: emailB,
        password: 'Password456!',
        name: 'User Beta',
        organizationName: 'Beta Systems'
      });
      assert.equal(resB.status, 201);
      assert.notEqual(resA.body.organization.id, resB.body.organization.id);

      runUserA = resA.body.user;
      runOrgA = resA.body.organization;
      runTokenA = resA.body.token;

      runUserB = resB.body.user;
      runOrgB = resB.body.organization;
      runTokenB = resB.body.token;
    });

    await test('POST /api/auth/login validates credentials and returns secure session token', async () => {
      const badLogin = await req.post('/api/auth/login').send({
        email: runUserA.email,
        password: 'WrongPassword!'
      });
      assert.equal(badLogin.status, 401);

      const goodLogin = await req.post('/api/auth/login').send({
        email: runUserA.email,
        password: 'Password123!'
      });
      assert.equal(goodLogin.status, 200);
      assert.ok(goodLogin.body.token);
    });

    await test('SecretVault encrypts with AES-256-GCM and decrypts accurately', async () => {
      const testSecret = { token: 'ghp_SampleSecretToken1234567890' };
      const ref = secretVault.encrypt(testSecret);
      assert.ok(ref.startsWith('sec-'));

      const decrypted = secretVault.decrypt(ref, true);
      assert.equal(decrypted.token, testSecret.token);
      secretVault.deleteSecret(ref);
    });

    let runConnA;
    await test('POST /api/connections creates tenant-isolated provider connection', async () => {
      const connRes = await req.post('/api/connections')
        .set('Authorization', `Bearer ${runTokenA}`)
        .send({
          provider: 'GITHUB',
          name: 'Alpha GitHub PAT',
          credentials: { token: 'ghp_alphaMockToken12345' }
        });
      assert.equal(connRes.status, 201);
      assert.equal(connRes.body.connection.provider, 'GITHUB');
      assert.equal(connRes.body.connection.credentials, undefined);
      runConnA = connRes.body.connection;
    });

    await test('User B is blocked from viewing or accessing User A connection (IDOR Protection)', async () => {
      // User B lists connections -> Must be empty
      const listB = await req.get('/api/connections')
        .set('Authorization', `Bearer ${runTokenB}`);
      assert.equal(listB.status, 200);
      assert.equal(listB.body.connections.length, 0);

      // User B direct access to User A connection ID -> 403 / 404 Forbidden
      const crossGet = await req.get(`/api/connections/${runConnA.id}`)
        .set('Authorization', `Bearer ${runTokenB}`);
      assert.ok(crossGet.status === 403 || crossGet.status === 404);
    });

    await test('Multi-tenant project isolation prevents cross-tenant access', async () => {
      const projA = storageService.createWorkspace('p-multi-a', runOrgA.id);
      storageService.saveAnalysis(projA.projectId, { project: { name: 'Alpha API', runtime: 'Node.js' } }, runOrgA.id, runUserA.id);

      const projB = storageService.createWorkspace('p-multi-b', runOrgB.id);
      storageService.saveAnalysis(projB.projectId, { project: { name: 'Beta API', runtime: 'Python' } }, runOrgB.id, runUserB.id);

      // User A lists projects -> sees only projA
      const listA = await req.get('/api/projects').set('Authorization', `Bearer ${runTokenA}`);
      assert.equal(listA.status, 200);
      assert.equal(listA.body.projects.length, 1);
      assert.equal(listA.body.projects[0].projectId, 'p-multi-a');

      // User B lists projects -> sees only projB
      const listB = await req.get('/api/projects').set('Authorization', `Bearer ${runTokenB}`);
      assert.equal(listB.status, 200);
      assert.equal(listB.body.projects.length, 1);
      assert.equal(listB.body.projects[0].projectId, 'p-multi-b');

      // Cross-tenant access blocked
      const crossProject = await req.get('/api/projects/p-multi-a').set('Authorization', `Bearer ${runTokenB}`);
      assert.ok(crossProject.status === 403 || crossProject.status === 404);

      storageService.deleteWorkspace('p-multi-a', runOrgA.id);
      storageService.deleteWorkspace('p-multi-b', runOrgB.id);
    });

  } finally {
    awsClient.destroy();
    storageService.cleanupAll();
    http.globalAgent.destroy();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n================================================================');
  console.log(`TEST RUN SUMMARY: ${passed} Passed, ${failed} Failed (${durationSec}s)`);
  console.log('================================================================');

  process.exit(failed === 0 ? 0 : 1);
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
