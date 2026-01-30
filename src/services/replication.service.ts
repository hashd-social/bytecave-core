/**
 * ByteCave - Replication Service
 * 
 * Handles peer-to-peer blob replication using:
 * 1. Pure P2P via libp2p streams (preferred)
 */

import { config } from '../config/index.js';
import { getReplicationFactor, updateReplicationFactor } from '../constants/replication.js';
import { logger } from '../utils/logger.js';
import { Peer, ReplicationMetadata } from '../types/index.js';
import { contractIntegrationService } from './contract-integration.service.js';
import { storageService } from './storage.service.js';
import { replicationManager } from './replication-manager.service.js';
import { p2pProtocolsService } from './p2p-protocols.service.js';
import { p2pService } from './p2p.service.js';
import { versionCheckService } from './version-check.service.js';

interface RetryQueueItem {
  cid: string;
  ciphertext: Buffer;
  mimeType: string;
  options?: Partial<ReplicationMetadata>;
  targetPeerId: string;
  attempts: number;
  nextRetryAt: number;
}

export class ReplicationService {
  private peers: Peer[] = [];
  private refreshInterval: NodeJS.Timeout | null = null;
  private retryQueue: Map<string, RetryQueueItem> = new Map();
  // @ts-ignore - Used in startPeerRefresh() setInterval
  private retryInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly BASE_RETRY_DELAY_MS = 5000; // 5 seconds
  private readonly HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  
  // Rate limiting
  private replicationInProgress: Set<string> = new Set(); // Track CIDs being replicated
  private readonly MAX_CONCURRENT_REPLICATIONS = 5; // Max concurrent replication operations
  private replicationQueue: Array<() => Promise<void>> = []; // Queue for rate-limited operations
  
  // Track known peer nodeIds to detect new registrations
  private knownPeerNodeIds: Set<string> = new Set();

  /**
   * Initialize replication service
   */
  async initialize(): Promise<void> {
    if (!config.replicationEnabled) {
      logger.info('Replication disabled');
      return;
    }

    logger.info('Initializing replication service');
    
    // Fetch replication factor from contract
    await this.updateReplicationFactorFromContract();
    
    // Start periodic peer refresh
    this.startPeerRefresh();

    // Load peers from on-chain registry
    await this.loadPeersFromRegistry();

    // Start periodic replication health check
    this.startReplicationHealthCheck();

    // Listen for new peer connections to trigger replication
    this.setupPeerConnectionListener();

    // Listen for node registration events to refresh peer list
    this.setupNodeRegistrationListener();

    logger.info('Replication service initialized');
  }

  /**
   * Set up listener for new peer connections to trigger replication
   */
  private setupPeerConnectionListener(): void {
    p2pService.on('peer:connect', async (peerId: string) => {
      logger.info('[REPLICATION] New peer connected, triggering bidirectional sync', { 
        peerId: peerId.slice(0, 16) + '...' 
      });
      
      // Wait a bit for the peer to fully connect and announce capabilities
      setTimeout(async () => {
        try {
          // Push: Check if our blobs are under-replicated and push to new peer
          await this.checkReplicationHealth();
          
          // Pull: Check if new peer has blobs we're missing and pull them
          await this.pullMissingBlobs();
        } catch (error: any) {
          logger.warn('[REPLICATION] Failed to sync after peer connection', { 
            error: error.message 
          });
        }
      }, 1000); // 1 second delay - reduced for faster replication
    });
  }

  /**
   * Set up listener for node registration events to refresh peer list and trigger replication
   */
  private setupNodeRegistrationListener(): void {
    if (!contractIntegrationService.isInitialized()) {
      logger.warn('[REPLICATION] Contract integration not initialized, NodeRegistered listener not set up');
      return;
    }

    logger.info('[REPLICATION] Setting up NodeRegistered event listener');
    contractIntegrationService.onNodeRegistered(async (nodeId: string, owner: string) => {
      logger.info('[REPLICATION] New node registered on-chain, refreshing peer list', { 
        nodeId: nodeId.slice(0, 16) + '...',
        owner: owner.slice(0, 10) + '...'
      });
      
      // Immediately refresh peer list from contract
      try {
        await this.loadPeersFromRegistry();
        logger.info('[REPLICATION] Peer list refreshed after node registration');
        
        // Wait for P2P connections to establish, then trigger replication
        setTimeout(async () => {
          try {
            // First, replicate existing blobs (pull from network)
            await this.replicateExistingBlobs();
            // Then check health to push any under-replicated blobs
            await this.checkReplicationHealth();
          } catch (error: any) {
            logger.warn('[REPLICATION] Failed to trigger replication after node registration', { 
              error: error.message 
            });
          }
        }, 15000); // 15 second delay to match startup behavior
      } catch (error: any) {
        logger.error('[REPLICATION] Failed to refresh peer list after node registration', { 
          error: error.message 
        });
      }
    });
  }

