/**
 * HASHD Vault - Network Stats Route
 * 
 * GET /network/stats - Returns network-wide node statistics
 * Used by frontend to select optimal vault nodes
 */

import { Request, Response } from 'express';
import { config } from '../config/index.js';
import { replicationService } from '../services/replication.service.js';
import { logger } from '../utils/logger.js';

interface NodeStats {
  url: string;
  nodeId: string;
  healthy: boolean;
  latency?: number;
  lastChecked: number;
}

interface NetworkStatsResponse {
  currentNode: {
    url: string;
    nodeId: string;
    healthy: boolean;
  };
  nodes: NodeStats[];
  recommendedNodes: string[];
  totalNodes: number;
  healthyNodes: number;
  timestamp: number;
}

/**
 * Get network statistics and recommended nodes
 * 
 * GET /network/stats
 */
export async function networkStatsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const peers = replicationService.getPeers();
    
    // Build node stats from peer data
    const nodeStats: NodeStats[] = peers.map(peer => ({
      url: peer.url,
      nodeId: peer.nodeId || 'unknown',
      healthy: peer.healthy ?? false,
      latency: peer.latency,
      lastChecked: peer.lastHealthCheck || 0
    }));

    // Get healthy nodes sorted by latency (if available) or just healthy ones
    const healthyNodes = nodeStats
      .filter(n => n.healthy)
      .sort((a, b) => (a.latency || 9999) - (b.latency || 9999));

    // Recommend top 3 healthy nodes (or fewer if not enough)
    const recommendedNodes = healthyNodes
      .slice(0, 3)
      .map(n => n.url);

    // Always include current node as first recommendation if healthy
    const currentNodeUrl = config.nodeUrl || `http://localhost:${config.port}`;
    if (!recommendedNodes.includes(currentNodeUrl)) {
      recommendedNodes.unshift(currentNodeUrl);
      if (recommendedNodes.length > 3) {
        recommendedNodes.pop();
      }
    }

    const response: NetworkStatsResponse = {
      currentNode: {
        url: currentNodeUrl,
        nodeId: config.nodeId,
        healthy: true
      },
      nodes: nodeStats,
      recommendedNodes,
      totalNodes: nodeStats.length + 1, // +1 for current node
      healthyNodes: healthyNodes.length + 1,
      timestamp: Date.now()
    };

    res.json(response);

    logger.debug('Network stats requested', {
      totalNodes: response.totalNodes,
      healthyNodes: response.healthyNodes
    });
  } catch (error: any) {
    logger.error('Failed to get network stats', error);
    res.status(500).json({
      error: 'NETWORK_STATS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
