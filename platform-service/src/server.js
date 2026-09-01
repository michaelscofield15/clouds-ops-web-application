const app = require('./app');
const config = require('./config');

const port = parseInt(config.port, 10) || 4000;
const server = app.listen(port, '0.0.0.0', () => {
  process.stdout.write(`[platform-service] Platform running in ${config.nodeEnv} mode at http://localhost:${port}\n`);
  console.log(`[platform-service] Platform running in ${config.nodeEnv} mode at http://localhost:${port}`);
});

server.on('error', (err) => {
  process.stderr.write(`[platform-service] Server listen error: ${err.stack || err.message}\n`);
  console.error('[platform-service] Server listen error:', err);
});

module.exports = server;
