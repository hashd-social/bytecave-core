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
