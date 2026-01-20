/**
 * HTTP Integration Tests
 * Tests the actual HTTP API endpoints (not just services)
 * 
 * NOTE: Storage endpoints removed - storage now only via P2P protocols
 */

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { blobHandler } from '../src/routes/blob.route';
import { healthHandler } from '../src/routes/health.route';
import { errorHandler, notFoundHandler } from '../src/middleware/error.middleware';
import { storageService } from '../src/services/storage.service';

// Create test app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

  describe('GET /blob/:cid', () => {
    // Note: Blobs must be stored via P2P protocols, not HTTP
    // These tests verify blob retrieval only

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

  describe('Error handling', () => {
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
