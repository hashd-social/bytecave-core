/**
 * HASHD Vault - Deterministic Node Selection
 * 
 * Implements Requirement 6.2: Deterministic node selection for replication
 * 
 * Key principle: Every client in the world will independently choose
 * the same set of nodes for the same CID.
 */

import crypto from 'crypto';
import { ReplicationTarget, NodeSelectionResult } from '../types/index.js';
import { calculateShardKey, isNodeResponsibleForShard } from './sharding.js';

const MIN_REPUTATION_SCORE = 200; // R5.2 - Reject nodes below this score

/**
 * Deterministically select nodes for replication (R6.2)
 * 
 * Uses hash-based selection to ensure all clients choose the same nodes
 * for a given CID, while respecting reputation scores.
 * 
 * @param cid Content identifier
 * @param availableNodes All active nodes in the network
 * @param replicationFactor Number of nodes to select
 * @param excludeNodes Node IDs to exclude (e.g., failed nodes)
 * @returns Selected nodes and exclusion reasons
 */
export function selectNodesForReplication(
  cid: string,
  availableNodes: ReplicationTarget[],
  replicationFactor: number,
  excludeNodes: string[] = []
): NodeSelectionResult {
  const excluded: Array<{ nodeId: string; reason: string }> = [];
  
  // Filter out excluded and low-reputation nodes
  const eligibleNodes = availableNodes.filter(node => {
    // Exclude explicitly excluded nodes
    if (excludeNodes.includes(node.nodeId)) {
      excluded.push({ nodeId: node.nodeId, reason: 'Previously failed' });
      return false;
    }

    // Exclude low-reputation nodes (R5.2)
    if (node.score !== undefined && node.score < MIN_REPUTATION_SCORE) {
      excluded.push({ nodeId: node.nodeId, reason: `Low reputation: ${node.score}` });
      return false;
    }

    return true;
  });

  // If not enough eligible nodes, we'll have to use what we have
  if (eligibleNodes.length < replicationFactor) {
    console.warn(`Only ${eligibleNodes.length} eligible nodes for replication factor ${replicationFactor}`);
  }

  // Deterministic selection using CID-based hashing
  const selected = deterministicSelect(cid, eligibleNodes, replicationFactor);

  return {
    selected,
    excluded
  };
}

/**
 * Deterministically select N nodes from a list using CID-based hashing
 * 
 * Algorithm:
 * 1. For each node, compute: hash(cid + nodeId)
 * 2. Sort nodes by this hash value
 * 3. Take the first N nodes
 * 
 * This ensures:
 * - Same CID always selects same nodes (deterministic)
 * - Different CIDs distribute across different nodes (load balancing)
 * - All clients independently arrive at same selection
 */
function deterministicSelect(
  cid: string,
  nodes: ReplicationTarget[],
  count: number
): ReplicationTarget[] {
  // Compute selection hash for each node
  const nodesWithHash = nodes.map(node => ({
    node,
    hash: computeSelectionHash(cid, node.nodeId)
  }));

  // Sort by hash (deterministic ordering)
  nodesWithHash.sort((a, b) => {
    if (a.hash < b.hash) return -1;
    if (a.hash > b.hash) return 1;
    return 0;
  });

  // Take first N nodes
  return nodesWithHash
    .slice(0, Math.min(count, nodes.length))
    .map(item => item.node);
}

/**
 * Compute selection hash for a node
 * hash(cid + nodeId) ensures deterministic but distributed selection
 */