  /**
   * Fetch and cache replication factor from contract
   */
  private async updateReplicationFactorFromContract(): Promise<void> {
    try {
      if (contractIntegrationService.isInitialized()) {
        const factor = await contractIntegrationService.getReplicationFactor();
        updateReplicationFactor(factor);
        logger.info('Replication factor updated from contract', { factor });
      }
    } catch (error) {
      logger.warn('Failed to fetch replication factor from contract, using default', error as Record<string, unknown>);
    }
  }

  /**
   * Replicate all existing blobs to peers
   * Called after P2P service starts and peers connect
   */
  async replicateExistingBlobs(): Promise<void> {
    if (!config.replicationEnabled) {
      return;
    }

    // Skip replication if node is outdated (major version mismatch only)
    const versionStatus = versionCheckService.getVersionStatus();
    logger.info('[REPLICATION] Version check', {
      current: versionStatus.current,
      minimum: versionStatus.minimum,
      outdated: versionStatus.outdated,
      outdatedWarning: versionStatus.outdatedWarning,
      isNodeOutdated: versionCheckService.isNodeOutdated()
    });
    
    if (versionCheckService.isNodeOutdated()) {
      logger.warn('Skipping replication - node has MAJOR version mismatch (blocking)');
      return;
    }
    
    if (versionStatus.outdatedWarning) {
      logger.warn('Node has minor/patch version mismatch - continuing replication with warning');
    }

    try {
      logger.info('[REPLICATION] Starting replication of existing blobs');
      
      // Get all blobs from storage
      const blobs = await storageService.listBlobs();
      
      if (blobs.length === 0) {
        logger.info('[REPLICATION] No existing blobs to replicate');
        return;
      }

      logger.info('[REPLICATION] Found existing blobs', { count: blobs.length });

      // Filter to only replicate blobs that were stored locally (not received via replication)
      const localBlobs = blobs.filter(blob => {
        const source = blob.replication?.source;
        return source === 'local' || source === undefined; // undefined for legacy blobs
      });

      logger.info('[REPLICATION] Filtered to local blobs only', { 
        total: blobs.length,
        local: localBlobs.length,
        replicated: blobs.length - localBlobs.length
      });

      if (localBlobs.length === 0) {
        logger.info('[REPLICATION] No local blobs to replicate');
        return;
      }

      // Replicate each local blob
      for (const blob of localBlobs) {
        try {
          const blobData = await storageService.getBlob(blob.cid);
          
          logger.info('[REPLICATION] Replicating local blob', { 
            cid: blob.cid,
            size: blobData.ciphertext.length,
            appId: blob.appId,
            replicationSource: blob.replication?.source || 'legacy'
          });

          await this.replicateToAll(
            blob.cid,
            blobData.ciphertext,
            blob.mimeType,
            {
              appId: blob.appId || 'hashd',
              sender: blob.sender,
              timestamp: blob.timestamp
            }
          );
        } catch (error: any) {
          logger.warn('[REPLICATION] Failed to replicate existing blob', { 
            cid: blob.cid, 
            error: error.message 
          });
        }
      }

      logger.info('[REPLICATION] Completed replication of existing blobs', { 
        total: blobs.length 
      });
    } catch (error: any) {
      logger.error('[REPLICATION] Failed to replicate existing blobs', { 
        error: error.message 
      });
    }
  }

  /**
   * Start periodic peer refresh and retry processing
   */
  private startPeerRefresh(): void {
    // Refresh peers and replication factor periodically (every 60 seconds)
    this.refreshInterval = setInterval(() => {
      this.updateReplicationFactorFromContract().catch((err: Error) =>
        logger.error('Failed to refresh replication factor', err)
      );
      this.loadPeersFromRegistry().catch((err: Error) => 
        logger.error('Failed to refresh peers', err)
      );
    }, 60000);

    // Process retry queue periodically (every 10 seconds)
    this.retryInterval = setInterval(() => {
      this.processRetryQueue().catch((err: Error) =>
        logger.warn('Failed to process retry queue', { error: err.message })
      );
    }, 10000);

    logger.info('Replication service initialized');
  }

  /**
   * Start periodic replication health check
   * Detects under-replicated blobs and triggers re-replication
   */
  private startReplicationHealthCheck(): void {
    // Run health check periodically (every 10 minutes)
    this.healthCheckInterval = setInterval(() => {
      this.checkReplicationHealth().catch((err: Error) =>
        logger.error('Failed to check replication health', { error: err.message })
      );
    }, this.HEALTH_CHECK_INTERVAL_MS);

    logger.info('[REPLICATION] Health check service started', {
      intervalMinutes: this.HEALTH_CHECK_INTERVAL_MS / 60000
    });
  }

