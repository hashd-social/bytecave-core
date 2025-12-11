/**
 * Tests for Storage Sharding (Horizontal Partitioning)
 */

import {
  calculateShardKey,
  isNodeResponsibleForShard,
  shouldNodeStoreCid,
  expandShardRanges,
  parseShardConfig,
  calculateShardDistribution
} from '../src/utils/sharding.js';
import { ShardRange, NodeShardInfo } from '../src/types/index.js';

describe('Shard Key Calculation', () => {
  test('should calculate consistent shard key for same CID', () => {
    const cid = '123abc';
    const shardCount = 1024;
    
    const shard1 = calculateShardKey(cid, shardCount);
    const shard2 = calculateShardKey(cid, shardCount);
    
    expect(shard1).toBe(shard2);
  });

  test('should return shard key within valid range', () => {
    const cid = '123abc';
    const shardCount = 1024;
    
    const shardKey = calculateShardKey(cid, shardCount);
    
    expect(shardKey).toBeGreaterThanOrEqual(0);
    expect(shardKey).toBeLessThan(shardCount);
  });

  test('should distribute different CIDs across shards', () => {
    const shardCount = 1024;
    const shards = new Set<number>();
    
    // Generate 100 different CIDs
    for (let i = 0; i < 100; i++) {
      const cid = `cid-${i}`;
      const shardKey = calculateShardKey(cid, shardCount);
      shards.add(shardKey);
    }
    
    // Should use multiple different shards
    expect(shards.size).toBeGreaterThan(10);
  });

  test('should handle different shard counts', () => {
    const cid = '123abc';
    
    const shard256 = calculateShardKey(cid, 256);
    const shard1024 = calculateShardKey(cid, 1024);
    const shard4096 = calculateShardKey(cid, 4096);
    
    expect(shard256).toBeLessThan(256);
    expect(shard1024).toBeLessThan(1024);
    expect(shard4096).toBeLessThan(4096);
  });
});

describe('Node Shard Responsibility', () => {
  test('should check if node is responsible for shard (explicit list)', () => {
    const shardKey = 100;
    const nodeShards = [50, 100, 150, 200];
    
    expect(isNodeResponsibleForShard(shardKey, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(75, nodeShards)).toBe(false);
  });

  test('should check if node is responsible for shard (range)', () => {
    const nodeShards: ShardRange[] = [{ start: 0, end: 255 }];
    
    expect(isNodeResponsibleForShard(100, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(0, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(255, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(256, nodeShards)).toBe(false);
  });

  test('should check if node is responsible for shard (multiple ranges)', () => {
    const nodeShards: ShardRange[] = [
      { start: 0, end: 255 },
      { start: 512, end: 767 }
    ];
    
    expect(isNodeResponsibleForShard(100, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(600, nodeShards)).toBe(true);
    expect(isNodeResponsibleForShard(400, nodeShards)).toBe(false);
  });

  test('should return false for empty shard list', () => {
    expect(isNodeResponsibleForShard(100, [])).toBe(false);
  });
});

describe('CID Storage Validation', () => {
  test('should validate if node should store CID', () => {
    const cid = '123abc';
    const shardCount = 1024;
    
    const nodeShards: ShardRange[] = [{ start: 0, end: 1023 }];
    
    expect(shouldNodeStoreCid(cid, nodeShards, shardCount)).toBe(true);
  });

  test('should reject CID outside node shard range', () => {
    const cid = '123abc';
    const shardCount = 1024;
    
    // Node only responsible for shards 0-255
    const nodeShards: ShardRange[] = [{ start: 0, end: 255 }];
    
    const shouldStore = shouldNodeStoreCid(cid, nodeShards, shardCount);
    const actualShardKey = calculateShardKey(cid, shardCount);
    
    // Should only be true if shardKey is 0-255
    if (actualShardKey <= 255) {
      expect(shouldStore).toBe(true);
    } else {
      expect(shouldStore).toBe(false);
    }
  });
});

describe('Shard Range Expansion', () => {
  test('should expand single range', () => {
    const shards: ShardRange[] = [{ start: 0, end: 5 }];
    const expanded = expandShardRanges(shards);
    
    expect(expanded).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('should expand multiple ranges', () => {
    const shards: ShardRange[] = [
      { start: 0, end: 2 },
      { start: 5, end: 7 }
    ];
    const expanded = expandShardRanges(shards);
    
    expect(expanded).toEqual([0, 1, 2, 5, 6, 7]);
  });

  test('should return explicit list as-is', () => {
    const shards = [10, 20, 30];
    const expanded = expandShardRanges(shards);
    
    expect(expanded).toEqual([10, 20, 30]);
  });

  test('should respect max shards limit', () => {
    const shards: ShardRange[] = [{ start: 0, end: 10000 }];
    const expanded = expandShardRanges(shards, 100);
    
    expect(expanded.length).toBeLessThanOrEqual(100);
  });
});

describe('Shard Configuration Parsing', () => {
  test('should parse single range', () => {
    const config = '0-255';
    const parsed = parseShardConfig(config);
    
    expect(parsed).toEqual([{ start: 0, end: 255 }]);
  });

  test('should parse explicit list', () => {
    const config = '0,1,2,3,4,5';
    const parsed = parseShardConfig(config);
    
    expect(parsed).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('should parse multiple ranges', () => {
    const config = '0-255,512-767';
    const parsed = parseShardConfig(config);
    
    expect(parsed).toEqual([
      { start: 0, end: 255 },
      { start: 512, end: 767 }
    ]);
  });
});

describe('Shard Distribution Statistics', () => {
  test('should calculate shard distribution', () => {
    const nodes: NodeShardInfo[] = [
      { nodeId: 'node-1', shards: [{ start: 0, end: 255 }], shardCount: 1024 },
      { nodeId: 'node-2', shards: [{ start: 256, end: 511 }], shardCount: 1024 },
      { nodeId: 'node-3', shards: [{ start: 512, end: 767 }], shardCount: 1024 },
      { nodeId: 'node-4', shards: [{ start: 768, end: 1023 }], shardCount: 1024 }
    ];
    
    const stats = calculateShardDistribution(nodes, 1024);
    
    expect(stats.totalShards).toBe(1024);
    expect(stats.coveredShards).toBe(1024);
    expect(stats.uncoveredShards).toBe(0);
    expect(stats.avgNodesPerShard).toBe(1);
  });

  test('should detect uncovered shards', () => {
    const nodes: NodeShardInfo[] = [
      { nodeId: 'node-1', shards: [{ start: 0, end: 255 }], shardCount: 1024 }
    ];
    
    const stats = calculateShardDistribution(nodes, 1024);
    
    expect(stats.coveredShards).toBe(256);
    expect(stats.uncoveredShards).toBe(768);
  });

  test('should calculate overlapping shard coverage', () => {
    const nodes: NodeShardInfo[] = [
      { nodeId: 'node-1', shards: [{ start: 0, end: 511 }], shardCount: 1024 },
      { nodeId: 'node-2', shards: [{ start: 256, end: 767 }], shardCount: 1024 },
      { nodeId: 'node-3', shards: [{ start: 512, end: 1023 }], shardCount: 1024 }
    ];
    
    const stats = calculateShardDistribution(nodes, 1024);
    
    expect(stats.totalShards).toBe(1024);
    expect(stats.coveredShards).toBe(1024);
    expect(stats.avgNodesPerShard).toBeGreaterThan(1);
  });
});
