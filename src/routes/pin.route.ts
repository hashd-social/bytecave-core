/**
 * HASHD Vault - Pin Routes
 * 
 * Implements Requirement 9: Pinning & Data Permanence
 * - POST /pin/:cid - Pin a blob (R9.3)
 * - DELETE /pin/:cid - Unpin a blob (R9.3)
 * - GET /pin/list - List all pinned blobs (R9.7)
 * - POST /pin/bulk - Bulk pin operations (R9.7)
 */

import { Request, Response } from 'express';
import { storageService } from '../services/storage.service.js';
import { logger } from '../utils/logger.js';

/**
 * Pin a blob (R9.3)
 * Makes blob permanent and immune to GC
 */
export async function pinBlobHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_CID',
        message: 'CID is required',
        timestamp: Date.now()
      });
      return;
    }

    // Check if blob exists
    const exists = await storageService.hasBlob(cid);
    if (!exists) {
      res.status(404).json({
        error: 'BLOB_NOT_FOUND',
        message: `Blob ${cid} not found`,
        timestamp: Date.now()
      });
      return;
    }

    // Pin the blob
    await storageService.pinBlob(cid);

    logger.info('Blob pinned', { cid });

    res.json({
      cid,
      pinned: true,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to pin blob', error);
    res.status(500).json({
      error: 'PIN_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Unpin a blob (R9.3)
 * Makes blob eligible for GC again
 */
export async function unpinBlobHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_CID',
        message: 'CID is required',
        timestamp: Date.now()
      });
      return;
    }

    // Check if blob exists
    const exists = await storageService.hasBlob(cid);
    if (!exists) {
      res.status(404).json({
        error: 'BLOB_NOT_FOUND',
        message: `Blob ${cid} not found`,
        timestamp: Date.now()
      });
      return;
    }

    // Unpin the blob
    await storageService.unpinBlob(cid);

    logger.info('Blob unpinned', { cid });

    res.json({
      cid,
      pinned: false,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to unpin blob', error);
    res.status(500).json({
      error: 'UNPIN_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * List all pinned blobs (R9.7)
 */
export async function listPinnedBlobsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const pinnedBlobs = await storageService.listPinnedBlobs();

    res.json({
      count: pinnedBlobs.length,
      blobs: pinnedBlobs.map(blob => ({
        cid: blob.cid,
        size: blob.size,
        mimeType: blob.mimeType,
        createdAt: blob.createdAt,
        pinned: blob.pinned
      })),
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to list pinned blobs', error);
    res.status(500).json({
      error: 'LIST_PINNED_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Bulk pin operations (R9.7)
 * 
 * Body: {
 *   operation: 'pin' | 'unpin',
 *   cids: string[]
 * }
 */
export async function bulkPinHandler(req: Request, res: Response): Promise<void> {
  try {
    const { operation, cids } = req.body;

    if (!operation || !['pin', 'unpin'].includes(operation)) {
      res.status(400).json({
        error: 'INVALID_OPERATION',
        message: 'Operation must be "pin" or "unpin"',
        timestamp: Date.now()
      });
      return;
    }

    if (!Array.isArray(cids) || cids.length === 0) {
      res.status(400).json({
        error: 'INVALID_CIDS',
        message: 'CIDs must be a non-empty array',
        timestamp: Date.now()
      });
      return;
    }

    const results = {
      success: [] as string[],
      failed: [] as { cid: string; error: string }[]
    };

    // Process each CID
    for (const cid of cids) {
      try {
        const exists = await storageService.hasBlob(cid);
        if (!exists) {
          results.failed.push({ cid, error: 'Blob not found' });
          continue;
        }

        if (operation === 'pin') {
          await storageService.pinBlob(cid);
        } else {
          await storageService.unpinBlob(cid);
        }

        results.success.push(cid);
      } catch (error: any) {
        results.failed.push({ cid, error: error.message });
      }
    }

    logger.info('Bulk pin operation completed', {
      operation,
      total: cids.length,
      success: results.success.length,
      failed: results.failed.length
    });

    res.json({
      operation,
      total: cids.length,
      success: results.success.length,
      failed: results.failed.length,
      results,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Bulk pin operation failed', error);
    res.status(500).json({
      error: 'BULK_PIN_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get blob status including pin status (R9.8)
 */
export async function blobStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_CID',
        message: 'CID is required',
        timestamp: Date.now()
      });
      return;
    }

    // Check if blob exists
    const exists = await storageService.hasBlob(cid);
    if (!exists) {
      res.status(404).json({
        error: 'BLOB_NOT_FOUND',
        message: `Blob ${cid} not found`,
        timestamp: Date.now()
      });
      return;
    }

    // Get metadata
    const metadata = await storageService.getMetadata(cid);

    res.json({
      cid,
      pinned: metadata.pinned || false,
      size: metadata.size,
      mimeType: metadata.mimeType,
      createdAt: metadata.createdAt,
      replicas: metadata.replication?.replicatedTo || [],
      lastAccessed: metadata.metrics?.lastAccessed || metadata.createdAt,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to get blob status', error);
    res.status(500).json({
      error: 'STATUS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
