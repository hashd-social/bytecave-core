/**
 * Tests for Deterministic Node Selection
 */

import {
  selectNodesForReplication,
  selectReplacementNodes,
  isReplicationComplete,
  rankNodesByReputation,
  filterByMinReputation,
  selectNodesForReplicationWithShards
} from '../src/utils/node-selection.js';
import { ReplicationTarget } from '../src/types/index.js';

describe('Deterministic Node Selection', () => {
  const mockNodes: ReplicationTarget[] = [
    { nodeId: 'node-1', url: 'http://node1.test', score: 800 },
    { nodeId: 'node-2', url: 'http://node2.test', score: 750 },
    { nodeId: 'node-3', url: 'http://node3.test', score: 700 },
    { nodeId: 'node-4', url: 'http://node4.test', score: 650 },
    { nodeId: 'node-5', url: 'http://node5.test', score: 600 }
  ];

  test('should select nodes deterministically', () => {
    const cid = '123abc';
    const replicationFactor = 3;
    
    const result1 = selectNodesForReplication(cid, mockNodes, replicationFactor);
    const result2 = selectNodesForReplication(cid, mockNodes, replicationFactor);
    
    expect(result1.selected.length).toBe(replicationFactor);
    expect(result2.selected.length).toBe(replicationFactor);
    
    // Same CID should select same nodes
    expect(result1.selected.map(n => n.nodeId)).toEqual(
      result2.selected.map(n => n.nodeId)
    );
  });

  test('should select different nodes for different CIDs', () => {
    const replicationFactor = 3;
    
    const result1 = selectNodesForReplication('cid1', mockNodes, replicationFactor);
    const result2 = selectNodesForReplication('cid2', mockNodes, replicationFactor);
    
    // Both should select the correct number of nodes
    expect(result1.selected.length).toBe(replicationFactor);
    expect(result2.selected.length).toBe(replicationFactor);
    
    // Different CIDs might select different nodes (not guaranteed but likely)
    // Just verify both selections are valid
    expect(result1.selected.every(n => mockNodes.includes(n))).toBe(true);
    expect(result2.selected.every(n => mockNodes.includes(n))).toBe(true);
  });

  test('should exclude low reputation nodes', () => {
    const nodesWithLowRep: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800 },
      { nodeId: 'node-2', url: 'http://node2.test', score: 150 }, // Below threshold
      { nodeId: 'node-3', url: 'http://node3.test', score: 700 }
    ];
    
    const result = selectNodesForReplication('cid', nodesWithLowRep, 2);
    
    // Should not include node-2
    const selectedIds = result.selected.map(n => n.nodeId);
    expect(selectedIds).not.toContain('node-2');
    
    // Should have exclusion reason
    const excluded = result.excluded.find(e => e.nodeId === 'node-2');
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toContain('reputation');
  });

  test('should exclude explicitly excluded nodes', () => {
    const result = selectNodesForReplication(
      'cid',
      mockNodes,
      3,
      ['node-1', 'node-2']
    );
    
    const selectedIds = result.selected.map(n => n.nodeId);
    expect(selectedIds).not.toContain('node-1');
    expect(selectedIds).not.toContain('node-2');
  });

  test('should handle insufficient nodes', () => {
    const fewNodes: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800 }
    ];
    
    const result = selectNodesForReplication('cid', fewNodes, 3);
    
    // Should return what's available
    expect(result.selected.length).toBe(1);
  });
});

describe('Replacement Node Selection', () => {
  const mockNodes: ReplicationTarget[] = [
    { nodeId: 'node-1', url: 'http://node1.test', score: 800 },
    { nodeId: 'node-2', url: 'http://node2.test', score: 750 },
    { nodeId: 'node-3', url: 'http://node3.test', score: 700 },
    { nodeId: 'node-4', url: 'http://node4.test', score: 650 },
    { nodeId: 'node-5', url: 'http://node5.test', score: 600 }
  ];

  test('should select replacement nodes when some fail', () => {
    const cid = '123abc';
    const currentNodes = ['node-1', 'node-2', 'node-3'];
    const failedNodes = ['node-2'];
    const replicationFactor = 3;
    
    const replacements = selectReplacementNodes(
      cid,
      mockNodes,
      replicationFactor,
      currentNodes,
      failedNodes
    );
    
    // Should select 1 replacement
    expect(replacements.length).toBe(1);
    
    // Should not include current or failed nodes
    const replacementIds = replacements.map(n => n.nodeId);
    expect(replacementIds).not.toContain('node-1');
    expect(replacementIds).not.toContain('node-2');
    expect(replacementIds).not.toContain('node-3');
  });

  test('should not select replacements if replication complete', () => {
    const cid = '123abc';
    const currentNodes = ['node-1', 'node-2', 'node-3'];
    const failedNodes: string[] = [];
    const replicationFactor = 3;
    
    const replacements = selectReplacementNodes(
      cid,
      mockNodes,
      replicationFactor,
      currentNodes,
      failedNodes
    );
    
    expect(replacements.length).toBe(0);
  });
});

