/**
 * ByteCave - Blocked Content Service
 * 
 * Manages CIDs that this node operator chooses not to store/serve.
 * This is a local preference, not network-wide moderation.
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getConfigManager } from '../config/config-manager.js';

interface BlockedContent {
  version: number;
  updatedAt: number;
  cids: string[];
  peerIds: string[];
}

export class BlockedContentService {
  private blockedContent: BlockedContent | null = null;
  private lastLoad: number = 0;
  private readonly RELOAD_INTERVAL = 5000; // 5 seconds - check for config changes frequently
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Blocked content is now stored in config.json
  }

  /**
   * Initialize blocked content list
   */
  async initialize(): Promise<void> {
    if (!config.enableBlockedContent) {
      logger.info('Blocked content filtering disabled');
      return;
    }

    await this.load();
    
    // Clean up any blocked CIDs that are still in storage
    if (this.blockedContent && this.blockedContent.cids.length > 0) {
      await this.cleanupBlockedContent();
    }
    
    // Start periodic reload to detect config changes
    this.startPeriodicReload();
  }
  
  /**
   * Start periodic reload timer
   */
  private startPeriodicReload(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
    }
    
    this.reloadTimer = setInterval(async () => {
      try {
        await this.reload();
      } catch (error) {
        logger.error('Failed to reload blocked content', error);
      }
    }, this.RELOAD_INTERVAL);
  }
  
  /**
   * Stop periodic reload timer
   */
  stop(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
  
  /**
   * Delete all blocked CIDs from storage
   */
  private async cleanupBlockedContent(): Promise<void> {
    if (!this.blockedContent) return;
    
    for (const cid of this.blockedContent.cids) {
      try {
        const { storageService } = await import('./storage.service.js');
        await storageService.deleteBlob(cid);
        logger.info('Blocked CID removed from storage during cleanup', { cid });
      } catch (error: any) {
        // Ignore if blob doesn't exist (already deleted)
        if (error.code !== 'ENOENT') {
          logger.error('Failed to delete blocked CID during cleanup', { 
            cid, 
            error: error.message 
          });
        }
      }
    }
    
    // Log final stats
    try {
      const { storageService } = await import('./storage.service.js');
      const stats = await storageService.getStats();
      logger.info('Storage stats after blocked content cleanup', { 
        blobCount: stats.blobCount, 
        totalSize: stats.totalSize 
      });
    } catch (error) {
      logger.error('Failed to get storage stats after cleanup', error);
    }
  }

  /**
   * Check if CID is blocked
   */
  async isBlocked(cid: string): Promise<boolean> {
    if (!config.enableBlockedContent || !this.blockedContent) {
      return false;
    }

    // Reload if stale
    if (Date.now() - this.lastLoad > this.RELOAD_INTERVAL) {
      await this.load().catch(err => 
        logger.warn('Failed to reload blocked content', { error: err.message })
      );
    }

    return this.blockedContent.cids.includes(cid.toLowerCase());
  }

  async isPeerBlocked(peerId: string): Promise<boolean> {
    if (!this.blockedContent) {
      return false;
    }

    // Reload if stale
    if (Date.now() - this.lastLoad > this.RELOAD_INTERVAL) {
      await this.load().catch(err => 
        logger.warn('Failed to reload blocked content', { error: err.message })
      );
    }

    return this.blockedContent.peerIds.includes(peerId);
  }

  /**
   * Load blocked content from config.json
   */
  async load(): Promise<void> {
    try {
      const configManager = getConfigManager();
      const persistedConfig = configManager.getConfig();
      
      this.blockedContent = {
        version: 1,
        updatedAt: persistedConfig.lastUpdated || Date.now(),
        cids: persistedConfig.blockedCids || [],
        peerIds: persistedConfig.blockedPeerIds || []
      };
      
      this.lastLoad = Date.now();

      logger.info('Blocked content loaded', {
        cids: this.blockedContent.cids.length,
        peers: this.blockedContent.peerIds.length
      });
    } catch (error) {
      logger.error('Failed to load blocked content', error);
      this.blockedContent = this.getDefault();
    }
  }

  /**
   * Reload blocked content and cleanup any newly blocked CIDs
   */
  async reload(): Promise<void> {
    const oldCids = this.blockedContent?.cids || [];
    const oldPeerIds = this.blockedContent?.peerIds || [];
    await this.load();
    
    // Check if new CIDs were added
    const newCids = this.blockedContent?.cids || [];
    const newPeerIds = this.blockedContent?.peerIds || [];
    const addedCids = newCids.filter(cid => !oldCids.includes(cid));
    const removedCids = oldCids.filter(cid => !newCids.includes(cid));
    const removedPeerIds = oldPeerIds.filter(peerId => !newPeerIds.includes(peerId));
    
    // Clean up newly blocked CIDs
    if (addedCids.length > 0) {
      logger.info('New blocked CIDs detected, triggering cleanup', { count: addedCids.length });
      await this.cleanupBlockedContent();
    }
    
    // Trigger replication for unblocked CIDs or unblocked peers
    if (removedCids.length > 0 || removedPeerIds.length > 0) {
      if (removedCids.length > 0) {
        logger.info('CIDs unblocked, triggering pull sync', { count: removedCids.length, cids: removedCids });
      }
      if (removedPeerIds.length > 0) {
        logger.info('Peers unblocked, triggering pull sync', { count: removedPeerIds.length, peerIds: removedPeerIds });
      }
      
      try {
        const { replicationService } = await import('./replication.service.js');
        await replicationService.pullMissingBlobs();
      } catch (error) {
        logger.error('Failed to trigger pull sync for unblocked content/peers', error);
      }
    }
  }

  /**
   * Add CID to blocked list
   */
  async addCid(cid: string): Promise<void> {
    if (!this.blockedContent) {
      this.blockedContent = this.getDefault();
    }

    const cidLower = cid.toLowerCase();
    if (!this.blockedContent.cids.includes(cidLower)) {
      this.blockedContent.cids.push(cidLower);
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('CID added to blocked list', { cid });
      
      // Immediately delete the blob from storage
      try {
        const { storageService } = await import('./storage.service.js');
        await storageService.deleteBlob(cidLower);
        logger.info('Blocked CID removed from storage', { cid: cidLower });
        
        // Log updated stats
        const stats = await storageService.getStats();
        logger.info('Storage stats after deletion', { blobCount: stats.blobCount, totalSize: stats.totalSize });
      } catch (error: any) {
        logger.error('Failed to delete blocked CID from storage', { 
          cid: cidLower, 
          error: error.message,
          code: error.code 
        });
      }
    }
  }

  /**
   * Remove CID from blocked list
   */
  async removeCid(cid: string): Promise<void> {
    if (!this.blockedContent) return;

    const cidLower = cid.toLowerCase();
    const index = this.blockedContent.cids.indexOf(cidLower);
    if (index > -1) {
      this.blockedContent.cids.splice(index, 1);
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('CID removed from blocked list', { cid });
    }
  }

  /**
   * Add peer to blocked list
   */
  async addPeer(peerId: string): Promise<void> {
    if (!this.blockedContent) {
      this.blockedContent = this.getDefault();
    }

    if (!this.blockedContent.peerIds.includes(peerId)) {
      this.blockedContent.peerIds.push(peerId);
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('Peer added to blocked list', { peerId });
      
      // Immediately disconnect from the blocked peer
      try {
        const { p2pService } = await import('./p2p.service.js');
        const node = (p2pService as any).node;
        if (node) {
          const connections = node.getConnections();
          for (const conn of connections) {
            if (conn.remotePeer.toString() === peerId) {
              await conn.close();
              logger.info('Disconnected from blocked peer', { peerId });
            }
          }
        }
      } catch (error) {
        logger.error('Failed to disconnect from blocked peer', { peerId, error });
      }
    }
  }

  /**
   * Remove peer from blocked list
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this.blockedContent) return;

    const index = this.blockedContent.peerIds.indexOf(peerId);
    if (index > -1) {
      this.blockedContent.peerIds.splice(index, 1);
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('Peer removed from blocked list', { peerId });
    }
  }

  /**
   * Get all blocked content
   */
  getBlocked(): BlockedContent | null {
    return this.blockedContent;
  }

  /**
   * Get stats
   */
  getStats(): { totalBlocked: number; lastUpdated: number } {
    return {
      totalBlocked: this.blockedContent?.cids.length || 0,
      lastUpdated: this.blockedContent?.updatedAt || 0
    };
  }

  /**
   * Private helper methods
   */

  private getDefault(): BlockedContent {
    return {
      version: 1,
      updatedAt: Date.now(),
      cids: [],
      peerIds: []
    };
  }

  private async save(): Promise<void> {
    if (!this.blockedContent) return;

    const configManager = getConfigManager();
    configManager.updateNodeConfig({
      blockedCids: this.blockedContent.cids,
      blockedPeerIds: this.blockedContent.peerIds,
      lastUpdated: Date.now()
    });
  }
}

export const blockedContentService = new BlockedContentService();
