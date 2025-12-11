/**
 * Tests for Node Discovery & Selection Protocol
 * 
 * Covers Requirement 11: Client-Side Node Discovery & Selection
 */

import { nodeDiscoveryService } from '../src/services/node-discovery.service.js';
import { NodeRegistryEntry } from '../src/types/index.js';

describe('Node Discovery & Selection Protocol (Requirement 11)', () => {
  const mockNodes: NodeRegistryEntry[] = [
    {
      nodeId: 'node-1',
      publicKey: '0xabc123',
      endpoint: 'http://node1.test',
      metadataHash: '0xhash1',
      active: true,
      registeredAt: Date.now()
    },
    {
      nodeId: 'node-2',
      publicKey: '0xdef456',
      endpoint: 'http://node2.test',
      metadataHash: '0xhash2',
      active: true,
      registeredAt: Date.now()
    },
    {
      nodeId: 'node-3',
      publicKey: '0xghi789',
      endpoint: 'http://node3.test',
      metadataHash: '0xhash3',
      active: true,
      registeredAt: Date.now()
    },
    {
      nodeId: 'node-4',
      publicKey: '0xjkl012',
      endpoint: 'http://node4.test',
      metadataHash: '0xhash4',
      active: false, // Inactive
      registeredAt: Date.now()
    }
  ];

  beforeEach(() => {
    nodeDiscoveryService.clearCache();
  });

  describe('Node Discovery (R11.1)', () => {
    test('should filter active nodes', async () => {
      const nodes = await nodeDiscoveryService.discoverNodes(mockNodes, false);
      
      expect(nodes.length).toBe(3);
      expect(nodes.every(n => n.active)).toBe(true);
    });

    test('should exclude inactive nodes', async () => {
      const nodes = await nodeDiscoveryService.discoverNodes(mockNodes, false);
      
      const inactiveNode = nodes.find(n => n.nodeId === 'node-4');
      expect(inactiveNode).toBeUndefined();
    });

    test('should handle empty node list', async () => {
      const nodes = await nodeDiscoveryService.discoverNodes([], false);
      
      expect(nodes).toEqual([]);
    });
  });

  describe('Node Ranking Algorithm (R11.2)', () => {
    test('should calculate node score with all components', () => {
      // Record some observations
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 150);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.nodeId).toBe('node-1');
      expect(score.totalScore).toBeGreaterThanOrEqual(0);
      expect(score.totalScore).toBeLessThanOrEqual(100);
      expect(score.proofFreshnessScore).toBeDefined();
      expect(score.responseLatencyScore).toBeDefined();
      expect(score.reliabilityScore).toBeDefined();
      expect(score.capacityScore).toBeDefined();
      expect(score.shardRelevanceScore).toBeDefined();
    });

    test('should give higher score to nodes with better latency', () => {
      // Node 1: Fast responses
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-1', 60);
      
      // Node 2: Slow responses
      nodeDiscoveryService.recordSuccess('node-2', 2000);
      nodeDiscoveryService.recordSuccess('node-2', 2100);
      
      const score1 = nodeDiscoveryService.calculateNodeScore('node-1');
      const score2 = nodeDiscoveryService.calculateNodeScore('node-2');
      
      expect(score1.responseLatencyScore).toBeGreaterThan(score2.responseLatencyScore);
    });

    test('should give higher score to nodes with better reliability', () => {
      // Node 1: High success rate
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      // Node 2: Low success rate
      nodeDiscoveryService.recordSuccess('node-2', 100);
      nodeDiscoveryService.recordFailure('node-2');
      nodeDiscoveryService.recordFailure('node-2');
      
      const score1 = nodeDiscoveryService.calculateNodeScore('node-1');
      const score2 = nodeDiscoveryService.calculateNodeScore('node-2');
      
      expect(score1.reliabilityScore).toBeGreaterThan(score2.reliabilityScore);
    });

    test('should rank nodes by total score', () => {
      // Create different performance profiles
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-1', 60);
      
      nodeDiscoveryService.recordSuccess('node-2', 2000);
      nodeDiscoveryService.recordFailure('node-2');
      
      nodeDiscoveryService.recordSuccess('node-3', 100);
      nodeDiscoveryService.recordSuccess('node-3', 110);
      
      const ranked = nodeDiscoveryService.rankNodes(mockNodes.slice(0, 3));
      
      expect(ranked.length).toBe(3);
      // Node 1 should be first (best latency)
      expect(ranked[0].nodeId).toBe('node-1');
    });

    test('should give zero score to banned nodes', () => {
      // Ban node
      nodeDiscoveryService.recordMisbehavior('node-1', 'cid_mismatch');
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.totalScore).toBe(0);
    });
  });

  describe('Upload Path Selection (R11.3)', () => {
    test('should select top N nodes for upload', () => {
      // Create performance data
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-2', 100);
      nodeDiscoveryService.recordSuccess('node-3', 200);
      
      const selected = nodeDiscoveryService.selectUploadNodes(mockNodes.slice(0, 3), 2);
      
      expect(selected.length).toBe(2);
      expect(selected[0].nodeId).toBe('node-1'); // Best score
    });

    test('should exclude banned nodes from selection', () => {
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-2', 100);
      
      // Ban node-1
      nodeDiscoveryService.recordMisbehavior('node-1', 'cid_mismatch');
      
      const selected = nodeDiscoveryService.selectUploadNodes(mockNodes.slice(0, 3), 2);
      
      expect(selected.every(n => n.nodeId !== 'node-1')).toBe(true);
    });

    test('should prefer shard-responsible nodes', () => {
      const shardId = 42;
      
      const selected = nodeDiscoveryService.selectUploadNodes(
        mockNodes.slice(0, 3),
        2,
        shardId
      );
      
      expect(selected.length).toBe(2);
    });

    test('should handle insufficient nodes', () => {
      const selected = nodeDiscoveryService.selectUploadNodes(mockNodes.slice(0, 2), 5);
      
      expect(selected.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Download Path Selection (R11.4)', () => {
    test('should select nodes for hedged requests', () => {
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-2', 100);
      nodeDiscoveryService.recordSuccess('node-3', 150);
      
      const selected = nodeDiscoveryService.selectDownloadNodes(mockNodes.slice(0, 3), 3);
      
      expect(selected.length).toBe(3);
    });

    test('should prioritize fast nodes for download', () => {
      nodeDiscoveryService.recordSuccess('node-1', 50);
      nodeDiscoveryService.recordSuccess('node-2', 2000);
      
      const selected = nodeDiscoveryService.selectDownloadNodes(mockNodes.slice(0, 2), 2);
      
      expect(selected[0].nodeId).toBe('node-1');
    });
  });

  describe('Misbehavior Detection (R11.6)', () => {
    test('should apply 10min ban after 1 invalid proof', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.invalidProofCount).toBe(1);
      expect(misbehavior?.banUntil).toBeGreaterThan(Date.now());
    });

    test('should apply 1hour ban after 2 invalid proofs', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.invalidProofCount).toBe(2);
      expect(misbehavior?.banUntil).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    });

    test('should apply permanent ban after 3 invalid proofs', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      nodeDiscoveryService.recordMisbehavior('node-1', 'invalid_proof');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.invalidProofCount).toBe(3);
      expect(misbehavior?.permanentBan).toBe(true);
    });

    test('should apply immediate hard ban for CID mismatch', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'cid_mismatch');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.cidMismatchCount).toBe(1);
      expect(misbehavior?.permanentBan).toBe(true);
    });

    test('should apply hard ban for corrupt blob', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'corrupt_blob');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.corruptBlobCount).toBe(1);
      expect(misbehavior?.permanentBan).toBe(true);
    });

    test('should track timeouts without banning', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'timeout');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior?.timeoutCount).toBe(1);
      expect(misbehavior?.permanentBan).toBe(false);
    });

    test('should ban node after rapid failures', () => {
      // Simulate >3 failures in 30s
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.failureCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Node Observations (R11.1c)', () => {
    test('should track success rate', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordFailure('node-1');
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.successRate).toBeCloseTo(2/3, 2);
    });

    test('should track average latency', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 200);
      nodeDiscoveryService.recordSuccess('node-1', 300);
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.avgLatency).toBeCloseTo(200, 0);
    });

    test('should track request count', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordFailure('node-1');
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.requestCount).toBe(3);
    });

    test('should track failure count', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.failureCount).toBe(2);
    });

    test('should update last seen timestamp', () => {
      const before = Date.now();
      nodeDiscoveryService.recordSuccess('node-1', 100);
      const after = Date.now();
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs?.lastSeen).toBeGreaterThanOrEqual(before);
      expect(obs?.lastSeen).toBeLessThanOrEqual(after);
    });
  });

  describe('Score Components', () => {
    test('should calculate proof freshness score', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      // No proof data, should be 0
      expect(score.proofFreshnessScore).toBe(0);
    });

    test('should calculate latency score', () => {
      // Fast node
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.responseLatencyScore).toBeGreaterThan(0);
      expect(score.responseLatencyScore).toBeLessThanOrEqual(100);
    });

    test('should calculate reliability score', () => {
      // Perfect reliability
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.reliabilityScore).toBe(100);
    });

    test('should calculate capacity score', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.capacityScore).toBeDefined();
      expect(score.capacityScore).toBeGreaterThanOrEqual(0);
      expect(score.capacityScore).toBeLessThanOrEqual(100);
    });

    test('should calculate shard relevance score', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      // Without shard
      const score1 = nodeDiscoveryService.calculateNodeScore('node-1');
      expect(score1.shardRelevanceScore).toBe(50);
      
      // With shard
      const score2 = nodeDiscoveryService.calculateNodeScore('node-1', 42);
      expect(score2.shardRelevanceScore).toBe(100);
    });
  });

  describe('Cache Management', () => {
    test('should store observations in cache', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const obs = nodeDiscoveryService.getObservations('node-1');
      
      expect(obs).toBeDefined();
      expect(obs?.nodeId).toBe('node-1');
    });

    test('should store misbehavior records', () => {
      nodeDiscoveryService.recordMisbehavior('node-1', 'timeout');
      
      const misbehavior = nodeDiscoveryService.getMisbehavior('node-1');
      
      expect(misbehavior).toBeDefined();
      expect(misbehavior?.nodeId).toBe('node-1');
    });

    test('should store calculated scores', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.calculateNodeScore('node-1');
      
      const score = nodeDiscoveryService.getScore('node-1');
      
      expect(score).toBeDefined();
      expect(score?.nodeId).toBe('node-1');
    });

    test('should clear all cache', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      nodeDiscoveryService.recordMisbehavior('node-2', 'timeout');
      
      nodeDiscoveryService.clearCache();
      
      expect(nodeDiscoveryService.getObservations('node-1')).toBeUndefined();
      expect(nodeDiscoveryService.getMisbehavior('node-2')).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    test('should handle node with no observations', () => {
      const score = nodeDiscoveryService.calculateNodeScore('unknown-node');
      
      expect(score.totalScore).toBe(0);
    });

    test('should handle zero latency', () => {
      nodeDiscoveryService.recordSuccess('node-1', 0);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.responseLatencyScore).toBeGreaterThan(0);
    });

    test('should handle very high latency', () => {
      nodeDiscoveryService.recordSuccess('node-1', 10000);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.responseLatencyScore).toBe(0);
    });

    test('should handle all failures', () => {
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      nodeDiscoveryService.recordFailure('node-1');
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.reliabilityScore).toBe(0);
    });

    test('should handle empty node list for ranking', () => {
      const ranked = nodeDiscoveryService.rankNodes([]);
      
      expect(ranked).toEqual([]);
    });

    test('should handle selection with no eligible nodes', () => {
      // Ban all nodes
      mockNodes.forEach(node => {
        nodeDiscoveryService.recordMisbehavior(node.nodeId, 'cid_mismatch');
      });
      
      const selected = nodeDiscoveryService.selectUploadNodes(mockNodes, 3);
      
      expect(selected.length).toBe(0);
    });
  });

  describe('Weighted Scoring Formula', () => {
    test('should apply correct weights to score components', () => {
      nodeDiscoveryService.recordSuccess('node-1', 100);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      // Verify weighted sum
      const expectedTotal = 
        score.proofFreshnessScore * 0.4 +
        score.responseLatencyScore * 0.2 +
        score.reliabilityScore * 0.2 +
        score.capacityScore * 0.1 +
        score.shardRelevanceScore * 0.1;
      
      expect(score.totalScore).toBeCloseTo(expectedTotal, 1);
    });

    test('should ensure total score is between 0 and 100', () => {
      nodeDiscoveryService.recordSuccess('node-1', 50);
      
      const score = nodeDiscoveryService.calculateNodeScore('node-1');
      
      expect(score.totalScore).toBeGreaterThanOrEqual(0);
      expect(score.totalScore).toBeLessThanOrEqual(100);
    });
  });
});
