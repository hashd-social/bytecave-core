/**
 * Version Check Middleware
 * 
 * Blocks storage and replication operations when node version is below minVersion.
 * Returns 503 Service Unavailable with OUTDATED status.
 */

import { Request, Response, NextFunction } from 'express';
import { versionCheckService } from '../services/version-check.service.js';
import { logger } from '../utils/logger.js';

/**
 * Middleware to block operations when node is outdated
 */
export function requireUpToDateVersion(req: Request, res: Response, next: NextFunction): void {
  if (versionCheckService.isNodeOutdated()) {
    const versionStatus = versionCheckService.getVersionStatus();
    
    logger.warn('Operation blocked - node version is outdated', {
      path: req.path,
      current: versionStatus.current,
      required: versionStatus.minimum
    });

    res.status(503).json({
      success: false,
      error: 'NODE_OUTDATED',
      message: 'Node version is outdated and cannot participate in network operations',
      current: versionStatus.current,
      required: versionStatus.minimum,
      action: 'Please update your node to continue'
    });
    return;
  }

  next();
}
