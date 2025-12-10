/**
 * HASHD Vault - Health Route
 * GET /health - Node health and metrics
 */

import { Request, Response } from 'express';
import { storageService } from '../services/storage.service.js';
import { replicationService } from '../services/replication.service.js';
import { metricsService } from '../services/metrics.service.js';
import { logger } from '../utils/logger.js';
import { HealthResponse } from '../types/index.js';

const VERSION = '1.0.0';

export async function healthHandler(req: Request, res: Response): Promise<void> {
  try {
    const stats = await storageService.getStats();
    const metrics = metricsService.getMetrics();
    const uptime = metricsService.getUptime();
    const successRate = metricsService.getSuccessRate();
    const peerCount = replicationService.getEnabledPeerCount();

    // Determine health status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    // Degraded if success rate is below 90%
    if (successRate < 0.9) {
      status = 'degraded';
    }
    
    // Unhealthy only if success rate is critically low
    if (successRate < 0.5) {
      status = 'unhealthy';
    }

    const response: HealthResponse = {
      status,
      uptime,
      storedBlobs: stats.blobCount,
      totalSize: stats.totalSize,
      latencyMs: metrics.avgLatency,
      version: VERSION,
      peers: peerCount,
      lastReplication: 0, // TODO: Track last replication time
      metrics: {
        requestsLastHour: metrics.requestsLastHour,
        avgResponseTime: metrics.avgLatency,
        successRate
      }
    };

    res.json(response);
  } catch (error: any) {
    logger.error('Health check failed', error);

    res.status(503).json({
      status: 'unhealthy',
      error: 'Health check failed',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
