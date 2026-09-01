const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');

describe('CloudOps Demo App API Suite', () => {
  describe('GET /', () => {
    it('should return 200 with application status message', async () => {
      const res = await request(app).get('/');
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'cloudops-demo-app');
      assert.equal(res.body.message, 'CloudOps Demo Application is running');
      assert.equal(res.body.version, '1.0.0');
    });
  });

  describe('GET /health', () => {
    it('should return 200 with healthy status and dynamic timestamp', async () => {
      const startTime = Date.now();
      const res = await request(app).get('/health');
      const endTime = Date.now();

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
      assert.equal(res.body.service, 'cloudops-demo-app');
      assert.ok(res.body.timestamp, 'timestamp must be present');

      const parsedTimestamp = new Date(res.body.timestamp).getTime();
      assert.ok(!isNaN(parsedTimestamp), 'timestamp must be a valid ISO date');
      assert.ok(
        parsedTimestamp >= startTime - 1000 && parsedTimestamp <= endTime + 1000,
        'timestamp must be freshly generated'
      );
    });
  });

  describe('GET /api/info', () => {
    it('should return application metadata and environment info', async () => {
      const res = await request(app).get('/api/info');
      assert.equal(res.status, 200);
      assert.equal(res.body.application, 'cloudops-demo-app');
      assert.equal(res.body.version, '1.0.0');
      assert.ok(res.body.environment, 'environment must be present');
    });
  });

  describe('GET /api/users', () => {
    it('should return sample list of users', async () => {
      const res = await request(app).get('/api/users');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body), 'response must be an array');
      assert.ok(res.body.length >= 2, 'should return sample users');
      assert.equal(res.body[0].id, 1);
      assert.equal(res.body[0].name, 'Alice');
      assert.equal(res.body[0].role, 'user');
    });
  });

  describe('GET /api/users/:id', () => {
    it('should return a user for a valid existing ID', async () => {
      const res = await request(app).get('/api/users/1');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 1);
      assert.equal(res.body.name, 'Alice');
      assert.equal(res.body.role, 'user');
    });

    it('should return 404 when user ID does not exist', async () => {
      const res = await request(app).get('/api/users/9999');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'User not found');
    });

    it('should return 404 when user ID is non-numeric', async () => {
      const res = await request(app).get('/api/users/invalid-id');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'User not found');
    });
  });

  describe('GET /api/products', () => {
    it('should return sample list of products with required schema', async () => {
      const res = await request(app).get('/api/products');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body), 'response must be an array');
      assert.ok(res.body.length > 0, 'products list must not be empty');

      const product = res.body[0];
      assert.ok('id' in product, 'product must have id');
      assert.ok('name' in product, 'product must have name');
      assert.ok('category' in product, 'product must have category');
      assert.ok('price' in product, 'product must have price');
      assert.equal(typeof product.price, 'number');
    });
  });

  describe('Error Handling - 404 Unknown Routes', () => {
    it('should return HTTP 404 with structured JSON for unknown routes', async () => {
      const res = await request(app).get('/does-not-exist');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'Resource not found');
      assert.equal(res.body.path, '/does-not-exist');
    });
  });
});
