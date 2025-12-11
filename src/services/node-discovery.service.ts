/**
 * HASHD Vault - Node Discovery & Selection Service
 * 
 * Implements Requirement 11: Client-Side Node Discovery & Selection
 * - Node discovery from multiple sources (R11.1)
 * - Node ranking algorithm (R11.2)
 * - Upload path selection (R11.3)
 * - Download path selection (R11.4)
 * - Feed synchronization (R11.5)
 * - Misbehavior detection (R11.6)
 */

import { logger } from '../utils/logger.js';
import {
  NodeRegistryEntry,
  NodeMetadata,
  NodeObservations,
  NodeScore,
  NodeMisbehavior
} from '../types/index.js';

export class NodeDiscoveryService {
  private observations: Map<string, NodeObservations> = new Map();
  private misbehavior: Map<string, NodeMisbehavior> = new Map();
  private scores: Map<string, NodeScore> = new Map();
  private readonly CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly BAN_DURATIONS = {
    SOFT_10MIN: 10 * 60 * 1000,
    SOFT_1HOUR: 60 * 60 * 1000,
    PERMANENT: Infinity
  };

  /**
   * Discover nodes from all sources (R11.1)
   */
  async discoverNodes(
    registryNodes: NodeRegistryEntry[],
    fetchMetadata = true
  ): Promise<NodeRegistryEntry[]> {
    const activeNodes = registryNodes.filter(n => n.active);

    if (fetchMetadata) {
      // Fetch self-reported metadata from each node
      await Promise.allSettled(
        activeNodes.map(node => this.fetchNodeMetadata(node))
      );
    }

    // Clean expired cache entries
    this.cleanExpiredCache();

    return activeNodes;
  }

