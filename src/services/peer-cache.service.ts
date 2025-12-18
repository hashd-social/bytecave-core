/**
 * Peer Cache Service
 * 
 * Automatically saves discovered peers to bootstrap list for faster reconnection
 * without requiring relay on subsequent startups.
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface CachedPeer {
  peerId: string;
  multiaddrs: string[];
  lastSeen: number;
  successfulConnections: number;
}

interface PeerCache {
  version: number;
  updatedAt: number;
  peers: CachedPeer[];
}

class PeerCacheService {
  private cachePath: string;
  private cache: PeerCache = {
    version: 1,
    updatedAt: Date.now(),
    peers: []
  };
  private readonly MAX_CACHED_PEERS = 50;
  private readonly PEER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    this.cachePath = path.join(config.dataDir, 'peer-cache.json');
  }

  /**
   * Load cached peers from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.cachePath, 'utf-8');
      this.cache = JSON.parse(data);
      
      // Clean expired peers
      const now = Date.now();
      this.cache.peers = this.cache.peers.filter(
        peer => now - peer.lastSeen < this.PEER_EXPIRY_MS
      );

      logger.info('Loaded peer cache', { 
        peers: this.cache.peers.length,
        path: this.cachePath 
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.info('No peer cache found, starting fresh');
      } else {
        logger.warn('Failed to load peer cache', { error: error.message });
      }
    }
  }

  /**
   * Save cache to disk (debounced)
   */
  private async save(): Promise<void> {
    try {
      this.cache.updatedAt = Date.now();
      await fs.writeFile(
        this.cachePath,
        JSON.stringify(this.cache, null, 2),
        'utf-8'
      );
      this.dirty = false;
      logger.debug('Saved peer cache', { peers: this.cache.peers.length });
    } catch (error: any) {
      logger.error('Failed to save peer cache', { error: error.message });
    }
  }

  /**
   * Schedule a save (debounced to avoid excessive writes)
   */
  private scheduleSave(): void {
    this.dirty = true;
    
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    // Save after 30 seconds of inactivity
    this.saveTimer = setTimeout(() => {
      if (this.dirty) {
        this.save();
      }
    }, 30000);
  }

  /**
   * Add or update a peer in the cache
   */
  addPeer(peerId: string, multiaddrs: string[]): void {
    // Don't cache relay peers (they're in config already)
    if (multiaddrs.length === 0) return;

    const now = Date.now();
    const existing = this.cache.peers.find(p => p.peerId === peerId);

    if (existing) {
      // Update existing peer
      existing.multiaddrs = multiaddrs;
      existing.lastSeen = now;
      existing.successfulConnections++;
    } else {
      // Add new peer
      this.cache.peers.push({
        peerId,
        multiaddrs,
        lastSeen: now,
        successfulConnections: 1
      });

      // Sort by successful connections (most reliable first)
      this.cache.peers.sort((a, b) => b.successfulConnections - a.successfulConnections);

      // Limit cache size
      if (this.cache.peers.length > this.MAX_CACHED_PEERS) {
        this.cache.peers = this.cache.peers.slice(0, this.MAX_CACHED_PEERS);
      }
    }

    this.scheduleSave();
  }

  /**
   * Remove a peer from cache (e.g., if it's consistently unreachable)
   */
  removePeer(peerId: string): void {
    const index = this.cache.peers.findIndex(p => p.peerId === peerId);
    if (index !== -1) {
      this.cache.peers.splice(index, 1);
      this.scheduleSave();
      logger.debug('Removed peer from cache', { peerId });
    }
  }

  /**
   * Get cached peer multiaddrs for bootstrap
   */
  getBootstrapPeers(): string[] {
    const now = Date.now();
    
    return this.cache.peers
      .filter(peer => now - peer.lastSeen < this.PEER_EXPIRY_MS)
      .flatMap(peer => peer.multiaddrs);
  }

  /**
   * Get all cached peers
   */
  getCachedPeers(): CachedPeer[] {
    return [...this.cache.peers];
  }

  /**
   * Force immediate save
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
  }

  /**
   * Clean up old peers
   */
  cleanup(): void {
    const now = Date.now();
    const before = this.cache.peers.length;
    
    this.cache.peers = this.cache.peers.filter(
      peer => now - peer.lastSeen < this.PEER_EXPIRY_MS
    );

    const removed = before - this.cache.peers.length;
    if (removed > 0) {
      logger.info('Cleaned up expired peers', { removed });
      this.scheduleSave();
    }
  }
}

export const peerCacheService = new PeerCacheService();
