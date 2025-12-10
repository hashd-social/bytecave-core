/**
 * HASHD Vault - Status Route
 * GET /status - Node status and capacity (Requirement 2.5)
 */

import { Request, Response } from 'express';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';
import { metricsService } from '../services/metrics.service.js';
import { logger } from '../utils/logger.js';

const VERSION = '1.0.0';

export async function statusHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await storageService.getStats();
    const uptime = metricsService.getUptime();
    const maxCapacityBytes = config.maxStorageGB * 1024 * 1024 * 1024; // Convert GB to bytes

    // Response matches Requirement 2.5 spec
    const response = {
      nodeId: config.nodeId,
      version: VERSION,
      capacityBytes: maxCapacityBytes,
      usedBytes: stats.totalSize,
      storedCIDs: stats.blobCount,
      lastProof: 0, // TODO: Implement storage proofs (Requirement 2.6)
      uptime,
      endpoint: config.nodeUrl,
      replicationFactor: config.replicationFactor,
      isAcceptingBlobs: stats.totalSize < maxCapacityBytes
    };

    res.json(response);

    logger.debug('Status request completed');
  } catch (error: any) {
    logger.error('Status check failed', error);

    res.status(500).json({
      error: 'STATUS_CHECK_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
