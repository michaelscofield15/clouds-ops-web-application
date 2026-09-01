const app = require('./src/app');
const config = require('./src/config');
const http = require('http');

console.log('Config port:', config.port);
const server = http.createServer(app);
server.listen(config.port, '0.0.0.0', () => {
  console.log('HTTP Server successfully listening on 0.0.0.0:' + config.port);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
