const app = require('./src/app');
const config = require('./src/config');

const port = parseInt(config.port, 10) || 4000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[platform-service] Platform running in ${config.nodeEnv} mode at http://localhost:${port}`);
});

server.on('error', (err) => {
  console.error('[platform-service] Server listen error:', err);
});

// Keep event loop active for background daemons
setInterval(() => {}, 60000);

module.exports = server;
