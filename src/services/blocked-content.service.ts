/**
 * HASHD Vault - Blocked Content Service
 * 
 * Manages CIDs that this node operator chooses not to store/serve.
 * This is a local preference, not network-wide moderation.
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface BlockedContent {
  version: number;
  updatedAt: number;
  cids: string[];
  peerIds: string[];
}

export class BlockedContentService {
  private blockedContent: BlockedContent | null = null;
  private configPath: string;
  private lastLoad: number = 0;
  private readonly RELOAD_INTERVAL = 60000; // 1 minute

  constructor() {
    this.configPath = path.join(process.cwd(), 'config', 'blocked-content.json');
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
   * Load blocked content from file
   */
  async load(): Promise<void> {
    try {
      // Check if file exists
      try {
        await fs.access(this.configPath);
      } catch {
        // Create default if doesn't exist
        await this.createDefault();
      }

      const content = await fs.readFile(this.configPath, 'utf-8');
      this.blockedContent = JSON.parse(content);
      this.lastLoad = Date.now();

      logger.info('Blocked content loaded', {
        cids: this.blockedContent?.cids.length || 0
      });
    } catch (error) {
      logger.error('Failed to load blocked content', error);
      this.blockedContent = this.getDefault();
    }
  }

  /**
   * Reload blocked content
   */
  async reload(): Promise<void> {
    await this.load();
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

  private async createDefault(): Promise<void> {
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });

    const defaultContent = this.getDefault();
    await fs.writeFile(
      this.configPath,
      JSON.stringify(defaultContent, null, 2)
    );

    logger.info('Created default blocked-content.json', { path: this.configPath });
  }

  private async save(): Promise<void> {
    if (!this.blockedContent) return;

    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.blockedContent, null, 2)
    );
  }
}

export const blockedContentService = new BlockedContentService();