  /**
   * Check replication health for all local blobs
   * Detects under-replication and triggers re-replication
   */
  private async checkReplicationHealth(): Promise<void> {
    try {
      logger.info('[REPLICATION] Starting replication health check');

      // Get all blobs from storage
      const blobs = await storageService.listBlobs();
      
      // Filter to only check locally-stored blobs
      const localBlobs = blobs.filter(blob => {
        const source = blob.replication?.source;
        return source === 'local' || source === undefined;
      });

      if (localBlobs.length === 0) {
        logger.info('[REPLICATION] No local blobs to health check');
        return;
      }

      logger.info('[REPLICATION] Health checking local blobs', { count: localBlobs.length });

      const replicationFactor = getReplicationFactor();
      const connectedPeerIds = p2pService.getConnectedPeers();
      let underReplicatedCount = 0;
      let healthyCount = 0;

      // Check each local blob's replication status
      for (const blob of localBlobs) {
        try {
          // Query network for existing replicas
          const peersWithCid = await p2pProtocolsService.queryWhoHasCid(blob.cid, connectedPeerIds);
          const currentReplicas = peersWithCid.length + 1; // +1 for this node

          if (currentReplicas < replicationFactor) {
            underReplicatedCount++;
            logger.warn('[REPLICATION] Under-replicated blob detected', {
              cid: blob.cid,
              currentReplicas,
              replicationFactor,
              deficit: replicationFactor - currentReplicas
            });

            // Trigger re-replication
            const blobData = await storageService.getBlob(blob.cid);
            await this.replicateToAll(
              blob.cid,
              blobData.ciphertext,
              blob.mimeType,
              {
                appId: blob.appId,
                sender: blob.sender,
                timestamp: blob.timestamp
              }
            );
          } else {
            healthyCount++;
          }
        } catch (error: any) {
          logger.warn('[REPLICATION] Failed to health check blob', {
            cid: blob.cid,
            error: error.message
          });
        }
      }

      logger.info('[REPLICATION] Health check complete', {
        total: localBlobs.length,
        healthy: healthyCount,
        underReplicated: underReplicatedCount,
        replicationFactor
      });
    } catch (error: any) {
      logger.error('[REPLICATION] Health check failed', { error: error.message });
    }
  }

  /**
   * Add failed replication to retry queue with exponential backoff
   */
  private addToRetryQueue(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    targetPeerId: string,
    options?: Partial<ReplicationMetadata>,
    currentAttempts: number = 0
  ): void {
    const queueKey = `${cid}-${targetPeerId}`;
    
    // Calculate exponential backoff: 5s, 10s, 20s
    const delay = this.BASE_RETRY_DELAY_MS * Math.pow(2, currentAttempts);
    const nextRetryAt = Date.now() + delay;

    this.retryQueue.set(queueKey, {
      cid,
      ciphertext,
      mimeType,
      options,
      targetPeerId,
      attempts: currentAttempts + 1,
      nextRetryAt
    });

    logger.info('[REPLICATION] Added to retry queue', {
      cid,
      targetPeerId: targetPeerId.slice(0, 12),
      attempts: currentAttempts + 1,
      nextRetryIn: `${delay}ms`
    });
  }

  /**
   * Process retry queue - attempt failed replications
   */
  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const toRetry: RetryQueueItem[] = [];

    // Find items ready for retry
    for (const [key, item] of this.retryQueue.entries()) {
      if (item.nextRetryAt <= now) {
        toRetry.push(item);
        this.retryQueue.delete(key);
      }
    }

    if (toRetry.length === 0) {
      return;
    }

    logger.info('[REPLICATION] Processing retry queue', {
      count: toRetry.length,
      queueSize: this.retryQueue.size
    });

