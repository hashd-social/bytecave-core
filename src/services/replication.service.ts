/**
 * HASHD Vault - Replication Service
 * 
 * Handles peer-to-peer blob replication using:
 * 1. Pure P2P via libp2p streams (preferred)
 */

import { config } from '../config/index.js';
import { REPLICATION_FACTOR } from '../constants/replication.js';
import { logger } from '../utils/logger.js';
import { Peer } from '../types/index.js';
import { contractIntegrationService } from './contract-integration.service.js';
import { storageService } from './storage.service.js';
import { replicationManager } from './replication-manager.service.js';
import { p2pProtocolsService } from './p2p-protocols.service.js';
import { p2pService } from './p2p.service.js';

export class ReplicationService {
  private peers: Peer[] = [];
  private refreshInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize replication service
   */
  async initialize(): Promise<void> {
    if (!config.replicationEnabled) {
      logger.info('Replication disabled');
      return;
    }

    logger.info('Initializing replication service');
    
    // Start periodic peer refresh
    this.startPeerRefresh();

    // Load peers from on-chain registry
    await this.loadPeersFromRegistry();

    logger.info('Replication service initialized');
  }

  /**
   * Replicate all existing blobs to peers
   * Called after P2P service starts and peers connect
   */
  async replicateExistingBlobs(): Promise<void> {
    if (!config.replicationEnabled) {
      return;
    }

    try {
      logger.info('[REPLICATION] Starting replication of existing blobs');
      
      // Get all blobs from storage
      const blobs = await storageService.listBlobs();
      
      if (blobs.length === 0) {
        logger.info('[REPLICATION] No existing blobs to replicate');
        return;
      }

      logger.info('[REPLICATION] Found existing blobs to replicate', { count: blobs.length });

      // Replicate each blob
      for (const blob of blobs) {
        try {
          const blobData = await storageService.getBlob(blob.cid);
          
          logger.info('[REPLICATION] Replicating existing blob', { 
            cid: blob.cid,
            size: blobData.ciphertext.length 
          });

          await this.replicateToAll(
            blob.cid,
            blobData.ciphertext,
            blob.mimeType
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
   * Start periodic peer refresh
   */
  private startPeerRefresh(): void {
    // Refresh peers periodically (every 60 seconds)
    this.refreshInterval = setInterval(() => {
      this.loadPeersFromRegistry().catch((err: Error) => 
        logger.warn('Failed to refresh peers from registry', { error: err.message })
      );
    }, 60000);

    logger.info('Replication service initialized');
  }

  /**
   * Replicate blob to all peers
   */
  async replicateToAll(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: { contentType?: string; guildId?: string }
  ): Promise<string[]> {
    if (!config.replicationEnabled) {
      return [];
    }

    logger.info('[REPLICATION] Starting peer discovery', { cid });
    
    // Filter out this node's own peer ID and orphaned peers (not connected)
    const myPeerId = p2pService.getPeerId();
    const connectedPeerIds = p2pService.getConnectedPeers();

    // Use on-chain registered peers if available, filtering to only connected peers
    // No REPLICATION_FACTOR limit - replicate to ALL connected registered peers
    let enabledPeers = this.peers
      .filter(p => p.enabled)
      .filter(p => (p as any).peerId !== myPeerId) // Filter self
      .filter(p => connectedPeerIds.includes((p as any).peerId)) // Filter orphaned peers (only connected)
      .sort((a, b) => a.priority - b.priority);

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
      enabledPeers = p2pPeers.slice(0, REPLICATION_FACTOR);
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

    logger.info('[REPLICATION] Replication completed', {
      cid,
      successful: successful.length,
      failed: enabledPeers.length - successful.length,
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
  }

  /**
   * Replicate to a single peer - tries P2P first, falls back to HTTP (v2 - with metadata)
   */
  async replicateToPeer(
    peer: Peer,
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: { 
      appId?: string;
      contentType?: string;
      sender?: string;
      timestamp?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<boolean> {
    const startTime = Date.now();

    // Pure P2P replication - no HTTP fallback
    const p2pPeerId = (peer as any).peerId;
    
    logger.info('[REPLICATION] replicateToPeer called', {
      nodeId: peer.nodeId,
      peerId: p2pPeerId,
      cid,
      hasPeerId: !!p2pPeerId
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
      const peerPromises = connectedPeerIds.map(async (peerId: string) => {
        try {
          const health = await p2pProtocolsService.getHealthFromPeer(peerId);
          if (!health || !health.nodeId) {
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
          logger.debug('Failed to get health from P2P peer', { peerId: peerId.slice(0, 12), error: error.message });
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
          
          // Replicate to all peers
          const results = await this.replicateToAll(
            blob.cid,
            blobData.ciphertext,
            blob.mimeType
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

      for (const peer of this.peers.filter(p => p.enabled && p.healthy)) {
        const p2pPeerId = (peer as any).peerId;
        if (!p2pPeerId) continue;

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
  }
}

export const replicationService = new ReplicationService();
