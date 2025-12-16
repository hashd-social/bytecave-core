/**
 * HASHD Vault - Node Info Route
 * 
 * Implements R11.1b: Node Self-Reported Metadata
 */

import { Request, Response } from 'express';
import { createRequire } from 'module';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';
import { contractIntegrationService } from '../services/contract-integration.service.js';
import { logger } from '../utils/logger.js';
import { NodeMetadata } from '../types/index.js';

// Get version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const NODE_VERSION = packageJson.version;

/**
 * Compare semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  
  for (let i = 0; i < 3; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Get node self-reported metadata (R11.1b)
 * 
 * GET /node/info
 */
export async function nodeInfoHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await storageService.getStats();
    const nodeScore = 500; // Default score - could be enhanced with actual reputation data

    // Calculate uptime
    const uptime = process.uptime() * 1000; // milliseconds

    // Get shard participation from environment
    const shardsEnv = process.env.SHARDS || '';
    const shardParticipation = shardsEnv ? parseShardConfig(shardsEnv) : [];

    // Calculate load factor
    const loadFactor = stats.totalSize / (config.gcMaxStorageMB * 1024 * 1024);

    // Get minimum required version from contract
    const minVersion = await contractIntegrationService.getMinVersion();
    
    // Determine version compliance (null means contract not available/not set)
    let isVersionCompliant: boolean;
    let isVersionBehind: boolean;
    
    if (minVersion === null) {
      // Contract not available or minVersion not set - unknown compliance
      isVersionCompliant = false;
      isVersionBehind = false;
    } else {
      const versionStatus = compareVersions(NODE_VERSION, minVersion);
      isVersionCompliant = versionStatus >= 0;
      isVersionBehind = versionStatus < 0;
    }

    const metadata: NodeMetadata = {
      nodeId: config.nodeId,
      version: NODE_VERSION,
      minVersion: minVersion || 'not set',
      versionCompliant: isVersionCompliant,
      versionBehind: isVersionBehind,
      features: [
        'storage',
        'replication',
        'proofs',
        'sharding',
        'gc',
        'pinning',
        'feeds'
      ],
      storageCapacity: config.gcMaxStorageMB * 1024 * 1024,
      storageUsed: stats.totalSize,
      loadFactor: Math.min(1, loadFactor),
      shardParticipation,
      localScore: nodeScore,
      uptime,
      timestamp: Date.now()
    };

    res.json(metadata);
  } catch (error: any) {
    logger.error('Failed to get node info', error);
    res.status(500).json({
      error: 'NODE_INFO_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Parse shard configuration string into array of shard IDs
 */
function parseShardConfig(shardConfig: string): number[] {
  const shards: number[] = [];

  const parts = shardConfig.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      // Range: "0-99"
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        shards.push(i);
      }
    } else {
      // Single shard: "42"
      shards.push(Number(part));
    }
  }

  return shards;
}
