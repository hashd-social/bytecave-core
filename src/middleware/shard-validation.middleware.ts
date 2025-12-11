/**
 * HASHD Vault - Shard Validation Middleware
 * 
 * Implements Requirement 7.5: Node Enforcement
 * Rejects blobs that don't belong to this node's shard assignment
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { shouldNodeStoreCid } from '../utils/sharding.js';

/**
 * Validate that a CID belongs to this node's shard assignment (R7.5)
 * 
 * Usage:
 * app.post('/store', validateShardAssignment, storeHandler);
 * app.post('/replicate', validateShardAssignment, replicateHandler);
 */
export function validateShardAssignment(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    // Extract CID from request
    const cid = req.body?.cid || req.params?.cid;

    if (!cid) {
      // If no CID, let the route handler deal with validation
      next();
      return;
    }

    // Check if this node should store this CID
    const shouldStore = shouldNodeStoreCid(
      cid,
      config.nodeShards,
      config.shardCount
    );

    if (!shouldStore) {
      logger.warn('Shard mismatch - rejecting blob', {
        cid,
        nodeShards: config.nodeShards,
        shardCount: config.shardCount
      });

      res.status(403).json({
        error: 'SHARD_MISMATCH',
        message: 'This node is not responsible for storing this CID',
        details: {
          cid,
          nodeId: config.nodeId,
          nodeShards: config.nodeShards,
          shardCount: config.shardCount
        },
        timestamp: Date.now()
      });
      return;
    }

    // CID belongs to this node's shard - proceed
    next();
  } catch (error: any) {
    logger.error('Shard validation error', error);

    res.status(500).json({
      error: 'SHARD_VALIDATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Validate shard assignment for proof requests (R7.8)
 * 
 * Nodes should only provide proofs for blobs they actually store
 */
export function validateShardForProof(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const cid = req.body?.cid || req.params?.cid;

    if (!cid) {
      next();
      return;
    }

    const shouldStore = shouldNodeStoreCid(
      cid,
      config.nodeShards,
      config.shardCount
    );

    if (!shouldStore) {
      logger.warn('Proof request for non-shard blob', { cid });

      res.status(403).json({
        error: 'SHARD_MISMATCH',
        message: 'This node does not store blobs in this shard',
        timestamp: Date.now()
      });
      return;
    }

    next();
  } catch (error: any) {
    logger.error('Shard validation error for proof', error);

    res.status(500).json({
      error: 'SHARD_VALIDATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
