/**
 * HASHD Vault - Consensus Service
 * 
 * Implements Requirement 14: Lightweight Consensus & Anti-Censorship
 * - Multi-replica availability (R14.2)
 * - Replica voting (R14.3)
 * - Anti-censorship fetch (R14.4)
 * - Dispute detection (R14.6)
 * - Audit trail (R14.10)
 * - Reputation integration (R14.12)
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import {
  ReplicaFetchResult,
  ConsensusResult,
  DisputeRecord,
  CensorshipEvent,
  AuditLogEntry,
  BlobPermanence
} from '../types/index.js';

export class ConsensusService {
  private disputes: Map<string, DisputeRecord> = new Map();
  private censorshipEvents: CensorshipEvent[] = [];
  private auditLog: AuditLogEntry[] = [];
  private readonly QUORUM_THRESHOLD = 0.5; // N/2 + 1

  /**
   * Fetch blob with multi-replica consensus (R14.2, R14.3)
   * 
   * Client-driven consensus via replica voting
   */
  async fetchWithConsensus(
    cid: string,
    replicaNodes: string[],
    fetchFunction: (nodeId: string, cid: string) => Promise<Buffer | null>
  ): Promise<ConsensusResult> {
    const results: ReplicaFetchResult[] = [];

    // Fetch from multiple nodes in parallel (R14.3)
    const fetchPromises = replicaNodes.map(async (nodeId) => {
      const startTime = Date.now();
      try {
        const ciphertext = await fetchFunction(nodeId, cid);
        const latency = Date.now() - startTime;

        if (!ciphertext) {
          // Node returned nothing - potential censorship
          this.recordCensorshipEvent({
            cid,
            nodeId,
            timestamp: Date.now(),
            type: 'refusal',
            context: 'Node returned null for existing CID'
          });

          return {
            nodeId,
            cid,
            ciphertext: null,
            hash: null,
            latency,
            success: false,
            error: 'No data returned'
          };
        }

        // Compute hash locally (R14.3)
        const hash = crypto.createHash('sha256').update(ciphertext).digest('hex');

        return {
          nodeId,
          cid,
          ciphertext,
          hash,
          latency,
          success: true
        };
      } catch (error: any) {
        const latency = Date.now() - startTime;

        // Record timeout/failure
        this.recordCensorshipEvent({
          cid,
          nodeId,
          timestamp: Date.now(),
          type: 'timeout',
          context: error.message
        });

        return {
          nodeId,
          cid,
          ciphertext: null,
          hash: null,
          latency,
          success: false,
          error: error.message
        };
      }
    });

    // Wait for all fetches
    const fetchResults = await Promise.all(fetchPromises);
    results.push(...fetchResults);

    // Perform consensus (R14.3)
    return this.performConsensus(cid, results);
  }

  /**
   * Perform replica voting consensus (R14.3)
   */
  private performConsensus(
    cid: string,
    results: ReplicaFetchResult[]
  ): ConsensusResult {
    const successfulResults = results.filter(r => r.success && r.hash);

    if (successfulResults.length === 0) {
      // No successful fetches
      this.logAudit({
        timestamp: Date.now(),
        type: 'consensus_failure',
        cid,
        details: {
          reason: 'No successful fetches',
          totalAttempts: results.length
        }
      });

      return {
        cid,
        consensus: false,
        matchingReplicas: 0,
        totalReplicas: results.length,
        acceptedHash: null,
        ciphertext: null,
        disputedNodes: [],
        censoringNodes: results.filter(r => !r.success).map(r => r.nodeId)
      };
    }

    // Count hash occurrences
    const hashCounts = new Map<string, { count: number; nodes: string[]; ciphertext: Buffer }>();
    for (const result of successfulResults) {
      if (!result.hash || !result.ciphertext) continue;

      if (!hashCounts.has(result.hash)) {
        hashCounts.set(result.hash, {
          count: 0,
          nodes: [],
          ciphertext: result.ciphertext
        });
      }

      const entry = hashCounts.get(result.hash)!;
      entry.count++;
      entry.nodes.push(result.nodeId);
    }

    // Find majority hash
    let maxCount = 0;
    let acceptedHash: string | null = null;
    let acceptedCiphertext: Buffer | null = null;

    for (const [hash, data] of hashCounts.entries()) {
      if (data.count > maxCount) {
        maxCount = data.count;
        acceptedHash = hash;
        acceptedCiphertext = data.ciphertext;
      }
    }

    // Check if we have consensus (at least 2 matching or >50% quorum)
    const hasConsensus = maxCount >= 2 || maxCount > results.length * this.QUORUM_THRESHOLD;

    // Identify disputed nodes (R14.6)
    const disputedNodes: string[] = [];
    if (hashCounts.size > 1) {
      // Multiple different hashes - dispute!
      for (const result of successfulResults) {
        if (result.hash !== acceptedHash) {
          disputedNodes.push(result.nodeId);
        }
      }

      // Record dispute
      this.recordDispute(cid, hashCounts);
    }

    // Identify censoring nodes (R14.4)
    const censoringNodes = results
      .filter(r => !r.success)
      .map(r => r.nodeId);

    return {
      cid,
      consensus: hasConsensus,
      matchingReplicas: maxCount,
      totalReplicas: results.length,
      acceptedHash,
      ciphertext: acceptedCiphertext,
      disputedNodes,
      censoringNodes
    };
  }

  /**
   * Record dispute (R14.6)
   */
  private recordDispute(
    cid: string,
    hashCounts: Map<string, { count: number; nodes: string[] }>
  ): void {
    const conflictingHashes = new Map<string, string[]>();

    for (const [hash, data] of hashCounts.entries()) {
      conflictingHashes.set(hash, data.nodes);
    }

    const dispute: DisputeRecord = {
      cid,
      timestamp: Date.now(),
      conflictingHashes,
      resolution: 'pending'
    };

    this.disputes.set(cid, dispute);

    this.logAudit({
      timestamp: Date.now(),
      type: 'dispute',
      cid,
      details: {
        hashCount: hashCounts.size,
        nodes: Array.from(conflictingHashes.values()).flat()
      }
    });

    logger.warn('Dispute detected', { cid, hashCount: hashCounts.size });
  }

  /**
   * Record censorship event (R14.4, R14.10)
   */
  private recordCensorshipEvent(event: CensorshipEvent): void {
    this.censorshipEvents.push(event);

    this.logAudit({
      timestamp: event.timestamp,
      type: 'censorship_suspicion',
      cid: event.cid,
      nodeId: event.nodeId,
      details: {
        type: event.type,
        context: event.context
      }
    });

    logger.warn('Censorship event detected', event);
  }

  /**
   * Log audit entry (R14.10)
   */
  private logAudit(entry: AuditLogEntry): void {
    this.auditLog.push(entry);

    // Keep last 10000 entries
    if (this.auditLog.length > 10000) {
      this.auditLog.shift();
    }
  }

  /**
   * Anti-censorship fetch strategy (R14.4)
   * 
   * Randomize replica selection and retry with next-best nodes
   */
  async fetchWithAntiCensorship(
    cid: string,
    availableNodes: string[],
    replicationFactor: number,
    fetchFunction: (nodeId: string, cid: string) => Promise<Buffer | null>,
    maxRetries = 3
  ): Promise<ConsensusResult> {
    let attempt = 0;
    let lastResult: ConsensusResult | null = null;

    while (attempt < maxRetries) {
      // Randomize node selection (weighted by reputation in real impl)
      const selectedNodes = this.selectRandomNodes(
        availableNodes,
        Math.min(replicationFactor, availableNodes.length)
      );

      // Fetch with consensus
      const result = await this.fetchWithConsensus(cid, selectedNodes, fetchFunction);

      if (result.consensus) {
        return result;
      }

      // Remove censoring nodes from available pool
      availableNodes = availableNodes.filter(
        n => !result.censoringNodes.includes(n) && !result.disputedNodes.includes(n)
      );

      lastResult = result;
      attempt++;

      logger.info('Retrying fetch with different nodes', {
        cid,
        attempt,
        remainingNodes: availableNodes.length
      });
    }

    // Failed to achieve consensus
    return lastResult || {
      cid,
      consensus: false,
      matchingReplicas: 0,
      totalReplicas: 0,
      acceptedHash: null,
      ciphertext: null,
      disputedNodes: [],
      censoringNodes: []
    };
  }

  /**
   * Select random nodes (R14.4)
   */
  private selectRandomNodes(nodes: string[], count: number): string[] {
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Verify replication consensus (R14.7)
   * 
   * Soft consensus on replication - verify all replicas have correct CID
   */
  async verifyReplicationConsensus(
    cid: string,
    replicaNodes: string[],
    verifyFunction: (nodeId: string, cid: string) => Promise<boolean>
  ): Promise<{ verified: boolean; failedNodes: string[] }> {
    const verifications = await Promise.all(
      replicaNodes.map(async (nodeId) => {
        try {
          const verified = await verifyFunction(nodeId, cid);
          return { nodeId, verified };
        } catch (error) {
          return { nodeId, verified: false };
        }
      })
    );

    const failedNodes = verifications
      .filter(v => !v.verified)
      .map(v => v.nodeId);

    const verified = failedNodes.length === 0;

    if (!verified) {
      this.logAudit({
        timestamp: Date.now(),
        type: 'node_failure',
        cid,
        details: {
          failedNodes,
          totalNodes: replicaNodes.length
        }
      });
    }

    return { verified, failedNodes };
  }

  /**
   * Get permanence requirements (R14.9)
   */
  getPermanenceRequirements(permanence: BlobPermanence): {
    replicationFactor: number;
    gcAllowed: boolean;
  } {
    switch (permanence) {
      case 'ephemeral':
        return {
          replicationFactor: 2,
          gcAllowed: true
        };
      case 'persistent':
        return {
          replicationFactor: 3,
          gcAllowed: false
        };
      case 'archival':
        return {
          replicationFactor: 7,
          gcAllowed: false
        };
    }
  }

  /**
   * Export audit log (R14.10)
   */
  exportAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  /**
   * Export censorship events (R14.10)
   */
  exportCensorshipEvents(): CensorshipEvent[] {
    return [...this.censorshipEvents];
  }

  /**
   * Export disputes (R14.10)
   */
  exportDisputes(): DisputeRecord[] {
    return Array.from(this.disputes.values());
  }

  /**
   * Get dispute by CID
   */
  getDispute(cid: string): DisputeRecord | undefined {
    return this.disputes.get(cid);
  }

  /**
   * Clear audit data (for testing)
   */
  clearAuditData(): void {
    this.disputes.clear();
    this.censorshipEvents = [];
    this.auditLog = [];
  }
}

export const consensusService = new ConsensusService();
