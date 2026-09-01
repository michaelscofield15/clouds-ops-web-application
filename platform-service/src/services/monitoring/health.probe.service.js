const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Service for performing real HTTP health checks against deployed application endpoints.
 * Measures latency, status codes, and records rolling failure rates.
 */
class HealthProbeService {
  constructor() {
    this.defaultTimeoutMs = 10000;
  }

  /**
   * Probes an application URL and measures real latency and response status.
   * @param {string} endpoint Full URL (e.g. http://43.205.144.97:3000/health)
   * @param {object} options Optional timeout and headers
   * @returns {Promise<object>} Detailed health probe result
   */
  async probeEndpoint(endpoint, options = {}) {
    if (!endpoint || typeof endpoint !== 'string') {
      return {
        source: 'HTTP Health Check',
        status: 'UNCONFIGURED',
        isHealthy: false,
        httpStatus: null,
        durationMs: null,
        timestamp: new Date().toISOString(),
        error: 'No endpoint URL provided for health probe'
      };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(endpoint);
    } catch (err) {
      return {
        source: 'HTTP Health Check',
        status: 'INVALID_URL',
        isHealthy: false,
        httpStatus: null,
        durationMs: null,
        endpoint,
        timestamp: new Date().toISOString(),
        error: `Invalid health probe URL: ${err.message}`
      };
    }

    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const requestOptions = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      headers: {
        'User-Agent': 'CloudOps-Monitoring-Probe/1.0',
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
      },
      timeout: timeoutMs
    };

    const startTime = process.hrtime.bigint();

    return new Promise((resolve) => {
      const req = client.request(requestOptions, (res) => {
        let rawBody = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          if (rawBody.length < 8192) {
            rawBody += chunk;
          }
        });

        res.on('end', () => {
          const endTime = process.hrtime.bigint();
          const durationNs = Number(endTime - startTime);
          const durationMs = Number((durationNs / 1e6).toFixed(2));

          const statusCode = res.statusCode || 0;
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = rawBody.trim() ? rawBody.slice(0, 500) : null;
          }

          const isHealthy = statusCode >= 200 && statusCode < 300;
          const isDegraded = isHealthy && durationMs > 2500;

          let status = 'HEALTHY';
          if (!isHealthy) {
            status = statusCode >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
          } else if (isDegraded) {
            status = 'DEGRADED';
          }

          resolve({
            source: 'HTTP Health Check',
            status,
            isHealthy,
            httpStatus: statusCode,
            durationMs,
            endpoint,
            headers: {
              contentType: res.headers['content-type'] || null,
              contentLength: res.headers['content-length'] || null
            },
            body: parsedBody,
            timestamp: new Date().toISOString(),
            error: isHealthy ? null : `HTTP ${statusCode} returned from application endpoint`
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const endTime = process.hrtime.bigint();
        const durationMs = Number((Number(endTime - startTime) / 1e6).toFixed(2));

        resolve({
          source: 'HTTP Health Check',
          status: 'TIMEOUT',
          isHealthy: false,
          httpStatus: null,
          durationMs,
          endpoint,
          timestamp: new Date().toISOString(),
          error: `Health check request timed out after ${timeoutMs}ms`
        });
      });

      req.on('error', (err) => {
        const endTime = process.hrtime.bigint();
        const durationMs = Number((Number(endTime - startTime) / 1e6).toFixed(2));

        resolve({
          source: 'HTTP Health Check',
          status: 'UNREACHABLE',
          isHealthy: false,
          httpStatus: null,
          durationMs,
          endpoint,
          timestamp: new Date().toISOString(),
          error: `Connection error: ${err.message}`
        });
      });

      req.end();
    });
  }

  /**
   * Computes health check failure rate and statistics over a list of health check records.
   * @param {Array<object>} healthHistory Array of previous probe results
   * @returns {object} Summary statistics
   */
  calculateHealthSummary(healthHistory = []) {
    if (!Array.isArray(healthHistory) || healthHistory.length === 0) {
      return {
        totalChecks: 0,
        successfulChecks: 0,
        failedChecks: 0,
        healthCheckFailureRate: null,
        averageDurationMs: null,
        latestStatus: 'NO_DATA'
      };
    }

    const total = healthHistory.length;
    let successCount = 0;
    let failureCount = 0;
    let totalDurationMs = 0;
    let durationCount = 0;

    for (const record of healthHistory) {
      if (record.isHealthy) {
        successCount++;
      } else {
        failureCount++;
      }

      if (typeof record.durationMs === 'number' && record.durationMs > 0) {
        totalDurationMs += record.durationMs;
        durationCount++;
      }
    }

    const failureRate = total > 0 ? Number(((failureCount / total) * 100).toFixed(2)) : 0;
    const avgDuration = durationCount > 0 ? Number((totalDurationMs / durationCount).toFixed(2)) : null;
    const latest = healthHistory[healthHistory.length - 1];

    let status = 'HEALTHY';
    if (failureRate >= 50) {
      status = 'UNHEALTHY';
    } else if (failureRate > 0) {
      status = 'DEGRADED';
    }

    return {
      status,
      totalChecks: total,
      successfulChecks: successCount,
      failedChecks: failureCount,
      healthCheckFailureRate: failureRate,
      averageDurationMs: avgDuration,
      latestStatus: latest ? latest.status : 'NO_DATA',
      lastChecked: latest ? latest.timestamp : null
    };
  }
}

module.exports = new HealthProbeService();
module.exports.HealthProbeService = HealthProbeService;
