const assert = require('assert');
const path = require('path');
const fs = require('fs');

const testBaseDir = path.resolve(__dirname, '../temporary/test-debug');
if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const authService = require('../src/services/auth/auth.service');
const providerConnectionService = require('../src/services/connections/provider.connection.service');
const dbService = require('../src/services/db/db.service');

async function main() {
  console.log('1. Signing up...');
  const signupA = await authService.signup({
    email: 'owner@tenant-alpha.io',
    password: 'Password123!',
    name: 'Alpha Admin',
    organizationName: 'Alpha Cloud Corp'
  });
  console.log('Tenant A:', signupA.organization.id);

  console.log('2. Creating connection...');
  const conn = await providerConnectionService.createConnection({
    organizationId: signupA.organization.id,
    userId: 'usr-alpha',
    provider: 'AWS',
    name: 'Alpha AWS Production',
    credentials: {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'ap-south-1'
    },
    metadata: {
      region: 'ap-south-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE'
    }
  });
  console.log('Connection created:', conn.id);

  console.log('3. Testing connection...');
  try {
    await providerConnectionService.testConnection(conn.id, signupA.organization.id);
    console.log('Test succeeded (unexpected)');
  } catch (err) {
    console.log('Test threw expected error:', err.message);
  }

  console.log('Done!');
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
