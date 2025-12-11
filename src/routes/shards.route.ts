/**
 * HASHD Vault - Shards Route
 * GET /shards - Get node's shard assignment (R7.6)
 */

import { Request, Response } from 'express';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { expandShardRanges } from '../utils/sharding.js';

/**
 * Get node's shard assignment (R7.6)
 */
export async function shardsHandler(_req: Request, res: Response): Promise<void> {
  try {
    res.json({
      nodeId: config.nodeId,
      shards: config.nodeShards,
      shardCount: config.shardCount,
      // Include expanded list for convenience (limited to first 100)
      shardsExpanded: expandShardRanges(config.nodeShards, 100)
    });
  } catch (error: any) {
    logger.error('Failed to get shard info', error);

    res.status(500).json({
      error: 'SHARD_INFO_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
