/**
 * HASHD Vault - Replication Service
 * 
 * Handles peer-to-peer blob replication using:
 * 1. Pure P2P via libp2p streams (preferred)
 * 2. HTTP fallback for legacy/direct connections
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Peer, ReplicateRequest } from '../types/index.js';
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

    // Load peers from on-chain registry
    await this.loadPeersFromRegistry();

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
    if (!config.replicationEnabled || this.peers.length === 0) {
      return [];
    }

    const enabledPeers = this.peers
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, config.replicationFactor);

    if (enabledPeers.length === 0) {
      logger.warn('No enabled peers for replication');
      return [];
    }

    logger.debug('Starting replication', {
      cid,
      peerCount: enabledPeers.length
    });

    const results = await Promise.allSettled(
      enabledPeers.map(peer => 
        this.replicateToPeer(peer, cid, ciphertext, mimeType, options)
      )
    );

    const successful = results
      .map((result, index) => ({
        result,
        peer: enabledPeers[index]
      }))
      .filter(({ result }) => result.status === 'fulfilled' && result.value)
      .map(({ peer }) => peer.url);

    logger.info('Replication completed', {
      cid,
      successful: successful.length,
      total: enabledPeers.length
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

    // Try P2P replication first if peer has a peerId
    if (peer.nodeId && p2pService.isStarted()) {
      try {
        const success = await p2pProtocolsService.replicateToPeer(
          peer.nodeId,
          cid,
          ciphertext,
          mimeType,
          options
        );

        if (success) {
          const latency = Date.now() - startTime;
          logger.debug('P2P replication successful', {
            peerId: peer.nodeId,
            cid,
            latency
          });
          return true;
        }
        // P2P failed, fall through to HTTP
        logger.debug('P2P replication failed, trying HTTP fallback', { peerId: peer.nodeId });
      } catch (error: any) {
        logger.debug('P2P replication error, trying HTTP fallback', { error: error.message });
      }
    }

    // HTTP fallback
    try {
      const request: ReplicateRequest = {
        cid,
        ciphertext: ciphertext.toString('base64'),
        mimeType,
        fromPeer: config.nodeUrl,
        appId: options?.appId,
        contentType: options?.contentType,
        sender: options?.sender,
        timestamp: options?.timestamp,
        metadata: options?.metadata
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.replicationTimeoutMs);

      const response = await fetch(`${peer.url}/replicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as { alreadyStored?: boolean };
      const latency = Date.now() - startTime;

      logger.debug('HTTP replication successful', {
        peer: peer.url,
        cid,
        latency,
        alreadyStored: result.alreadyStored
      });

      return true;
    } catch (error: any) {
      const latency = Date.now() - startTime;
      logger.warn('Replication failed (both P2P and HTTP)', {
        peer: peer.url,
        peerId: peer.nodeId,
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
        
        // Skip self
        if (node.url === config.nodeUrl) {
          logger.debug('Skipping self', { url: node.url });
          return null;
        }

        return {
          url: node.url,
          nodeId: node.nodeId,
          publicKey: node.publicKey,
          enabled: true,
          priority: 1,
          healthy: true,
          lastHealthCheck: Date.now()
        } as Peer;
      });

      const results = await Promise.all(peerPromises);
      this.peers = results.filter((p): p is Peer => p !== null);

      logger.info('Peers loaded from registry', {
        total: this.peers.length,
        peers: this.peers.map(p => p.url)
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
   * Pull missing blobs from peers (bidirectional sync)
   */
  async pullMissingBlobs(): Promise<void> {
    try {
      // Get our local blobs
      const localBlobs = await storageService.listBlobs();
      const localCids = new Set(localBlobs.map(b => b.cid));

      let pulled = 0;
      let failed = 0;

      // Check each peer for blobs we don't have
      for (const peer of this.peers.filter(p => p.enabled && p.healthy)) {
        try {
          // Get peer's blob list
          const response = await fetch(`${peer.url}/blobs`, {
            signal: AbortSignal.timeout(5000)
          });

          if (!response.ok) continue;

          const peerData = await response.json() as { blobs: Array<{ cid: string; mimeType: string }> };
          
          // Find blobs we don't have
          const missingBlobs = peerData.blobs.filter(b => !localCids.has(b.cid));

          if (missingBlobs.length === 0) continue;

          logger.info('Found missing blobs from peer', {
            peer: peer.url,
            missing: missingBlobs.length
          });

          // Pull each missing blob
          for (const blob of missingBlobs) {
            try {
              // Fetch the blob data
              const blobResponse = await fetch(`${peer.url}/blob/${blob.cid}`, {
                signal: AbortSignal.timeout(config.replicationTimeoutMs)
              });

              if (!blobResponse.ok) {
                failed++;
                continue;
              }

              const blobData = await blobResponse.json() as { 
                cid: string; 
                ciphertext: string; 
                mimeType: string 
              };

              // Store locally
              const ciphertextBuffer = Buffer.from(blobData.ciphertext, 'base64');
              await storageService.storeBlob(
                blobData.cid,
                ciphertextBuffer,
                blobData.mimeType
              );

              pulled++;
              localCids.add(blobData.cid); // Track so we don't pull again from another peer

              logger.debug('Pulled blob from peer', { cid: blob.cid, peer: peer.url });
            } catch (err: any) {
              logger.debug('Failed to pull blob', { cid: blob.cid, error: err.message });
              failed++;
            }
          }
        } catch (err: any) {
          logger.debug('Failed to get blob list from peer', { peer: peer.url, error: err.message });
        }
      }

      if (pulled > 0 || failed > 0) {
        logger.info('Pull sync completed', { pulled, failed });
      }
    } catch (error) {
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
   * Health check all peers
   */
  private async healthCheckPeers(): Promise<void> {
    const checks = this.peers.map(async peer => {
      const healthy = await this.checkPeerHealth(peer.url);
      peer.healthy = healthy;
      peer.lastHealthCheck = Date.now();
      return { url: peer.url, healthy };
    });

    const results = await Promise.all(checks);

    logger.debug('Peer health check completed', {
      results: results.map(r => ({ url: r.url, healthy: r.healthy }))
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
