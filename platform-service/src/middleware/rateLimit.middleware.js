/**
 * Simple in-memory sliding window rate limiter
 * @param {object} options { windowMs: number, max: number, message: string }
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute default
  const maxHits = options.max || 30; // 30 requests per minute default
  const message = options.message || 'Too many requests. Please try again later.';

  const hits = new Map(); // ip -> Array<timestamp>

  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(key) || [];
    timestamps = timestamps.filter(ts => ts > windowStart);

    if (timestamps.length >= maxHits) {
      const oldest = timestamps[0];
      const retryAfterSec = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      res.setHeader('X-RateLimit-Limit', maxHits);
      res.setHeader('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        error: 'TooManyRequests',
        message,
        retryAfterSeconds: retryAfterSec
      });
    }

    timestamps.push(now);
    hits.set(key, timestamps);

    res.setHeader('X-RateLimit-Limit', maxHits);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxHits - timestamps.length));

    // Periodic map cleanup
    if (hits.size > 5000) {
      for (const [k, tsList] of hits.entries()) {
        const filtered = tsList.filter(ts => ts > windowStart);
        if (filtered.length === 0) hits.delete(k);
        else hits.set(k, filtered);
      }
    }

    next();
  };
}

module.exports = {
  createRateLimiter,
  authLimiter: createRateLimiter({ windowMs: 60 * 1000, max: 20, message: 'Too many authentication attempts.' }),
  uploadLimiter: createRateLimiter({ windowMs: 60 * 1000, max: 15, message: 'Upload rate limit exceeded.' })
};
