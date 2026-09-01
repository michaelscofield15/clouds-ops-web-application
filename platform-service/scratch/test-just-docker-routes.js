const fs = require('fs');
fs.writeFileSync('./temporary/just-docker.txt', '1. START\n');
const r = require('../src/routes/docker.routes');
fs.appendFileSync('./temporary/just-docker.txt', '2. LOADED DOCKER ROUTES\n');
process.exit(0);
