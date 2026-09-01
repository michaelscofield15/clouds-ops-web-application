const fs = require('fs');
function step(msg) {
  fs.appendFileSync('./temporary/docker-lines.txt', `${msg}\n`);
}
fs.writeFileSync('./temporary/docker-lines.txt', '0. Start\n');
try {
  step('1. require express');
  require('express');
  step('2. require docker.controller');
  const dc = require('../src/controllers/docker.controller');
  step('3. require docker.routes');
  const dr = require('../src/routes/docker.routes');
  step('4. Success');
} catch (e) {
  step('Error: ' + e.stack);
}
fs.appendFileSync('./temporary/docker-lines.txt', 'Done\n');
process.exit(0);
