/**
 * HASHD Vault - List Route
 * GET /blobs - List all stored blobs
 */

import { Request, Response } from 'express';
import { storageService } from '../services/storage.service.js';
import { logger } from '../utils/logger.js';

export async function listHandler(_req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    logger.debug('List blobs request received');

    const blobs = await storageService.listBlobs();

    const response = {
      count: blobs.length,
      blobs: blobs.map(blob => ({
        cid: blob.cid,
        size: blob.size,
        mimeType: blob.mimeType,
        createdAt: blob.createdAt,
        retrievalCount: blob.metrics?.retrievalCount || 0,
        lastAccessed: blob.metrics?.lastAccessed || blob.createdAt
      }))
    };

    const latency = Date.now() - startTime;

    res.json(response);

    logger.debug('List blobs completed', {
      count: blobs.length,
      latency
    });
  } catch (error: any) {
    logger.error('List blobs failed', error);

    res.status(500).json({
      error: 'LIST_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
