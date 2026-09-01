const fs = require('fs');
const http = require('http');
const app = require('../src/app');

const server = http.createServer(app);
server.listen(4000, '0.0.0.0', () => {
  try {
    fs.mkdirSync('./temporary', { recursive: true });
    fs.writeFileSync('./temporary/server-ready.txt', 'READY ON 4000\n');
  } catch {}
  console.log('HTTP Server listening on 0.0.0.0:4000');
});

server.on('error', (err) => {
  console.error('Server error:', err);
});
