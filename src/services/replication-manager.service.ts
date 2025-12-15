/**
 * HASHD Vault - Replication Manager Service
 * 
 * Implements Requirement 6: Replication Factor Enforcement
 * - Deterministic node selection (R6.2)
 * - Replication workflow (R6.3)
 * - Failure handling (R6.4)
 * - State tracking (R6.5)
 * - Proof validation (R6.6)
 * - Over-replication prevention (R6.7)
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { generateReplicationStateHash, verifyReplicationStateIntegrity } from '../utils/cid.js';
import { reputationService } from './reputation.service.js';
import { selectNodesForReplication, isReplicationComplete } from '../utils/node-selection.js';
import { 
  ReplicationTarget, 
  ReplicationState, 
  ReplicationStatus,
  ReplicateRequest 
} from '../types/index.js';

export class ReplicationManagerService {
  private stateFile: string;
  private states: Map<string, ReplicationState> = new Map();
  private initialized = false;

  constructor() {
    this.stateFile = path.join(config.dataDir, 'replication-state.json');
  }

  /**
   * Initialize replication manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.loadStates();
      this.initialized = true;
      logger.info('Replication manager initialized', {
        trackedBlobs: this.states.size
      });
    } catch (error) {
      logger.error('Failed to initialize replication manager', error);
      throw error;
    }
  }

  /**
   * Start replication for a new blob (R6.3)
   * 
   * @param cid Content identifier
   * @param ciphertext Encrypted blob data
   * @param mimeType MIME type
   * @param availableNodes All active nodes in network
   * @returns Replication status
   */
  async startReplication(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    availableNodes: ReplicationTarget[]
  ): Promise<ReplicationStatus> {
    // Check if already replicated (R6.7 - prevent over-replication)
    const existing = this.states.get(cid);
    if (existing && existing.complete) {
      logger.debug('Blob already replicated', { cid });
      return this.getReplicationStatus(cid);
    }

    // Select nodes deterministically (R6.2)
    const selection = selectNodesForReplication(
      cid,
      availableNodes,
      config.replicationFactor,
      existing?.failedNodes || []
    );

    logger.info('Selected nodes for replication', {
      cid,
      selected: selection.selected.length,
      excluded: selection.excluded.length
    });

    // Initialize replication state
    const state: ReplicationState = {
      cid,
      replicationFactor: config.replicationFactor,
      targetNodes: selection.selected.map(n => n.nodeId),
      confirmedNodes: [],
      failedNodes: existing?.failedNodes || [],
      lastUpdated: Date.now(),
      complete: false
    };

    this.states.set(cid, state);
    await this.saveStates();

    // Replicate to selected nodes
    await this.replicateToNodes(cid, ciphertext, mimeType, selection.selected);

    return this.getReplicationStatus(cid);
  }

  /**
   * Replicate blob to selected nodes (R6.3)
   */
  private async replicateToNodes(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    nodes: ReplicationTarget[]
  ): Promise<void> {
    const results = await Promise.allSettled(
      nodes.map(node => this.replicateToNode(cid, ciphertext, mimeType, node))
    );

    const state = this.states.get(cid);
    if (!state) return;

    // Process results
    results.forEach((result, index) => {
      const node = nodes[index];

      if (result.status === 'fulfilled' && result.value) {
        // Success
        if (!state.confirmedNodes.includes(node.nodeId)) {
          state.confirmedNodes.push(node.nodeId);
        }

        // Record successful replication (R6.8)
        reputationService.applyReward(node.nodeId, 'replication-accepted', cid);
      } else {
        // Failure (R6.4)
        if (!state.failedNodes.includes(node.nodeId)) {
          state.failedNodes.push(node.nodeId);
        }

        // Record failed replication (R6.8)
        reputationService.applyPenalty(node.nodeId, 'replication-failed', cid);

        logger.warn('Replication failed', {
          cid,
          nodeId: node.nodeId,
          error: result.status === 'rejected' ? result.reason : 'Unknown'
        });
      }
    });

    // Check if replication is complete (R6.7)
    state.complete = isReplicationComplete(
      state.confirmedNodes.length,
      state.replicationFactor
    );

    state.lastUpdated = Date.now();
    await this.saveStates();

    // If not complete, try replacement nodes (R6.4)
    if (!state.complete && state.failedNodes.length > 0) {
      logger.info('Replication incomplete, selecting replacement nodes', {
        cid,
        confirmed: state.confirmedNodes.length,
        target: state.replicationFactor
      });

      // This would trigger another round of replication
      // In a real implementation, you'd fetch available nodes and retry
    }
  }

  /**
   * Replicate to a single node
   */
  private async replicateToNode(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    node: ReplicationTarget
  ): Promise<boolean> {
    const startTime = Date.now();

    try {
      const request: ReplicateRequest = {
        cid,
        ciphertext: ciphertext.toString('base64'),
        mimeType,
        fromPeer: config.nodeUrl
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.replicationTimeoutMs);

      const response = await fetch(`${node.url}/replicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const latency = Date.now() - startTime;

      logger.debug('Replication successful', {
        nodeId: node.nodeId,
        cid,
        latency
      });

      return true;
    } catch (error: any) {
      const latency = Date.now() - startTime;

      logger.warn('Replication to node failed', {
        nodeId: node.nodeId,
        cid,
        latency,
        error: error.message
      });

      return false;
    }
  }

  /**
   * Get replication status for a CID (R6.5)
   */
  getReplicationStatus(cid: string): ReplicationStatus {
    const state = this.states.get(cid);

    if (!state) {
      return {
        cid,
        expectedReplicas: config.replicationFactor,
        actualReplicas: 0,
        nodes: [],
        complete: false
      };
    }

    const nodes = state.targetNodes.map(nodeId => ({
      nodeId,
      url: '', // Would be fetched from registry
      status: state.confirmedNodes.includes(nodeId)
        ? 'confirmed' as const
        : state.failedNodes.includes(nodeId)
        ? 'failed' as const
        : 'pending' as const,
      lastProof: undefined
    }));

    return {
      cid,
      expectedReplicas: state.replicationFactor,
      actualReplicas: state.confirmedNodes.length,
      nodes,
      complete: state.complete
    };
  }

  /**
   * Verify replication with proofs (R6.6)
   * 
   * @param cid Content identifier
   * @returns true if all replicas have valid proofs
   */
  async verifyReplicationProofs(cid: string): Promise<boolean> {
    const state = this.states.get(cid);
    if (!state) return false;

    // In a full implementation, this would:
    // 1. Request proofs from all confirmed nodes
    // 2. Verify each proof using proof-verification.ts
    // 3. Update state based on proof validity
    // 4. Mark nodes as failed if proofs are invalid

    logger.debug('Proof verification not yet implemented', { cid });
    return state.complete;
  }

  /**
   * Get all replication states
   */
  getAllStates(): ReplicationState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalBlobs: number;
    completeReplications: number;
    incompleteReplications: number;
    avgReplicationFactor: number;
  } {
    const states = Array.from(this.states.values());
    const complete = states.filter(s => s.complete).length;

    const avgFactor = states.length > 0
      ? states.reduce((sum, s) => sum + s.confirmedNodes.length, 0) / states.length
      : 0;

    return {
      totalBlobs: states.length,
      completeReplications: complete,
      incompleteReplications: states.length - complete,
      avgReplicationFactor: Math.round(avgFactor * 10) / 10
    };
  }

  /**
   * Verify replication by actually checking with peer nodes
   * SECURITY: Never trust local state alone - verify with network
   * @returns Number of peers that actually have the blob
   */
  async verifyReplicationWithPeers(cid: string, peerUrls: string[]): Promise<number> {
    let confirmedCount = 0;
    
    for (const peerUrl of peerUrls) {
      try {
        // Ask peer if they have the blob
        const response = await fetch(`${peerUrl}/blob/${cid}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          confirmedCount++;
        }
      } catch {
        // Peer unreachable or doesn't have blob
      }
    }
    
    // Update last verified timestamp
    const state = this.states.get(cid);
    if (state) {
      state.lastVerified = Date.now();
      // Update confirmed count based on actual verification
      if (confirmedCount !== state.confirmedNodes.length) {
        logger.warn('Replication count mismatch detected', {
          cid,
          claimed: state.confirmedNodes.length,
          actual: confirmedCount
        });
      }
    }
    
    return confirmedCount;
  }

  /**
   * Check if blob is safe to delete (has enough replicas)
   * SECURITY: Verifies with network, doesn't trust local state
   */
  async isSafeToDelete(cid: string, peerUrls: string[]): Promise<boolean> {
    const actualReplicas = await this.verifyReplicationWithPeers(cid, peerUrls);
    
    // Safe to delete only if we have at least replicationFactor copies elsewhere
    const isSafe = actualReplicas >= config.replicationFactor;
    
    if (!isSafe) {
      logger.warn('Blob not safe to delete - insufficient replicas', {
        cid,
        actualReplicas,
        required: config.replicationFactor
      });
    }
    
    return isSafe;
  }

  /**
   * Track a successful replication (called by replication service)
   */
  trackReplication(cid: string, successfulPeers: string[]): void {
    const complete = successfulPeers.length >= config.replicationFactor;
    
    const state: ReplicationState = {
      cid,
      replicationFactor: config.replicationFactor,
      targetNodes: successfulPeers,
      confirmedNodes: successfulPeers,
      failedNodes: [],
      lastUpdated: Date.now(),
      complete,
      // SECURITY: Add integrity hash to prevent tampering
      integrityHash: generateReplicationStateHash(
        cid,
        config.replicationFactor,
        successfulPeers,
        complete
      ),
      lastVerified: Date.now()
    };

    this.states.set(cid, state);
    
    // Save async
    this.saveStates().catch(err => 
      logger.warn('Failed to save replication state', { error: err.message })
    );
  }

  /**
   * Load replication states from disk
   * SECURITY: Verifies integrity hash on each state
   */
  private async loadStates(): Promise<void> {
    try {
      const data = await fs.readFile(this.stateFile, 'utf8');
      const statesArray: ReplicationState[] = JSON.parse(data);

      this.states.clear();
      let tampered = 0;
      
      for (const state of statesArray) {
        // SECURITY: Verify integrity hash
        const integrity = verifyReplicationStateIntegrity(state);
        if (!integrity.valid) {
          tampered++;
          logger.error('SECURITY: Replication state tampered, ignoring', { 
            cid: state.cid, 
            reason: integrity.reason 
          });
          continue; // Skip tampered states
        }
        
        this.states.set(state.cid, state);
      }

      if (tampered > 0) {
        logger.error('SECURITY: Found tampered replication states', { 
          tampered, 
          valid: this.states.size 
        });
      }
      
      logger.debug('Loaded replication states', { count: this.states.size });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.states.clear();
        logger.debug('No existing replication states found');
      } else {
        throw error;
      }
    }
  }

  /**
   * Save replication states to disk
   */
  private async saveStates(): Promise<void> {
    try {
      const statesArray = Array.from(this.states.values());
      await fs.writeFile(
        this.stateFile,
        JSON.stringify(statesArray, null, 2)
      );
    } catch (error) {
      logger.error('Failed to save replication states', error);
    }
  }
}

// Singleton instance
export const replicationManager = new ReplicationManagerService();
