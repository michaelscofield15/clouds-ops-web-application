const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testBaseDir = path.resolve(__dirname, '../temporary/test-agent-dist-steps');
if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
fs.mkdirSync(testBaseDir, { recursive: true });

process.env.DB_BASE_DIR = testBaseDir;

const app = require('../src/app');

async function main() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;
  console.log('Server started on', serverUrl);

  console.log('Test 1: /api/agent/dist/version');
  const res1 = await fetch(`${serverUrl}/api/agent/dist/version`);
  const meta = await res1.json();
  console.log('Version:', meta.version);

  console.log('Test 2: /api/agent/dist/cloudops-agent');
  const res2 = await fetch(`${serverUrl}/api/agent/dist/cloudops-agent`);
  const text = await res2.text();
  console.log('Downloaded length:', text.length);

  console.log('Test 3: /install.sh');
  const res3 = await fetch(`${serverUrl}/install.sh`);
  const sh = await res3.text();
  console.log('install.sh length:', sh.length);

  server.close();
  fs.rmSync(testBaseDir, { recursive: true, force: true });
  console.log('All basic HTTP steps passed!');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
