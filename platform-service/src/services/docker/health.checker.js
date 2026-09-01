const http = require('http');
const config = require('../../config');

class HealthChecker {
  /**
   * Performs a single HTTP GET request against the container host port
   */
  async probe(hostPort, endpoint = '/health') {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: hostPort,
        path: endpoint,
        method: 'GET',
        timeout: config.docker.healthCheckTimeoutMs
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          let jsonBody = null;
          try {
            jsonBody = JSON.parse(body);
          } catch (e) {
            jsonBody = body;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: jsonBody
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Health check timed out after ${config.docker.healthCheckTimeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  /**
   * Polls the health endpoint over a startup window with retries
   */
  async waitForHealthy(hostPort, endpoint = '/health', customRetries, customInterval) {
    const maxRetries = customRetries || config.docker.healthCheckRetries;
    const intervalMs = customInterval || config.docker.healthCheckIntervalMs;

    let lastError = null;
    let lastResponse = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.probe(hostPort, endpoint);
        lastResponse = res;

        if (res.statusCode === 200) {
          return {
            status: 'healthy',
            statusCode: 200,
            attempts: attempt,
            response: res.body,
            endpoint
          };
        }

        lastError = new Error(`Health check returned HTTP ${res.statusCode}`);
      } catch (err) {
        lastError = err;
      }

      // Wait before next probe
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return {
      status: 'unhealthy',
      attempts: maxRetries,
      statusCode: lastResponse ? lastResponse.statusCode : null,
      lastError: lastError ? lastError.message : 'Unknown health check failure',
      endpoint
    };
  }
}

module.exports = new HealthChecker();