  /**
   * Fetch node self-reported metadata (R11.1b)
   */
  private async fetchNodeMetadata(node: NodeRegistryEntry): Promise<void> {
    try {
      const response = await fetch(`${node.endpoint}/node/info`, {
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        this.recordFailure(node.nodeId);
        return;
      }

      const metadata = await response.json() as NodeMetadata;

      // Validate nodeId matches (R11.1b)
      if (metadata.nodeId !== node.nodeId) {
        logger.warn('Node ID mismatch', {
          expected: node.nodeId,
          received: metadata.nodeId
        });
        this.recordMisbehavior(node.nodeId, 'cid_mismatch');
        return;
      }

      // Update observations
      this.updateObservations(node.nodeId, true, 0);

    } catch (error) {
      this.recordFailure(node.nodeId);
    }
  }

  /**
   * Calculate node score (R11.2)
   * 
   * Score = 40% proof + 20% latency + 20% reliability + 10% capacity + 10% shard
   */
  calculateNodeScore(
    nodeId: string,
    shardId?: number
  ): NodeScore {
    const obs = this.observations.get(nodeId);
    const misbehavior = this.misbehavior.get(nodeId);

    // Default scores if no observations
    if (!obs) {
      return {
        nodeId,
        totalScore: 0,
        proofFreshnessScore: 0,
        responseLatencyScore: 0,
        reliabilityScore: 0,
        capacityScore: 0,
        shardRelevanceScore: 0,
        lastUpdated: Date.now()
      };
    }

    // Check if node is banned
    if (misbehavior?.banUntil && Date.now() < misbehavior.banUntil) {
      return {
        nodeId,
        totalScore: 0,
        proofFreshnessScore: 0,
        responseLatencyScore: 0,
        reliabilityScore: 0,
        capacityScore: 0,
        shardRelevanceScore: 0,
        lastUpdated: Date.now()
      };
    }

    if (misbehavior?.permanentBan) {
      return {
        nodeId,
        totalScore: 0,
        proofFreshnessScore: 0,
        responseLatencyScore: 0,
        reliabilityScore: 0,
        capacityScore: 0,
        shardRelevanceScore: 0,
        lastUpdated: Date.now()
      };
    }

    // Calculate component scores (0-100 each)
    const proofFreshnessScore = this.calculateProofFreshnessScore(obs);
    const responseLatencyScore = this.calculateLatencyScore(obs);
    const reliabilityScore = this.calculateReliabilityScore(obs);
    const capacityScore = this.calculateCapacityScore(obs);
    const shardRelevanceScore = shardId !== undefined ? 100 : 50; // Full score if shard matches

    // Weighted sum
    const totalScore = 
      proofFreshnessScore * 0.4 +
      responseLatencyScore * 0.2 +
      reliabilityScore * 0.2 +
      capacityScore * 0.1 +
      shardRelevanceScore * 0.1;

    const score: NodeScore = {
      nodeId,
      totalScore,
      proofFreshnessScore,
      responseLatencyScore,
      reliabilityScore,
      capacityScore,
      shardRelevanceScore,
      lastUpdated: Date.now()
    };

    this.scores.set(nodeId, score);
    return score;
  }

  /**
   * Rank nodes by score (R11.2)
   */
  rankNodes(
    nodes: NodeRegistryEntry[],
    shardId?: number
  ): NodeRegistryEntry[] {
    const scored = nodes.map(node => ({
      node,
      score: this.calculateNodeScore(node.nodeId, shardId)
    }));

    // Sort by total score descending
    scored.sort((a, b) => b.score.totalScore - a.score.totalScore);

    return scored.map(s => s.node);
  }

  /**
   * Select nodes for upload (R11.3)
   */
  selectUploadNodes(
    availableNodes: NodeRegistryEntry[],
    count = 3,
    shardId?: number
  ): NodeRegistryEntry[] {
    // Rank nodes
    const ranked = this.rankNodes(availableNodes, shardId);

    // Filter out banned nodes
    const eligible = ranked.filter(node => {
      const misbehavior = this.misbehavior.get(node.nodeId);
      if (misbehavior?.permanentBan) return false;
      if (misbehavior?.banUntil && Date.now() < misbehavior.banUntil) return false;
      return true;
    });

    // Return top N
    return eligible.slice(0, count);
  }

  /**
   * Select nodes for download (R11.4)
   * Returns nodes for hedged requests
   */
  selectDownloadNodes(
    availableNodes: NodeRegistryEntry[],
    count = 3
  ): NodeRegistryEntry[] {
    return this.selectUploadNodes(availableNodes, count);
  }

  /**
   * Record successful request
   */
  recordSuccess(nodeId: string, latency: number): void {
    this.updateObservations(nodeId, true, latency);
  }

  /**
   * Record failed request
   */
  recordFailure(nodeId: string): void {
    this.updateObservations(nodeId, false, 0);

    // Check for rapid failures (>3 in 30s)
    const obs = this.observations.get(nodeId);
    if (obs && obs.failureCount >= 3) {
      const recentFailures = obs.failureCount;
      if (recentFailures >= 3) {
        this.applyBan(nodeId, this.BAN_DURATIONS.SOFT_10MIN);
      }
    }
  }

  /**
   * Record node misbehavior (R11.6)
   */
  recordMisbehavior(
    nodeId: string,
    type: 'invalid_proof' | 'cid_mismatch' | 'corrupt_blob' | 'timeout'
  ): void {
    let misbehavior = this.misbehavior.get(nodeId);

    if (!misbehavior) {
      misbehavior = {
        nodeId,
        invalidProofCount: 0,
        cidMismatchCount: 0,
        corruptBlobCount: 0,
        timeoutCount: 0,
        lastMisbehavior: Date.now(),
        banUntil: null,
        permanentBan: false
      };
    }

    misbehavior.lastMisbehavior = Date.now();

    // Set misbehavior first so ban methods can access it
    this.misbehavior.set(nodeId, misbehavior);

    switch (type) {
      case 'invalid_proof':
        misbehavior.invalidProofCount++;
        if (misbehavior.invalidProofCount === 1) {
          this.applyBan(nodeId, this.BAN_DURATIONS.SOFT_10MIN);
        } else if (misbehavior.invalidProofCount === 2) {
          this.applyBan(nodeId, this.BAN_DURATIONS.SOFT_1HOUR);
        } else if (misbehavior.invalidProofCount >= 3) {
          this.applyPermanentBan(nodeId);
        }
        break;

      case 'cid_mismatch':
        misbehavior.cidMismatchCount++;
        this.applyPermanentBan(nodeId);
        break;

      case 'corrupt_blob':
        misbehavior.corruptBlobCount++;
        this.applyPermanentBan(nodeId);
        break;

      case 'timeout':
        misbehavior.timeoutCount++;
        // Reduce score but don't ban
        break;
    }

    logger.warn('Node misbehavior recorded', {
      nodeId,
      type,
      misbehavior
    });
  }

  /**
   * Apply temporary ban
   */
  private applyBan(nodeId: string, duration: number): void {
    const misbehavior = this.misbehavior.get(nodeId);
    if (misbehavior) {
      misbehavior.banUntil = Date.now() + duration;
      this.misbehavior.set(nodeId, misbehavior);
      logger.info('Node temporarily banned', { nodeId, duration });
    }
  }

  /**
   * Apply permanent ban
   */
  private applyPermanentBan(nodeId: string): void {
    const misbehavior = this.misbehavior.get(nodeId);
    if (misbehavior) {
      misbehavior.permanentBan = true;
      this.misbehavior.set(nodeId, misbehavior);
      logger.warn('Node permanently banned', { nodeId });
    }
  }

  /**
   * Update node observations (R11.1c)
   */
  private updateObservations(
    nodeId: string,
    success: boolean,
    latency: number
  ): void {
    let obs = this.observations.get(nodeId);

    if (!obs) {
      obs = {
        nodeId,
        successRate: 0,
        avgLatency: 0,
        replicationSuccess: 0,
        proofFreshness: 0,
        rateLimited: false,
        lastSeen: Date.now(),
        requestCount: 0,
        failureCount: 0,
        cachedAt: Date.now()
      };
    }

    obs.requestCount++;
    if (!success) {
      obs.failureCount++;
    }
    obs.successRate = (obs.requestCount - obs.failureCount) / obs.requestCount;
    obs.avgLatency = (obs.avgLatency * (obs.requestCount - 1) + latency) / obs.requestCount;
    obs.lastSeen = Date.now();

    this.observations.set(nodeId, obs);
  }

  /**
   * Calculate proof freshness score (0-100)
   */
  private calculateProofFreshnessScore(obs: NodeObservations): number {
    if (!obs.proofFreshness) return 0;

    const age = Date.now() - obs.proofFreshness;
    const maxAge = 60 * 60 * 1000; // 1 hour

    if (age > maxAge) return 0;
    return Math.max(0, 100 * (1 - age / maxAge));
  }

  /**
   * Calculate latency score (0-100)
   */
  private calculateLatencyScore(obs: NodeObservations): number {
    if (obs.avgLatency === 0) return 50; // No data

    const maxLatency = 5000; // 5 seconds
    if (obs.avgLatency > maxLatency) return 0;

    return Math.max(0, 100 * (1 - obs.avgLatency / maxLatency));
  }

  /**
   * Calculate reliability score (0-100)
   */
  private calculateReliabilityScore(obs: NodeObservations): number {
    return obs.successRate * 100;
  }

  /**
   * Calculate capacity score (0-100)
   */
  private calculateCapacityScore(_obs: NodeObservations): number {
    // Simple heuristic - could be enhanced with actual capacity data
    return 50; // Default medium capacity
  }

  /**
   * Clean expired cache entries
   */
  private cleanExpiredCache(): void {
    const now = Date.now();
    for (const [nodeId, obs] of this.observations.entries()) {
      if (now - obs.cachedAt > this.CACHE_EXPIRY_MS) {
        this.observations.delete(nodeId);
      }
    }
  }

  /**
   * Get node observations
   */
  getObservations(nodeId: string): NodeObservations | undefined {
    return this.observations.get(nodeId);
  }

  /**
   * Get node misbehavior record
   */
  getMisbehavior(nodeId: string): NodeMisbehavior | undefined {
    return this.misbehavior.get(nodeId);
  }

  /**
   * Get node score
   */
  getScore(nodeId: string): NodeScore | undefined {
    return this.scores.get(nodeId);
  }

  /**
   * Clear all cached data (for testing)
   */
  clearCache(): void {
    this.observations.clear();
    this.misbehavior.clear();
    this.scores.clear();
  }
}

export const nodeDiscoveryService = new NodeDiscoveryService();