function computeSelectionHash(cid: string, nodeId: string): string {
  const data = `${cid}:${nodeId}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Select replacement nodes when some nodes fail (R6.4)
 * 
 * @param cid Content identifier
 * @param availableNodes All active nodes
 * @param replicationFactor Target replication factor
 * @param currentNodes Currently selected nodes
 * @param failedNodes Nodes that have failed
 * @returns Additional nodes to try
 */
export function selectReplacementNodes(
  cid: string,
  availableNodes: ReplicationTarget[],
  replicationFactor: number,
  currentNodes: string[],
  failedNodes: string[]
): ReplicationTarget[] {
  const excludeNodes = [...currentNodes, ...failedNodes];
  const needed = replicationFactor - (currentNodes.length - failedNodes.length);

  if (needed <= 0) {
    return [];
  }

  const result = selectNodesForReplication(
    cid,
    availableNodes,
    needed,
    excludeNodes
  );

  return result.selected;
}

/**
 * Check if replication factor is satisfied (R6.7)
 * 
 * @param confirmedNodes Number of confirmed replicas
 * @param replicationFactor Target replication factor
 * @returns true if replication is complete
 */
export function isReplicationComplete(
  confirmedNodes: number,
  replicationFactor: number
): boolean {
  return confirmedNodes >= replicationFactor;
}

/**
 * Rank nodes by reputation score (R5.2)
 * Higher scores are preferred
 */
export function rankNodesByReputation(
  nodes: ReplicationTarget[]
): ReplicationTarget[] {
  return [...nodes].sort((a, b) => {
    const scoreA = a.score ?? 500; // Default neutral score
    const scoreB = b.score ?? 500;
    return scoreB - scoreA; // Descending order
  });
}

/**
 * Filter nodes by minimum reputation (R5.2)
 */
export function filterByMinReputation(
  nodes: ReplicationTarget[],
  minScore: number = MIN_REPUTATION_SCORE
): ReplicationTarget[] {
  return nodes.filter(node => {
    const score = node.score ?? 500;
    return score >= minScore;
  });
}

/**
 * Select nodes for replication with shard awareness (R7.3, R7.4)
 * 
 * This filters nodes to only those responsible for the CID's shard,
 * then applies deterministic selection within that shard group.
 * 
 * @param cid Content identifier
 * @param availableNodes All nodes with shard info
 * @param replicationFactor Number of replicas needed
 * @param shardCount Total shard count
 * @param excludeNodes Nodes to exclude
 * @returns Selected nodes from the shard group
 */
export function selectNodesForReplicationWithShards(
  cid: string,
  availableNodes: Array<ReplicationTarget & { shards?: number[] | { start: number; end: number }[] }>,
  replicationFactor: number,
  shardCount: number,
  excludeNodes: string[] = []
): NodeSelectionResult {
  const excluded: Array<{ nodeId: string; reason: string }> = [];

  // Calculate which shard this CID belongs to (R7.1)
  const shardKey = calculateShardKey(cid, shardCount);

  // Filter to only nodes responsible for this shard (R7.3)
  const shardNodes = availableNodes.filter(node => {
    // Exclude explicitly excluded nodes
    if (excludeNodes.includes(node.nodeId)) {
      excluded.push({ nodeId: node.nodeId, reason: 'Previously failed' });
      return false;
    }

    // Check shard responsibility
    if (node.shards) {
      const isResponsible = isNodeResponsibleForShard(shardKey, node.shards);
      if (!isResponsible) {
        excluded.push({ nodeId: node.nodeId, reason: `Not responsible for shard ${shardKey}` });
        return false;
      }
    }

    // Check reputation (R5.2)
    if (node.score !== undefined && node.score < MIN_REPUTATION_SCORE) {
      excluded.push({ nodeId: node.nodeId, reason: `Low reputation: ${node.score}` });
      return false;
    }

    return true;
  });

  // Handle insufficient shard coverage (R7.4)
  if (shardNodes.length < replicationFactor) {
    console.warn(
      `Insufficient shard nodes for CID ${cid} (shard ${shardKey}): ` +
      `${shardNodes.length} available, ${replicationFactor} needed`
    );
  }

  // Apply deterministic selection within shard group
  const selected = deterministicSelect(cid, shardNodes, replicationFactor);

  return {
    selected,
    excluded
  };
}
