const fs = require('fs');
function step(msg) { fs.appendFileSync('./temporary/find-exit.txt', `${msg}\n`); }
fs.writeFileSync('./temporary/find-exit.txt', 'FIND EXIT START\n');

step('require docker.client');
require('../src/services/docker/docker.client');

step('require dockerfile.generator');
require('../src/services/docker/dockerfile.generator');

step('require health.checker');
require('../src/services/docker/health.checker');

step('require storage.service');
require('../src/services/storage.service');

step('require docker/index');
require('../src/services/docker/index');

step('require docker.controller');
require('../src/controllers/docker.controller');

step('ALL COMPLETED WITHOUT EXIT');
process.exit(0);
