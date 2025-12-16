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
import { BlockedContent } from '../types/index.js';

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
  async addCid(cid: string, reason?: string): Promise<void> {
    if (!this.blockedContent) {
      this.blockedContent = this.getDefault();
    }

    if (!this.blockedContent.cids.includes(cid.toLowerCase())) {
      this.blockedContent.cids.push(cid.toLowerCase());
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('CID added to blocked content', { cid, reason });
    }
  }

  /**
   * Remove CID from blocked list
   */
  async removeCid(cid: string): Promise<void> {
    if (!this.blockedContent) return;

    const index = this.blockedContent.cids.indexOf(cid.toLowerCase());
    if (index > -1) {
      this.blockedContent.cids.splice(index, 1);
      this.blockedContent.updatedAt = Date.now();

      await this.save();
      logger.info('CID removed from blocked content', { cid });
    }
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
      cids: []
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
