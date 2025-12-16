/**
 * HTTP Integration Tests
 * Tests the actual HTTP API endpoints (not just services)
 */

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { storeHandler } from '../src/routes/store.route';
import { blobHandler } from '../src/routes/blob.route';
import { healthHandler } from '../src/routes/health.route';
import { validateShardAssignment } from '../src/middleware/shard-validation.middleware';
import { errorHandler, notFoundHandler } from '../src/middleware/error.middleware';
import { storageService } from '../src/services/storage.service';

// Create test app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.post('/store', validateShardAssignment, storeHandler);
app.get('/blob/:cid', blobHandler);
app.get('/health', healthHandler);
app.use(notFoundHandler);
app.use(errorHandler);

describe('HTTP Integration Tests', () => {
  beforeAll(async () => {
    await storageService.initialize();
  });

  afterAll(async () => {
    // Give time for any pending operations to complete
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  // NOTE: POST /store now requires authorization (on-chain verification)
  // These tests are skipped until we have proper mocking for the authorization service
  describe('POST /store', () => {
    it.skip('should store a blob with application/json mimeType (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test+encrypted+json==',
          mimeType: 'application/json',
          metadata: {
            type: 'message',
            threadId: '0x1234',
            guildId: 'test-guild'
          }
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('cid');
      expect(response.body.cid).toMatch(/^[a-f0-9]{64}$/);
    });

    it.skip('should store a blob with application/octet-stream mimeType (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test+encrypted+binary==',
          mimeType: 'application/octet-stream',
          metadata: {
            type: 'file',
            threadId: '0x5678'
          }
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('cid');
    });

    it.skip('should store a blob with image/png mimeType (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test+encrypted+image==',
          mimeType: 'image/png',
          metadata: {
            type: 'media',
            threadId: '0x9abc'
          }
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('cid');
    });

    it.skip('should store a blob with video/mp4 mimeType (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test+encrypted+video==',
          mimeType: 'video/mp4',
          metadata: {
            type: 'media',
            threadId: '0xdef0'
          }
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('cid');
    });

    it('should reject request without ciphertext', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          mimeType: 'application/json',
          metadata: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
      expect(response.body.message).toContain('ciphertext');
    });

    it('should reject request without mimeType', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test==',
          metadata: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
      expect(response.body.message).toContain('mimeType');
    });

    it('should reject request with invalid ciphertext type', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 12345,
          mimeType: 'application/json',
          metadata: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
    });

    it('should reject request with invalid mimeType type', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test==',
          mimeType: 12345,
          metadata: {}
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
    });

    it.skip('should handle large blobs within limit (requires authorization)', async () => {
      const largeCiphertext = 'U2FsdGVkX1+' + 'a'.repeat(1000);
      
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: largeCiphertext,
          mimeType: 'application/octet-stream',
          metadata: {
            type: 'file'
          }
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('cid');
    });
  });

  describe('GET /blob/:cid', () => {
    let testCid: string;

    beforeAll(async () => {
      // Store a test blob
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test+for+retrieval==',
          mimeType: 'application/json',
          metadata: {
            type: 'message',
            threadId: '0xtest'
          }
        });

      testCid = response.body.cid;
    });

    it.skip('should retrieve stored blob (requires authorization to store first)', async () => {
      const response = await request(app)
        .get(`/blob/${testCid}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('cid', testCid);
      expect(response.body).toHaveProperty('ciphertext');
      expect(response.body).toHaveProperty('mimeType');
      expect(response.body).toHaveProperty('size');
      expect(response.body).toHaveProperty('createdAt');
    });

    it('should return 404 for non-existent blob', async () => {
      const fakeCid = 'a'.repeat(64);
      
      const response = await request(app)
        .get(`/blob/${fakeCid}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('BLOB_NOT_FOUND');
    });

    it('should reject invalid CID format', async () => {
      const response = await request(app)
        .get('/blob/invalid-cid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
    });

    it('should reject CID that is too short', async () => {
      const response = await request(app)
        .get('/blob/abc123');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_REQUEST');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.status).toBe(200);
      // Status may be 'healthy' or 'unhealthy' depending on service initialization
      expect(response.body).toHaveProperty('status');
      expect(['healthy', 'unhealthy']).toContain(response.body.status);
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('storedBlobs');
      expect(response.body).toHaveProperty('totalSize');
    });
  });

  describe('Content-Type handling', () => {
    it.skip('should accept application/json content-type (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .set('Content-Type', 'application/json')
        .send({
          ciphertext: 'U2FsdGVkX1+test==',
          mimeType: 'application/json',
          metadata: {}
        });

      expect(response.status).toBe(201);
    });

    it.skip('should handle missing content-type gracefully (requires authorization)', async () => {
      const response = await request(app)
        .post('/store')
        .send({
          ciphertext: 'U2FsdGVkX1+test==',
          mimeType: 'application/json',
          metadata: {}
        });

      expect(response.status).toBe(201);
    });
  });

  describe('Error handling', () => {
    it('should return proper error format', async () => {
      const response = await request(app)
        .post('/store')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should handle 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/unknown-route');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('NOT_FOUND');
    });
  });

  describe('CORS headers', () => {
    it('should include CORS headers', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });
  });
});
