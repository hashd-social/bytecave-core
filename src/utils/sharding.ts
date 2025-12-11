/**
 * HASHD Vault - Storage Sharding Utilities
 * 
 * Implements Requirement 7: Storage Sharding (Horizontal Partitioning)
 * - Shard key calculation (R7.1)
 * - Client-side shard routing (R7.3)
 * - Shard validation (R7.5, R7.8)
 */

import crypto from 'crypto';
import { ShardRange, NodeShardInfo } from '../types/index.js';

/**
 * Calculate shard key for a CID (R7.1)
 * 
 * Uses modulo approach: shardKey = cid % SHARD_COUNT
 * This is simpler and recommended for MVP.
 * 
 * @param cid Content identifier (hex string)
 * @param shardCount Total number of shards
 * @returns Shard key (0 to shardCount-1)
 */
export function calculateShardKey(cid: string, shardCount: number): number {
  // Convert CID to numeric value for modulo
  // Use first 8 bytes (64 bits) to avoid BigInt complexity
  const cidBuffer = Buffer.from(cid.replace(/^0x/, ''), 'hex');
  
  // Handle short CIDs by using hash
  if (cidBuffer.length === 0) {
    const hash = crypto.createHash('sha256').update(cid).digest();
    const numericValue = hash.readUIntBE(0, 6);
    return numericValue % shardCount;
  }
  
  const numericValue = cidBuffer.readUIntBE(0, Math.min(6, cidBuffer.length));
  
  return numericValue % shardCount;
}

/**
 * Alternative: Calculate shard key using first N bits of SHA-256
 * More uniform distribution but slightly more complex
 */
export function calculateShardKeyBitBased(cid: string, shardCount: number): number {
  const hash = crypto.createHash('sha256').update(cid).digest();
  
  // Calculate how many bits we need
  const bitsNeeded = Math.ceil(Math.log2(shardCount));
  
  // Extract first N bits
  let shardKey = 0;
  for (let i = 0; i < bitsNeeded && i < 32; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = 7 - (i % 8);
    const bit = (hash[byteIndex] >> bitIndex) & 1;
    shardKey = (shardKey << 1) | bit;
  }
  
  return shardKey % shardCount;
}

/**
 * Check if a node is responsible for a shard (R7.3, R7.5)
 * 
 * @param shardKey Shard key to check
 * @param nodeShards Node's shard assignment (array or ranges)
 * @returns true if node is responsible for this shard
 */
export function isNodeResponsibleForShard(
  shardKey: number,
  nodeShards: number[] | ShardRange[]
): boolean {
  if (nodeShards.length === 0) {
    return false;
  }

  // Check if it's an array of explicit shard numbers
  if (typeof nodeShards[0] === 'number') {
    return (nodeShards as number[]).includes(shardKey);
  }

  // Check if it's an array of ranges
  const ranges = nodeShards as ShardRange[];
  return ranges.some(range => 
    shardKey >= range.start && shardKey <= range.end
  );
}

/**
 * Get all eligible nodes for a shard (R7.3)
 * 
 * @param shardKey Shard key
 * @param allNodes All available nodes with their shard info
 * @returns List of node IDs responsible for this shard
 */
export function getEligibleNodesForShard(
  shardKey: number,
  allNodes: NodeShardInfo[]
): string[] {
  return allNodes
    .filter(node => isNodeResponsibleForShard(shardKey, node.shards))
    .map(node => node.nodeId);
}

/**
 * Validate if a blob should be stored on this node (R7.5)
 * 
 * @param cid Content identifier
 * @param nodeShards This node's shard assignment
 * @param shardCount Total shard count
 * @returns true if this node should store the blob
 */
export function shouldNodeStoreCid(
  cid: string,
  nodeShards: number[] | ShardRange[],
  shardCount: number
): boolean {
  const shardKey = calculateShardKey(cid, shardCount);
  return isNodeResponsibleForShard(shardKey, nodeShards);
}

/**
 * Expand shard ranges to explicit list (for debugging/display)
 * 
 * @param shards Shard assignment (numbers or ranges)
 * @param maxShards Maximum number of shards to expand (safety limit)
 * @returns Array of shard numbers
 */
export function expandShardRanges(
  shards: number[] | ShardRange[],
  maxShards: number = 10000
): number[] {
  if (shards.length === 0) {
    return [];
  }

  // Already explicit list
  if (typeof shards[0] === 'number') {
    return shards as number[];
  }

  // Expand ranges
  const ranges = shards as ShardRange[];
  const expanded: number[] = [];

  for (const range of ranges) {
    for (let i = range.start; i <= range.end && expanded.length < maxShards; i++) {
      expanded.push(i);
    }
  }

  return expanded;
}

/**
 * Create shard range from start and end
 */
export function createShardRange(start: number, end: number): ShardRange {
  return { start, end };
}

/**
 * Parse shard configuration from string
 * 
 * Formats supported:
 * - "0-255" -> range
 * - "0,1,2,3" -> explicit list
 * - "[0-255,512-767]" -> multiple ranges
 * 
 * @param config Shard configuration string
 * @returns Parsed shard assignment
 */
export function parseShardConfig(config: string): number[] | ShardRange[] {
  const trimmed = config.trim();

  // Check if it's a range format
  if (trimmed.includes('-') && !trimmed.includes(',')) {
    const [start, end] = trimmed.split('-').map(s => parseInt(s.trim()));
    return [{ start, end }];
  }

  // Check if it's multiple ranges
  if (trimmed.includes('-') && trimmed.includes(',')) {
    const parts = trimmed.split(',');
    return parts.map(part => {
      const [start, end] = part.trim().split('-').map(s => parseInt(s.trim()));
      return { start, end };
    });
  }

  // Explicit list
  return trimmed.split(',').map(s => parseInt(s.trim()));
}

/**
 * Calculate shard distribution statistics
 * 
 * @param allNodes All nodes with shard info
 * @param shardCount Total shard count
 * @returns Distribution statistics
 */
export function calculateShardDistribution(
  allNodes: NodeShardInfo[],
  shardCount: number
): {
  totalShards: number;
  coveredShards: number;
  uncoveredShards: number;
  avgNodesPerShard: number;
  minNodesPerShard: number;
  maxNodesPerShard: number;
} {
  const shardCoverage = new Array(shardCount).fill(0);

  // Count how many nodes cover each shard
  for (const node of allNodes) {
    const shards = expandShardRanges(node.shards, shardCount);
    for (const shard of shards) {
      if (shard < shardCount) {
        shardCoverage[shard]++;
      }
    }
  }

  const coveredShards = shardCoverage.filter(count => count > 0).length;
  const uncoveredShards = shardCount - coveredShards;
  const avgNodesPerShard = coveredShards > 0
    ? shardCoverage.reduce((sum, count) => sum + count, 0) / coveredShards
    : 0;
  const minNodesPerShard = Math.min(...shardCoverage.filter(count => count > 0), 0);
  const maxNodesPerShard = Math.max(...shardCoverage);

  return {
    totalShards: shardCount,
    coveredShards,
    uncoveredShards,
    avgNodesPerShard: Math.round(avgNodesPerShard * 10) / 10,
    minNodesPerShard,
    maxNodesPerShard
  };
}
