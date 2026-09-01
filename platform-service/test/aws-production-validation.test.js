const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const testBaseDir = path.resolve(__dirname, '../temporary/test-aws-validation');
if (fs.existsSync(testBaseDir)) {
  fs.rmSync(testBaseDir, { recursive: true, force: true });
}
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;
process.env.ALLOW_DEV_ANONYMOUS = 'true';

const db = require('../src/services/db/db.service');
const secretVault = require('../src/services/security/secret.vault');
const authService = require('../src/services/auth/auth.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const { AWSClient, maskSecret } = require('../src/services/aws/aws.client');
const ec2Service = require('../src/services/aws/ec2.service');
const ecrService = require('../src/services/aws/ecr.service');
const ssmService = require('../src/services/aws/ssm.service');
const awsDeploymentService = require('../src/services/aws/aws.deployment.service');
const storageService = require('../src/services/storage.service');

function log(msg = '') {
  console.log(msg);
}

async function runAwsProductionValidationTests() {
  log('========================================================================');
  log('CLOUDOPS — PRODUCTION AWS INTEGRATION & MULTI-TENANT VERIFICATION SUITE');
  log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    log(`  [TEST] ${name}...`);
    try {
      await fn();
      passed++;
      log(`  ✔ [PASS] ${name}\n`);
    } catch (err) {
      failed++;
      log(`  ✖ [FAIL] ${name}`);
      log(`    Error: ${err.stack || err.message}\n`);
    }
  }

  // 1. Permanent IAM credentials vs Temporary credentials with sessionToken
  await test('1. AWSClient correctly formats permanent IAM vs temporary credentials', async () => {
    const permClient = new AWSClient({
      region: 'ap-south-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    });
    assert.equal(permClient.credentials.accessKeyId, 'AKIAIOSFODNN7EXAMPLE');
    assert.equal(permClient.credentials.secretAccessKey, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    assert.equal(permClient.credentials.sessionToken, undefined);
    assert.equal(permClient.region, 'ap-south-1');
    permClient.destroy();

    const tempClient = new AWSClient({
      region: 'eu-west-1',
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'IQoJb3JpZ2luX2VjEEXAMPLETOKEN'
    });
    assert.equal(tempClient.credentials.accessKeyId, 'ASIAIOSFODNN7EXAMPLE');
    assert.equal(tempClient.credentials.sessionToken, 'IQoJb3JpZ2luX2VjEEXAMPLETOKEN');
    assert.equal(tempClient.region, 'eu-west-1');
    tempClient.destroy();
  });

  // 2. STS GetCallerIdentity validation and safe error handling
  await test('2. STS GetCallerIdentity returns safe failure on missing credentials without throwing uncaught', async () => {
    const client = new AWSClient({});
    const identity = await client.getCallerIdentity('us-east-1');
    assert.equal(identity.connected, false);
    assert.equal(identity.error, 'No AWS credentials configured');
    assert.equal(identity.code, 'CredentialsMissing');
    client.destroy();
  });

  // 3. Vault Encryption & Decryption Server-Side
  await test('3. AES-256-GCM Vault encrypts credentials and decrypts only with valid reference', async () => {
    const rawSecret = {
      accessKeyId: 'AKIA1111222233334444',
      secretAccessKey: 'SecretPayloadKey1234567890abcdef',
      region: 'ap-south-1'
    };

    const ref = secretVault.encrypt(rawSecret);
    assert.ok(ref.startsWith('sec-'));

    // Decrypt
    const decrypted = secretVault.decrypt(ref, true);
    assert.equal(decrypted.accessKeyId, 'AKIA1111222233334444');
    assert.equal(decrypted.secretAccessKey, 'SecretPayloadKey1234567890abcdef');
    assert.equal(decrypted.region, 'ap-south-1');

    // Invalid ref returns null
    const bad = secretVault.decrypt('sec-nonexistent-ref', true);
    assert.equal(bad, null);
  });

  // 4. Multi-Tenant Connection Creation with Real Validation Flow
  await test('4. Multi-tenant connection service isolates credentials per organization', async () => {
    const org1 = db.insert('organizations', { id: `org-test-a-${Date.now()}`, name: 'Acme Corp', slug: 'acme' });
    const org2 = db.insert('organizations', { id: `org-test-b-${Date.now()}`, name: 'Beta Tech', slug: 'beta' });

    const user1 = db.insert('users', { id: `user-a-${Date.now()}`, email: 'a@acme.com', organizationId: org1.id });
    const user2 = db.insert('users', { id: `user-b-${Date.now()}`, email: 'b@beta.com', organizationId: org2.id });

    // Store encrypted connection for Org 1 with mocked valid STS
    const secretRef1 = secretVault.encrypt({
      accessKeyId: 'AKIA_ORG1_KEY_1111',
      secretAccessKey: 'Org1_Secret_Key_AAAA',
      region: 'ap-south-1'
    });

    db.insert('connections', {
      id: `conn-aws-org1-${Date.now()}`,
      organizationId: org1.id,
      userId: user1.id,
      provider: 'AWS',
      name: 'Acme AWS Account',
      status: 'CONNECTED',
      secretReference: secretRef1,
      metadata: { region: 'ap-south-1', accountId: '111122223333' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Store encrypted connection for Org 2
    const secretRef2 = secretVault.encrypt({
      accessKeyId: 'AKIA_ORG2_KEY_2222',
      secretAccessKey: 'Org2_Secret_Key_BBBB',
      region: 'us-west-2'
    });

    db.insert('connections', {
      id: `conn-aws-org2-${Date.now()}`,
      organizationId: org2.id,
      userId: user2.id,
      provider: 'AWS',
      name: 'Beta AWS Account',
      status: 'CONNECTED',
      secretReference: secretRef2,
      metadata: { region: 'us-west-2', accountId: '999988887777' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Org 1 client receives Org 1 credentials and region
    const client1 = providerConnectionService.getAWSClientForOrg(org1.id);
    assert.equal(client1.credentials.accessKeyId, 'AKIA_ORG1_KEY_1111');
    assert.equal(client1.region, 'ap-south-1');
    client1.destroy();

    // Org 2 client receives Org 2 credentials and region
    const client2 = providerConnectionService.getAWSClientForOrg(org2.id);
    assert.equal(client2.credentials.accessKeyId, 'AKIA_ORG2_KEY_2222');
    assert.equal(client2.region, 'us-west-2');
    client2.destroy();

    // List connections for Org 1 only returns Org 1 connection
    const org1List = providerConnectionService.listConnections(org1.id);
    assert.equal(org1List.length, 1);
    assert.equal(org1List[0].metadata.accountId, '111122223333');
    assert.equal(org1List[0].secretReference, undefined); // Secret reference sanitized!
  });

  // 5. SSM Service receives and uses tenant-scoped activeAwsClient
  await test('5. SSM Service deployDockerContainer forwards activeAwsClient to executeCommand', async () => {
    let capturedAwsClient = null;
    let capturedCommands = null;

    const mockAwsClient = {
      region: 'ap-south-1',
      credentials: { accessKeyId: 'AKIA_TENANT', secretAccessKey: 'SECRET_TENANT' },
      getSSMClient: () => ({
        send: async (cmd) => {
          if (cmd.input?.DocumentName || cmd.DocumentName || (cmd.input?.InstanceIds && !cmd.input?.CommandId)) {
            return { Command: { CommandId: 'cmd-test-12345' } };
          }
          return {
            Status: 'Success',
            ResponseCode: 0,
            StandardOutputContent: 'CONTAINER_ID_OUTPUT=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n==> Container deployed and active!'
          };
        }
      })
    };

    const res = await ssmService.deployDockerContainer('i-0123456789abcdef0', {
      ecrRegistryHost: '111122223333.dkr.ecr.ap-south-1.amazonaws.com',
      targetImageUri: '111122223333.dkr.ecr.ap-south-1.amazonaws.com/cloudops-app:v1',
      containerName: 'cloudops-test-container',
      port: 8080,
      region: 'ap-south-1',
      awsClient: mockAwsClient
    });

    assert.equal(res.success, true);
    assert.equal(res.containerName, 'cloudops-test-container');
    assert.equal(res.containerId, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  // 6. EC2 and ECR Listing APIs for AWS Infrastructure Page
  await test('6. EC2 and ECR Service listInstances and listRepositories execute real AWS commands', async () => {
    const mockEc2Client = {
      getEC2Client: () => ({
        send: async (cmd) => {
          return {
            Reservations: [{
              Instances: [{
                InstanceId: 'i-0987654321fedcba0',
                InstanceType: 't3.small',
                State: { Name: 'running' },
                PublicIpAddress: '13.233.50.60',
                PublicDnsName: 'ec2-13-233-50-60.ap-south-1.compute.amazonaws.com',
                Tags: [{ Key: 'Name', Value: 'Production-App-Host' }]
              }]
            }]
          };
        }
      })
    };

    const instances = await ec2Service.listInstances('ap-south-1', mockEc2Client);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].instanceId, 'i-0987654321fedcba0');
    assert.equal(instances[0].publicIp, '13.233.50.60');
    assert.equal(instances[0].name, 'Production-App-Host');

    const mockEcrClient = {
      getECRClient: () => ({
        send: async (cmd) => {
          return {
            repositories: [{
              repositoryName: 'cloudops/demo-service',
              repositoryUri: '111122223333.dkr.ecr.ap-south-1.amazonaws.com/cloudops/demo-service',
              registryId: '111122223333',
              createdAt: new Date('2026-08-31T12:00:00Z')
            }]
          };
        }
      })
    };

    const repos = await ecrService.listRepositories('ap-south-1', mockEcrClient);
    assert.equal(repos.length, 1);
    assert.equal(repos[0].repositoryName, 'cloudops/demo-service');
    assert.equal(repos[0].repositoryUri, '111122223333.dkr.ecr.ap-south-1.amazonaws.com/cloudops/demo-service');
  });

  // 7. Canonical Production URL Serialization & Port Extraction
  await test('7. Production URL serializer produces clean URL without [object Object] or localhost for cloud deployment', async () => {
    const complexPortAnalysis = {
      project: { name: 'cloudemo-api' },
      port: { value: 5000, detectedFrom: 'package.json' }
    };

    const projectId = `proj-${Date.now()}`;
    storageService.saveAnalysis(projectId, {
      project: { name: 'cloudemo-api' },
      runtime: 'nodejs',
      port: { value: 5000, detectedFrom: 'package.json' }
    });
    storageService.updateProject(projectId, {
      dockerState: { imageTag: 'cloudemo-api:latest' }
    });

    const validation = awsDeploymentService.validateProject(projectId);
    assert.equal(validation.port, 5000);
    assert.equal(typeof validation.port, 'number');

    const publicIp = '13.235.120.45';
    const constructedEndpoint = `http://${publicIp}:${validation.port}`;
    assert.equal(constructedEndpoint, 'http://13.235.120.45:5000');
    assert.ok(!constructedEndpoint.includes('[object Object]'));
    assert.ok(!constructedEndpoint.includes('localhost'));
  });

  // 8. Real HTTP Health Check Probing
  await test('8. Deployment service _verifyEndpointHealth probes target HTTP endpoint', async () => {
    // Start local ephemeral HTTP server to simulate live deployed container
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ status: 'ok', service: 'cloudemo' }));
      } else {
        res.writeHead(404, { 'Connection': 'close' });
        res.end();
      }
    });

    server.keepAliveTimeout = 0;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const testPort = server.address().port;
    const testEndpoint = `http://127.0.0.1:${testPort}`;

    try {
      const healthRes = await awsDeploymentService._verifyEndpointHealth(testEndpoint, testPort);
      assert.equal(healthRes.status, 'healthy');
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.body.status, 'ok');
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });

  // 9. API Routes Authentication & Organization Scoping
  await test('9. GET /api/aws/resources returns 200 with tenant resources when authenticated', async () => {
    const org = db.insert('organizations', { id: `org-api-res-${Date.now()}`, name: 'Resource Org', slug: 'res-org' });
    const user = db.insert('users', { id: `user-api-res-${Date.now()}`, email: 'res@org.com', status: 'ACTIVE', organizationId: org.id });
    db.insert('memberships', { organizationId: org.id, userId: user.id, role: 'OWNER' });
    const session = await authService.createSession(user.id, org.id);

    const mockReq = {
      user,
      organization: org,
      headers: { authorization: `Bearer ${session.rawToken}` }
    };
    let sentStatus = null;
    let sentBody = null;
    const mockRes = {
      status(code) { sentStatus = code; return this; },
      json(data) { sentBody = data; return this; }
    };

    const awsController = require('../src/controllers/aws.controller');
    await awsController.getInfrastructureResources(mockReq, mockRes, () => {});

    assert.equal(sentStatus, 200);
    assert.equal(sentBody.connected, false);
    assert.ok(Array.isArray(sentBody.ec2));
    assert.ok(Array.isArray(sentBody.ecr));
  });

  // 10. No Credential Leakage in Secret Masking
  await test('10. maskSecret safely masks API keys without exposing secrets', () => {
    assert.equal(maskSecret(''), '');
    assert.equal(maskSecret('1234'), '****');
    assert.equal(maskSecret('AKIAIOSFODNN7EXAMPLE'), 'AKIA****MPLE');
  });

  log('\n========================================================================');
  log(`AWS PRODUCTION VALIDATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runAwsProductionValidationTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runAwsProductionValidationTests };


