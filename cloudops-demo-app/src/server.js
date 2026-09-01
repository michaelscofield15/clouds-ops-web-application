const app = require('./app');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const server = app.listen(PORT, () => {
  console.log(`[cloudops-demo-app] Server running in ${NODE_ENV} mode at http://localhost:${PORT}`);
});

// Graceful shutdown handling for container lifecycle events (SIGTERM, SIGINT)
const handleShutdown = (signal) => {
  console.log(`[cloudops-demo-app] Received ${signal}. Initiating graceful shutdown...`);
  server.close((err) => {
    if (err) {
      console.error('[cloudops-demo-app] Error during shutdown:', err);
      process.exit(1);
    }
    console.log('[cloudops-demo-app] HTTP server closed gracefully. Process terminating.');
    process.exit(0);
  });

  // Force exit if connections take too long to close
  setTimeout(() => {
    console.error('[cloudops-demo-app] Forced shutdown: connections did not close in time.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

module.exports = server;
