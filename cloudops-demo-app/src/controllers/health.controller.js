/**
 * Health check controller.
 * Exposes endpoint for container liveness and readiness probes.
 */
const getHealth = (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'cloudops-demo-app',
    timestamp: new Date().toISOString()
  });
};

module.exports = {
  getHealth
};
