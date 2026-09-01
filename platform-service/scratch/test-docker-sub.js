const fs = require('fs');

function test(name, fn) {
  fs.appendFileSync('./temporary/docker-sub.txt', `Testing ${name}...\n`);
  fn();
  fs.appendFileSync('./temporary/docker-sub.txt', `✔ Loaded ${name}\n`);
}

fs.writeFileSync('./temporary/docker-sub.txt', 'START\n');
test('docker.client', () => require('../src/services/docker/docker.client'));
test('dockerfile.generator', () => require('../src/services/docker/dockerfile.generator'));
test('health.checker', () => require('../src/services/docker/health.checker'));
test('docker/index', () => require('../src/services/docker'));
test('docker.controller', () => require('../src/controllers/docker.controller'));
test('docker.routes', () => require('../src/routes/docker.routes'));
fs.appendFileSync('./temporary/docker-sub.txt', 'ALL DONE\n');
process.exit(0);
