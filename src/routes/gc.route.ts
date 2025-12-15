/**
 * HASHD Vault - Garbage Collection Routes
 * 
 * GET /gc/status - Get GC status (R8.6)
 * POST /admin/gc - Trigger GC manually (R8.5)
 */

import { Request, Response } from 'express';
import { gcService } from '../services/gc.service.js';
import { logger } from '../utils/logger.js';

/**
 * Get GC status (R8.6)
 */
export async function gcStatusHandler(_req: Request, res: Response): Promise<void> {
  try {
    const status = await gcService.getStatus();
    res.json(status);
  } catch (error: any) {
    logger.error('Failed to get GC status', error);
    res.status(500).json({
      error: 'GC_STATUS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Trigger GC manually (R8.5)
 * 
 * Query params:
 * - simulate: boolean - dry-run mode
 */
export async function triggerGCHandler(req: Request, res: Response): Promise<void> {
  try {
    const simulate = req.query.simulate === 'true';

    if (gcService.isRunning()) {
      res.status(409).json({
        error: 'GC_ALREADY_RUNNING',
        message: 'Garbage collection is already in progress',
        timestamp: Date.now()
      });
      return;
    }

    logger.info('Manual GC triggered', { simulate });

    const result = await gcService.runGC(simulate);

    res.json({
      ...result,
      simulate
    });
  } catch (error: any) {
    logger.error('Manual GC failed', error);
    res.status(500).json({
      error: 'GC_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Force purge ALL blobs (DEV ONLY)
 * 
 * ⚠️ WARNING: Bypasses all safety checks
 * - Deletes pinned blobs
 * - Ignores shard assignments
 * - Ignores replication factor
 * 
 * Use only for:
 * - Local development testing
 * - Single-node environments
 * - Complete node reset
 */
export async function forcePurgeHandler(_req: Request, res: Response): Promise<void> {
  try {
    logger.warn('⚠️ FORCE PURGE initiated - bypassing all safety checks');

    const result = await gcService.forcePurgeAll();

    res.json({
      ...result,
      warning: 'All blobs deleted - safety checks bypassed'
    });
  } catch (error: any) {
    logger.error('Force purge failed', error);
    res.status(500).json({
      error: 'FORCE_PURGE_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Delete specific blob (PRODUCTION SAFE)
 * 
 * Performs safety checks:
 * - Verifies replication factor
 * - Checks shard assignment
 * - Respects pin status
 * 
 * Query params:
 * - force: boolean - skip replication checks (still respects pins)
 */
export async function deleteBlobHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;
    const force = req.query.force === 'true';

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'CID is required',
        timestamp: Date.now()
      });
      return;
    }

    logger.info('Blob deletion requested', { cid, force });

    const result = await gcService.deleteSingleBlob(cid, force);

    res.json(result);
  } catch (error: any) {
    logger.error('Blob deletion failed', error);
    res.status(500).json({
      error: 'DELETE_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
