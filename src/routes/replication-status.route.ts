/**
 * HASHD Vault - Replication Status Route
 * GET /replication/:cid - Get replication status (R6.5)
 */

import { Request, Response } from 'express';
import { replicationManager } from '../services/replication-manager.service.js';
import { logger } from '../utils/logger.js';

/**
 * Get replication status for a CID (R6.5)
 */
export async function replicationStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'cid parameter is required',
        timestamp: Date.now()
      });
      return;
    }

    const status = replicationManager.getReplicationStatus(cid);

    res.json(status);
  } catch (error: any) {
    logger.error('Failed to get replication status', error);

    res.status(500).json({
      error: 'REPLICATION_STATUS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get all replication states
 */
export async function allReplicationStatesHandler(_req: Request, res: Response): Promise<void> {
  try {
    const states = replicationManager.getAllStates();

    res.json({
      count: states.length,
      states
    });
  } catch (error: any) {
    logger.error('Failed to get all replication states', error);

    res.status(500).json({
      error: 'REPLICATION_STATES_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get replication statistics
 */
export async function replicationStatsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = replicationManager.getStats();

    res.json(stats);
  } catch (error: any) {
    logger.error('Failed to get replication stats', error);

    res.status(500).json({
      error: 'REPLICATION_STATS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
