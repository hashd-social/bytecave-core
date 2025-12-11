/**
 * HASHD Vault - Replication Service
 * 
 * Handles peer-to-peer blob replication
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Peer, PeerConfig, ReplicateRequest } from '../types/index.js';

export class ReplicationService {
  private peers: Peer[] = [];
  private peersPath: string;

  constructor() {
    this.peersPath = path.join(process.cwd(), 'config', 'peers.json');
  }

  /**
   * Initialize replication service
   */
  async initialize(): Promise<void> {
    if (!config.replicationEnabled) {
      logger.info('Replication disabled');
      return;
    }

    await this.loadPeers();
  }

  /**
   * Replicate blob to all peers
   */
  async replicateToAll(
    cid: string,
    ciphertext: Buffer,
    mimeType: string
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
        this.replicateToPeer(peer, cid, ciphertext, mimeType)
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

    return successful;
  }

  /**
   * Replicate to a single peer
   */
  async replicateToPeer(
    peer: Peer,
    cid: string,
    ciphertext: Buffer,
    mimeType: string
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

      logger.debug('Replication successful', {
        peer: peer.url,
        cid,
        latency,
        alreadyStored: result.alreadyStored
      });

      return true;
    } catch (error: any) {
      const latency = Date.now() - startTime;
      logger.warn('Replication failed', {
        peer: peer.url,
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
   * Load peers from config
   */
  async loadPeers(): Promise<void> {
    try {
      // Check if file exists
      try {
        await fs.access(this.peersPath);
      } catch {
        // Create default peers config
        await this.createDefaultPeersConfig();
      }

      const content = await fs.readFile(this.peersPath, 'utf-8');
      const peerConfig: PeerConfig = JSON.parse(content);

      this.peers = peerConfig.peers || [];

      logger.info('Peers loaded', {
        total: this.peers.length,
        enabled: this.peers.filter(p => p.enabled).length
      });

      // Health check peers in background
      this.healthCheckPeers().catch(err =>
        logger.warn('Failed to health check peers', { error: err.message })
      );
    } catch (error) {
      logger.error('Failed to load peers', error);
      this.peers = [];
    }
  }

  /**
   * Reload peers
   */
  async reloadPeers(): Promise<void> {
    await this.loadPeers();
  }

  /**
   * Private helper methods
   */

  private async createDefaultPeersConfig(): Promise<void> {
    const configDir = path.dirname(this.peersPath);
    await fs.mkdir(configDir, { recursive: true });

    const defaultConfig: PeerConfig = {
      peers: [],
      replicationFactor: config.replicationFactor,
      replicationTimeout: config.replicationTimeoutMs
    };

    await fs.writeFile(
      this.peersPath,
      JSON.stringify(defaultConfig, null, 2)
    );

    logger.info('Created default peers config', { path: this.peersPath });
  }

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
}

export const replicationService = new ReplicationService();