    for (const item of toRetry) {
      try {
        const success = await p2pProtocolsService.replicateToPeer(
          item.targetPeerId,
          item.cid,
          item.ciphertext,
          item.mimeType,
          item.options
        );

        if (success) {
          logger.info('[REPLICATION] Retry successful', {
            cid: item.cid,
            targetPeerId: item.targetPeerId.slice(0, 12),
            attempts: item.attempts
          });
        } else {
          // Retry failed, check if we should retry again
          if (item.attempts < this.MAX_RETRY_ATTEMPTS) {
            this.addToRetryQueue(
              item.cid,
              item.ciphertext,
              item.mimeType,
              item.targetPeerId,
              item.options,
              item.attempts
            );
          } else {
            logger.warn('[REPLICATION] Max retry attempts reached, giving up', {
              cid: item.cid,
              targetPeerId: item.targetPeerId.slice(0, 12),
              attempts: item.attempts
            });
          }
        }
      } catch (error: any) {
        // Retry failed with error, check if we should retry again
        if (item.attempts < this.MAX_RETRY_ATTEMPTS) {
          this.addToRetryQueue(
            item.cid,
            item.ciphertext,
            item.mimeType,
            item.targetPeerId,
            item.options,
            item.attempts
          );
        } else {
          logger.warn('[REPLICATION] Max retry attempts reached after error, giving up', {
            cid: item.cid,
            targetPeerId: item.targetPeerId.slice(0, 12),
            attempts: item.attempts,
            error: error.message
          });
        }
      }
    }
  }

  /**
   * Replicate blob to all peers with rate limiting
   */
  async replicateToAll(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: Partial<ReplicationMetadata>
  ): Promise<string[]> {
    if (!config.replicationEnabled) {
      return [];
    }

    // Check if this CID is already being replicated
    if (this.replicationInProgress.has(cid)) {
      logger.debug('[REPLICATION] Replication already in progress for CID', { cid });
      return [];
    }

    // Check concurrent replication limit
    if (this.replicationInProgress.size >= this.MAX_CONCURRENT_REPLICATIONS) {
      logger.info('[REPLICATION] Max concurrent replications reached, queueing', {
        cid,
        inProgress: this.replicationInProgress.size,
        queueSize: this.replicationQueue.length
      });
      
      // Queue this replication for later
      return new Promise((resolve) => {
        this.replicationQueue.push(async () => {
          const result = await this._replicateToAllInternal(cid, ciphertext, mimeType, options);
          resolve(result);
        });
      });
    }

    return this._replicateToAllInternal(cid, ciphertext, mimeType, options);
  }

  /**
   * Internal replication logic (called by rate-limited wrapper)
   */
  private async _replicateToAllInternal(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: Partial<ReplicationMetadata>
  ): Promise<string[]> {
    try {
      logger.info('[REPLICATION] Starting distributed consensus replication', { cid });
    
    // Filter out this node's own peer ID and orphaned peers (not connected)
    const myPeerId = p2pService.getPeerId();
    const connectedPeerIds = p2pService.getConnectedPeers();
    const replicationFactor = getReplicationFactor();

    // DISTRIBUTED CONSENSUS: Query network to find who already has this CID
    logger.info('[REPLICATION] Querying network for existing replicas', { 
      cid, 
      connectedPeers: connectedPeerIds.length 
    });
    
    const peersWithCid = await p2pProtocolsService.queryWhoHasCid(cid, connectedPeerIds);
    
    // Calculate current replica count (including this node)
    const currentReplicas = peersWithCid.length + 1;
    
    logger.info('[REPLICATION] Replica consensus check', {
      cid,
      currentReplicas,
      replicationFactor,
      needsReplication: currentReplicas < replicationFactor,
      peersWithCid: peersWithCid.map(p => p.slice(0, 12))
    });

    // If we already have enough replicas, skip replication
    if (currentReplicas >= replicationFactor) {
      logger.info('[REPLICATION] Sufficient replicas exist, skipping replication', {
        cid,
        currentReplicas,
        replicationFactor
      });
      return [];
    }

    // Calculate how many more replicas we need
    const replicasNeeded = replicationFactor - currentReplicas;

    // Use on-chain registered peers if available, filtering to only connected peers
    // IMPORTANT: Exclude peers that already have the CID
    let enabledPeers = this.peers
      .filter(p => p.enabled)
      .filter(p => (p as any).peerId !== myPeerId) // Filter self
      .filter(p => connectedPeerIds.includes((p as any).peerId)) // Filter orphaned peers (only connected)
      .filter(p => !peersWithCid.includes((p as any).peerId)) // Filter peers that already have CID
      .sort((a, b) => a.priority - b.priority)
      .slice(0, replicasNeeded); // Only replicate to as many peers as needed

    logger.info('[REPLICATION] On-chain peers check', { 
      totalPeers: this.peers.length,
      enabledPeers: enabledPeers.length,
      peers: enabledPeers.map(p => ({ nodeId: p.nodeId, url: p.url }))
    });
    
    logger.info('[REPLICATION] Filtered replication targets', {
      myPeerId,
      totalConnected: connectedPeerIds.length,
      totalRegistered: this.peers.length,
      afterFiltering: enabledPeers.length,
      targets: enabledPeers.map((p: any) => p.peerId)
    });

    // If no on-chain peers, try to use P2P-connected peers
    if (enabledPeers.length === 0) {
      logger.info('[REPLICATION] No on-chain peers, attempting P2P peer discovery');
      const p2pPeers = await this.getP2PPeers();
      logger.info('[REPLICATION] P2P peers discovered', { 
        count: p2pPeers.length,
        peers: p2pPeers.map(p => ({ 
          nodeId: p.nodeId, 
          peerId: (p as any).peerId
        }))
      });
      // Filter out peers that already have the CID
      enabledPeers = p2pPeers
        .filter(p => !peersWithCid.includes((p as any).peerId))
        .slice(0, replicasNeeded);
    }

    if (enabledPeers.length === 0) {
      logger.warn('[REPLICATION] No peers available for replication (neither on-chain nor P2P)');
      return [];
    }

    logger.info('[REPLICATION] Starting replication attempts', {
      cid,
      peerCount: enabledPeers.length,
      peers: enabledPeers.map(p => ({
        nodeId: p.nodeId,
        peerId: (p as any).peerId,
        url: p.url
      }))
    });

    const results = await Promise.allSettled(
      enabledPeers.map((peer, index) => {
        logger.info('[REPLICATION] Attempting replication to peer', {
          index,
          nodeId: peer.nodeId,
          peerId: (peer as any).peerId,
          cid
        });
        return this.replicateToPeer(peer, cid, ciphertext, mimeType, options);
      })
    );

    const successful = results
      .map((result, index) => ({
        result,
        peer: enabledPeers[index]
      }))
      .filter(({ result }) => result.status === 'fulfilled' && result.value)
      .map(({ peer }) => peer.url);

    // Handle failed replications - try alternative peers if available
    const failed = results
      .map((result, index) => ({
        result,
        peer: enabledPeers[index]
      }))
      .filter(({ result }) => result.status === 'rejected' || (result.status === 'fulfilled' && !result.value));

    // Calculate how many more replicas we need after initial attempts
    const currentSuccessful = successful.length + 1; // +1 for this node
    const stillNeeded = replicationFactor - currentSuccessful;

    if (stillNeeded > 0 && failed.length > 0) {
      logger.info('[REPLICATION] Some replications failed, trying alternative peers', {
        cid,
        stillNeeded,
        failedCount: failed.length
      });

      // Get list of peers we haven't tried yet (excluding already attempted and successful ones)
      const attemptedPeerIds = new Set(enabledPeers.map(p => (p as any).peerId));
      const alternativePeers = this.peers
        .filter(p => p.enabled)
        .filter(p => (p as any).peerId !== myPeerId)
        .filter(p => connectedPeerIds.includes((p as any).peerId))
        .filter(p => !peersWithCid.includes((p as any).peerId))
        .filter(p => !attemptedPeerIds.has((p as any).peerId))
        .slice(0, stillNeeded);

      if (alternativePeers.length > 0) {
        logger.info('[REPLICATION] Attempting replication to alternative peers', {
          cid,
          alternativeCount: alternativePeers.length,
          peers: alternativePeers.map(p => ({ nodeId: p.nodeId, peerId: (p as any).peerId?.slice(0, 12) }))
        });

        const alternativeResults = await Promise.allSettled(
          alternativePeers.map(peer => this.replicateToPeer(peer, cid, ciphertext, mimeType, options))
        );

        const alternativeSuccessful = alternativeResults
          .map((result, index) => ({
            result,
            peer: alternativePeers[index]
          }))
          .filter(({ result }) => result.status === 'fulfilled' && result.value)
          .map(({ peer }) => peer.url);

        successful.push(...alternativeSuccessful);

        logger.info('[REPLICATION] Alternative peer replication results', {
          cid,
          alternativeSuccessful: alternativeSuccessful.length,
          totalSuccessful: successful.length
        });
      } else {
        logger.warn('[REPLICATION] No alternative peers available for fallback', {
          cid,
          stillNeeded
        });

        // Only add to retry queue if no alternatives were available
        for (const { peer } of failed) {
          const p2pPeerId = (peer as any).peerId;
          if (p2pPeerId) {
            this.addToRetryQueue(cid, ciphertext, mimeType, p2pPeerId, options);
          }
        }
      }
    } else if (failed.length > 0) {
      // Replication factor met, but some peers failed - add to retry queue for eventual consistency
      for (const { peer } of failed) {
        const p2pPeerId = (peer as any).peerId;
        if (p2pPeerId) {
          this.addToRetryQueue(cid, ciphertext, mimeType, p2pPeerId, options);
        }
      }
    }

    logger.info('[REPLICATION] Replication completed', {
      cid,
      successful: successful.length,
      failed: failed.length,
      queued: failed.length,
      total: enabledPeers.length,
      details: results.map((r, i) => ({
        peer: enabledPeers[i].nodeId,
        peerId: (enabledPeers[i] as any).peerId?.slice(0, 12),
        status: r.status,
        success: r.status === 'fulfilled' ? r.value : false,
        error: r.status === 'rejected' ? r.reason?.message : (r.status === 'fulfilled' && !r.value ? 'returned false' : undefined)
      }))
    });

      // Track replication in manager for stats
      if (successful.length > 0) {
        replicationManager.trackReplication(cid, successful);
      }
      
      return successful;
    } finally {
      // Remove from in-progress set
      this.replicationInProgress.delete(cid);
      
      // Process next queued replication if any
      if (this.replicationQueue.length > 0) {
        const nextReplication = this.replicationQueue.shift();
        if (nextReplication) {
          // Execute next replication asynchronously
          nextReplication().catch((err: Error) =>
            logger.error('[REPLICATION] Queued replication failed', { error: err.message })
          );
        }
      }
    }
  }

  /**
   * Replicate to a single peer - tries P2P first, falls back to HTTP (v2 - with metadata)
   */
  async replicateToPeer(
    peer: Peer,
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: Partial<ReplicationMetadata>
  ): Promise<boolean> {
    const startTime = Date.now();

    // Pure P2P replication - no HTTP fallback
    const p2pPeerId = (peer as any).peerId;
    
    logger.info('[REPLICATION] replicateToPeer called', {
      nodeId: peer.nodeId,
      peerId: p2pPeerId,
      cid,
      hasPeerId: !!p2pPeerId,
      hasOptions: !!options,
      optionsAppId: options?.appId
    });
    
    if (!p2pPeerId) {
      logger.warn('[REPLICATION] Peer has no P2P peer ID, cannot replicate', { nodeId: peer.nodeId });
      return false;
    }

    // Check if we have connected peers (P2P service might still be starting)
    const connectedPeers = p2pService.getConnectedPeers();
    
    logger.info('[REPLICATION] P2P connection check', {
      connectedPeersCount: connectedPeers.length,
      targetPeerId: p2pPeerId,
      isTargetConnected: connectedPeers.includes(p2pPeerId)
    });

    if (connectedPeers.length === 0) {
      logger.info('[REPLICATION] No connected peers yet, skipping replication', { 
        peerId: p2pPeerId,
        note: 'P2P service may still be starting'
      });
      return false;
    }

    logger.info('[REPLICATION] Calling p2pProtocolsService.replicateToPeer', {
      peerId: p2pPeerId,
      cid,
      ciphertextSize: ciphertext.length,
      mimeType
    });

    try {
      const success = await p2pProtocolsService.replicateToPeer(
        p2pPeerId,
        cid,
        ciphertext,
        mimeType,
        options
      );

      logger.info('[REPLICATION] p2pProtocolsService.replicateToPeer result', {
        peerId: p2pPeerId.slice(0, 12),
        cid,
        success
      });

      if (success) {
        const latency = Date.now() - startTime;
        logger.info('[REPLICATION] P2P replication successful', {
          peerId: p2pPeerId.slice(0, 12),
          cid,
          latency
        });
        return true;
      } else {
        logger.warn('[REPLICATION] P2P replication returned false', { 
          peerId: p2pPeerId.slice(0, 12), 
          cid 
        });
        return false;
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      logger.warn('P2P replication error', {
        peerId: p2pPeerId.slice(0, 12),
        cid,
        latency,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check peer health
   */
  async checkPeerHealth(peerUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${peerUrl}/health`, {
        signal: controller.signal
      });

      clearTimeout(timeout);

      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all peers
   */
  getPeers(): Peer[] {
    return [...this.peers];
  }

  /**
   * Get enabled peer count
   */
  getEnabledPeerCount(): number {
    return this.peers.filter(p => p.enabled).length;
  }

  /**
   * Get actively replicating peer count (enabled + healthy + connected via P2P)
   */
  getReplicatingPeerCount(): number {
    if (!p2pService.isStarted()) {
      return 0;
    }
    
    // Get actually connected P2P peer IDs
    const connectedPeerIds = new Set(p2pService.getConnectedPeers());
    
    // Count peers that are: enabled, healthy, AND actually connected via P2P
    return this.peers.filter(p => {
      const peerData = p as any;
      return p.enabled && p.healthy && peerData.peerId && connectedPeerIds.has(peerData.peerId);
    }).length;
  }

  /**
   * Get P2P-connected peers for replication when on-chain registry is empty
   */
  private async getP2PPeers(): Promise<Peer[]> {
    try {
      // Get connected P2P peers from p2pService
      const connectedPeerIds = p2pService.getConnectedPeers();
      logger.debug('Found P2P connected peers', { count: connectedPeerIds.length });

      if (connectedPeerIds.length === 0) {
        return [];
      }

      // Try to get health data from each peer to build peer list
      // Silently skip relay-only peers that don't implement ByteCave protocols
      const peerPromises = connectedPeerIds.map(async (peerId: string) => {
        try {
          const health = await p2pProtocolsService.getHealthFromPeer(peerId);
          if (!health || !health.nodeId) {
            // Peer doesn't support health protocol (likely a relay) - skip silently
            return null;
          }

          // Check if this peer is registered on-chain by peer ID
          const isRegistered = await this.checkPeerRegistrationByPeerId(peerId);
          if (!isRegistered) {
            logger.debug('P2P peer not registered, skipping', { peerId: peerId.slice(0, 12) });
            return null;
          }

          return {
            url: `http://localhost:5001`, // Fallback URL - will use P2P replication anyway
            nodeId: health.nodeId,
            publicKey: health.publicKey || '',
            enabled: true,
            priority: 1,
            healthy: true,
            lastHealthCheck: Date.now(),
            peerId: peerId
          } as Peer & { peerId: string };
        } catch (error: any) {
          // logger.debug('Failed to get health from P2P peer', { peerId: peerId.slice(0, 12), error: error.message });
          return null;
        }
      });

      const results = await Promise.all(peerPromises);
      const p2pPeers = results.filter((p: any): p is Peer & { peerId: string } => p !== null);

      logger.info('Discovered P2P peers for replication', { 
        count: p2pPeers.length,
        peers: p2pPeers.map((p: any) => p.peerId.slice(0, 12))
      });

      return p2pPeers;
    } catch (error: any) {
      logger.warn('Failed to discover P2P peers', { error: error.message });
      return [];
    }
  }

  /**
   * Check if a peer ID is registered on-chain
   */
  private async checkPeerRegistrationByPeerId(peerId: string): Promise<boolean> {
    try {
      if (!contractIntegrationService.isInitialized()) {
        logger.debug('Contract integration not initialized, cannot check registration');
        return false;
      }
      
      const nodeId = await contractIntegrationService.getNodeByPeerId(peerId);
      const isRegistered = nodeId !== null;
      
      logger.debug('Peer registration check', { 
        peerId: peerId.slice(0, 12), 
        registered: isRegistered 
      });
      
      return isRegistered;
    } catch (error: any) {
      logger.warn('Error checking peer registration', { 
        peerId: peerId.slice(0, 12), 
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Load peers from on-chain registry
   */
  async loadPeersFromRegistry(): Promise<void> {
    try {
      if (!contractIntegrationService.isInitialized()) {
        logger.info('Contract integration not initialized, skipping peer discovery');
        return;
      }

      // Get active nodes from registry
      const nodeIds = await contractIntegrationService.getActiveNodes();
      logger.info('Found nodes in registry', { count: nodeIds.length, nodeIds });
      
      if (nodeIds.length === 0) {
        logger.debug('No active nodes in registry');
        this.peers = [];
        return;
      }

      // Fetch node details and convert to peers
      const peerPromises = nodeIds.map(async (nodeId: string) => {
        const node = await contractIntegrationService.getNode(nodeId);
        if (!node || !node.active) {
          logger.debug('Node not active or not found', { nodeId });
          return null;
        }
        
        // Skip self by comparing P2P peer IDs
        const myPeerId = p2pService.getPeerId();
        if (node.peerId === myPeerId) {
          logger.debug('Skipping self', { peerId: node.peerId });
          return null;
        }

        // P2P peer ID comes directly from on-chain registry
        if (!node.peerId) {
          logger.debug('Node has no P2P peer ID', { nodeId });
          return null;
        }

        logger.debug('Loaded peer from registry', { 
          nodeId: node.nodeId.slice(0, 12), 
          peerId: node.peerId.slice(0, 12) 
        });

        return {
          nodeId: node.nodeId,
          publicKey: node.publicKey,
          peerId: node.peerId, // P2P peer ID from on-chain registry
          enabled: true,
          priority: 1,
          healthy: true,
          lastHealthCheck: Date.now()
        } as Peer & { peerId: string };
      });

      const results = await Promise.all(peerPromises);
      this.peers = results.filter(p => p !== null) as any[];

      // Detect new peer registrations
      const currentPeerNodeIds = new Set(this.peers.map((p: any) => p.nodeId));
      const newPeerNodeIds = [...currentPeerNodeIds].filter(nodeId => !this.knownPeerNodeIds.has(nodeId));
      
      if (newPeerNodeIds.length > 0) {
        logger.info('[REPLICATION] Detected new peer registrations', {
          newPeers: newPeerNodeIds.length,
          nodeIds: newPeerNodeIds.map(id => id.slice(0, 16) + '...')
        });
        
        // Update known peers
        this.knownPeerNodeIds = currentPeerNodeIds;
        
        // Trigger replication for new peers after delay for P2P connection
        setTimeout(async () => {
          try {
            logger.info('[REPLICATION] Triggering replication for newly registered peers');
            await this.replicateExistingBlobs();
            await this.checkReplicationHealth();
          } catch (error: any) {
            logger.warn('[REPLICATION] Failed to replicate to new peers', { 
              error: error.message 
            });
          }
        }, 15000); // 15 second delay to allow P2P connections
      } else {
        // Update known peers even if no new ones
        this.knownPeerNodeIds = currentPeerNodeIds;
      }

      logger.info('[REPLICATION] Peers loaded from registry', {
        total: this.peers.length,
        peers: this.peers.map((p: any) => p.peerId || 'unknown')
      });

      // Health check peers in background
      this.healthCheckPeers().catch((err: Error) =>
        logger.warn('Failed to health check peers', { error: err.message })
      );

      // Sync blobs bidirectionally
      if (this.peers.length > 0) {
        // Push our blobs to peers
        this.syncExistingBlobs().catch((err: Error) =>
          logger.warn('Failed to sync existing blobs', { error: err.message })
        );
        // Pull missing blobs from peers
        this.pullMissingBlobs().catch((err: Error) =>
          logger.warn('Failed to pull missing blobs', { error: err.message })
        );
      }
    } catch (error) {
      logger.error('Failed to load peers from registry', error);
    }
  }

  /**
   * Sync all existing blobs to peers
   */
  async syncExistingBlobs(): Promise<void> {
    try {
      const blobs = await storageService.listBlobs();
      
      if (blobs.length === 0) {
        logger.debug('No blobs to sync');
        return;
      }

      logger.info('Starting blob sync to peers', {
        blobCount: blobs.length,
        peerCount: this.peers.length
      });

      let synced = 0;
      let failed = 0;

      for (const blob of blobs) {
        try {
          // Get the blob data
          const blobData = await storageService.getBlob(blob.cid);
          
          // Replicate to all peers with metadata
          const results = await this.replicateToAll(
            blob.cid,
            blobData.ciphertext,
            blob.mimeType,
            {
              appId: blob.appId,
              sender: blob.sender,
              timestamp: blob.timestamp
            }
          );

          if (results.length > 0) {
            synced++;
          }
        } catch (err: any) {
          logger.debug('Failed to sync blob', { cid: blob.cid, error: err.message });
          failed++;
        }
      }

      logger.info('Blob sync completed', { synced, failed, total: blobs.length });
    } catch (error) {
      logger.error('Blob sync failed', error);
    }
  }

  /**
   * Pull missing blobs from peers (bidirectional sync) - Pure P2P
   */
  async pullMissingBlobs(): Promise<void> {
    try {
      // Get our local blobs
      const localBlobs = await storageService.listBlobs();
      const localCids = new Set(localBlobs.map(b => b.cid));

      let pulled = 0;
      let failed = 0;

      // Import blocked content service
      const { blockedContentService } = await import('./blocked-content.service.js');

      for (const peer of this.peers.filter(p => p.enabled && p.healthy)) {
        const p2pPeerId = (peer as any).peerId;
        if (!p2pPeerId) continue;

        // Check if peer is blocked
        if (await blockedContentService.isPeerBlocked(p2pPeerId)) {
          logger.info('Skipping pull from blocked peer', { peerId: p2pPeerId.slice(0, 12) });
          continue;
        }

        try {
          // Get peer's blob list via P2P
          const haveListResponse = await p2pProtocolsService.getHaveListFromPeer(p2pPeerId);
          if (!haveListResponse) continue;

          // Find blobs we don't have
          const missingCids = haveListResponse.cids.filter(cid => !localCids.has(cid));
          if (missingCids.length === 0) continue;

          logger.info('Found missing blobs from peer', {
            peerId: p2pPeerId.slice(0, 12),
            missing: missingCids.length
          });

          // Pull missing blobs via P2P
          for (const cid of missingCids) {
            try {
              const blobData = await p2pProtocolsService.retrieveFromPeer(p2pPeerId, cid);
              if (!blobData) {
                failed++;
                continue;
              }

              // Store the blob locally
              await storageService.storeBlob(
                cid,
                blobData.ciphertext,
                blobData.mimeType
              );

              pulled++;
              localCids.add(cid);

              logger.debug('Pulled blob from peer via P2P', { cid, peerId: p2pPeerId.slice(0, 12) });
            } catch (err: any) {
              logger.debug('Failed to pull blob via P2P', { cid, error: err.message });
              failed++;
            }
          }
        } catch (err: any) {
          logger.debug('Failed to get blob list from peer via P2P', { 
            peerId: p2pPeerId.slice(0, 12), 
            error: err.message 
          });
        }
      }

      logger.info('Pull sync completed', { pulled, failed });
    } catch (error: any) {
      logger.error('Pull sync failed', error);
    }
  }

  /**
   * Reload peers from registry
   */
  async reloadPeers(): Promise<void> {
    await this.loadPeersFromRegistry();
  }

  /**
   * Health check all peers via P2P
   */
  private async healthCheckPeers(): Promise<void> {
    const checks = this.peers.map(async peer => {
      const p2pPeerId = (peer as any).peerId;
      if (!p2pPeerId) {
        peer.healthy = false;
        return { peerId: p2pPeerId, healthy: false };
      }

      try {
        const healthResponse = await p2pProtocolsService.getHealthFromPeer(p2pPeerId);
        peer.healthy = healthResponse !== null;
        peer.lastHealthCheck = Date.now();
        return { peerId: p2pPeerId.slice(0, 12), healthy: peer.healthy };
      } catch (error: any) {
        peer.healthy = false;
        peer.lastHealthCheck = Date.now();
        return { peerId: p2pPeerId.slice(0, 12), healthy: false };
      }
    });

    const results = await Promise.all(checks);

    logger.debug('Peer health check completed via P2P', {
      results: results.map(r => ({ peerId: r.peerId, healthy: r.healthy }))
    });
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info('[REPLICATION] Service shutdown complete');
  }
}

export const replicationService = new ReplicationService();