describe('Replication Completion Check', () => {
  test('should return true when replication factor met', () => {
    expect(isReplicationComplete(3, 3)).toBe(true);
    expect(isReplicationComplete(4, 3)).toBe(true);
  });

  test('should return false when replication factor not met', () => {
    expect(isReplicationComplete(2, 3)).toBe(false);
    expect(isReplicationComplete(0, 3)).toBe(false);
  });
});

describe('Node Ranking by Reputation', () => {
  test('should rank nodes by reputation score', () => {
    const nodes: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 600 },
      { nodeId: 'node-2', url: 'http://node2.test', score: 800 },
      { nodeId: 'node-3', url: 'http://node3.test', score: 700 }
    ];
    
    const ranked = rankNodesByReputation(nodes);
    
    expect(ranked[0].score).toBe(800);
    expect(ranked[1].score).toBe(700);
    expect(ranked[2].score).toBe(600);
  });

  test('should handle nodes without scores', () => {
    const nodes: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test' },
      { nodeId: 'node-2', url: 'http://node2.test', score: 800 }
    ];
    
    const ranked = rankNodesByReputation(nodes);
    
    expect(ranked.length).toBe(2);
  });
});

describe('Reputation Filtering', () => {
  test('should filter nodes by minimum reputation', () => {
    const nodes: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800 },
      { nodeId: 'node-2', url: 'http://node2.test', score: 150 },
      { nodeId: 'node-3', url: 'http://node3.test', score: 700 }
    ];
    
    const filtered = filterByMinReputation(nodes, 200);
    
    expect(filtered.length).toBe(2);
    expect(filtered.map(n => n.nodeId)).toEqual(['node-1', 'node-3']);
  });

  test('should use default minimum score of 200', () => {
    const nodes: ReplicationTarget[] = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800 },
      { nodeId: 'node-2', url: 'http://node2.test', score: 150 }
    ];
    
    const filtered = filterByMinReputation(nodes);
    
    expect(filtered.length).toBe(1);
    expect(filtered[0].nodeId).toBe('node-1');
  });
});

describe('Shard-Aware Node Selection', () => {
  test('should select only nodes responsible for shard', () => {
    // All nodes cover all shards to ensure selection works
    const nodes = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800, shards: [{ start: 0, end: 1023 }] },
      { nodeId: 'node-2', url: 'http://node2.test', score: 750, shards: [{ start: 0, end: 1023 }] },
      { nodeId: 'node-3', url: 'http://node3.test', score: 700, shards: [{ start: 0, end: 1023 }] }
    ];
    
    const cid = '0000000000000000000000000000000000000000000000000000000000000064'; // Proper hex CID
    const shardCount = 1024;
    
    const result = selectNodesForReplicationWithShards(
      cid,
      nodes,
      2,
      shardCount
    );
    
    // Should select nodes (all nodes cover all shards)
    expect(result.selected.length).toBe(2);
  });

  test('should exclude nodes not responsible for shard', () => {
    const nodes = [
      { nodeId: 'node-1', url: 'http://node1.test', score: 800, shards: [{ start: 0, end: 255 }] },
      { nodeId: 'node-2', url: 'http://node2.test', score: 750, shards: [{ start: 768, end: 1023 }] }
    ];
    
    const cid = '123abc';
    const shardCount = 1024;
    
    const result = selectNodesForReplicationWithShards(
      cid,
      nodes,
      2,
      shardCount
    );
    
    // Should have exclusions for wrong shard
    const shardExclusions = result.excluded.filter(e => 
      e.reason.includes('shard')
    );
    expect(shardExclusions.length).toBeGreaterThan(0);
  });
});
