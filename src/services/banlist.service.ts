/**
 * HASHD Vault - Banlist Service
 * 
 * Manages content banlist for legal compliance
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Banlist } from '../types/index.js';

export class BanlistService {
  private banlist: Banlist | null = null;
  private banlistPath: string;
  private lastLoad: number = 0;
  private readonly RELOAD_INTERVAL = 60000; // 1 minute

  constructor() {
    this.banlistPath = path.join(process.cwd(), 'config', 'banlist.json');
  }

  /**
   * Initialize banlist
   */
  async initialize(): Promise<void> {
    if (!config.enableBanlist) {
      logger.info('Banlist disabled');
      return;
    }

    await this.loadBanlist();
  }

  /**
   * Check if CID is banned
   */
  async isBanned(cid: string): Promise<boolean> {
    if (!config.enableBanlist || !this.banlist) {
      return false;
    }

    // Reload if stale
    if (Date.now() - this.lastLoad > this.RELOAD_INTERVAL) {
      await this.loadBanlist().catch(err => 
        logger.warn('Failed to reload banlist', { error: err.message })
      );
    }

    return this.banlist.cids.includes(cid.toLowerCase());
  }

  /**
   * Load banlist from file
   */
  async loadBanlist(): Promise<void> {
    try {
      // Check if file exists
      try {
        await fs.access(this.banlistPath);
      } catch {
        // Create default banlist if doesn't exist
        await this.createDefaultBanlist();
      }

      const content = await fs.readFile(this.banlistPath, 'utf-8');
      this.banlist = JSON.parse(content);
      this.lastLoad = Date.now();

      logger.info('Banlist loaded', {
        cids: this.banlist?.cids.length || 0,
        version: this.banlist?.version
      });

      // Optionally sync from remote
      if (config.banlistSyncUrl) {
        this.syncFromRemote().catch(err =>
          logger.warn('Failed to sync banlist from remote', { error: err.message })
        );
      }
    } catch (error) {
      logger.error('Failed to load banlist', error);
      // Use empty banlist on error
      this.banlist = this.getDefaultBanlist();
    }
  }

  /**
   * Reload banlist
   */
  async reloadBanlist(): Promise<void> {
    await this.loadBanlist();
  }

  /**
   * Add CID to banlist
   */
  async addToBanlist(cid: string, reason: string): Promise<void> {
    if (!this.banlist) {
      this.banlist = this.getDefaultBanlist();
    }

    if (!this.banlist.cids.includes(cid.toLowerCase())) {
      this.banlist.cids.push(cid.toLowerCase());
      this.banlist.updatedAt = Date.now();
      this.banlist.reason = reason;

      await this.saveBanlist();
      logger.info('CID added to banlist', { cid, reason });
    }
  }

  /**
   * Remove CID from banlist
   */
  async removeFromBanlist(cid: string): Promise<void> {
    if (!this.banlist) return;

    const index = this.banlist.cids.indexOf(cid.toLowerCase());
    if (index > -1) {
      this.banlist.cids.splice(index, 1);
      this.banlist.updatedAt = Date.now();

      await this.saveBanlist();
      logger.info('CID removed from banlist', { cid });
    }
  }

  /**
   * Get banlist stats
   */
  getStats(): { totalBanned: number; lastUpdated: number } {
    return {
      totalBanned: this.banlist?.cids.length || 0,
      lastUpdated: this.banlist?.updatedAt || 0
    };
  }

  /**
   * Private helper methods
   */

  private getDefaultBanlist(): Banlist {
    return {
      version: 1,
      updatedAt: Date.now(),
      cids: [],
      tagIDs: [],
      userIDs: [],
      reason: 'Legal compliance',
      authority: 'Node Operator'
    };
  }

  private async createDefaultBanlist(): Promise<void> {
    const configDir = path.dirname(this.banlistPath);
    await fs.mkdir(configDir, { recursive: true });

    const defaultBanlist = this.getDefaultBanlist();
    await fs.writeFile(
      this.banlistPath,
      JSON.stringify(defaultBanlist, null, 2)
    );

    logger.info('Created default banlist', { path: this.banlistPath });
  }

  private async saveBanlist(): Promise<void> {
    if (!this.banlist) return;

    await fs.writeFile(
      this.banlistPath,
      JSON.stringify(this.banlist, null, 2)
    );
  }

  private async syncFromRemote(): Promise<void> {
    if (!config.banlistSyncUrl) return;

    try {
      const response = await fetch(config.banlistSyncUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const remoteBanlist = await response.json() as Banlist;

      // Merge with local banlist
      if (this.banlist) {
        const mergedCIDs = new Set([
          ...this.banlist.cids,
          ...remoteBanlist.cids
        ]);

        this.banlist.cids = Array.from(mergedCIDs);
        this.banlist.updatedAt = Date.now();

        await this.saveBanlist();
        logger.info('Banlist synced from remote', {
          url: config.banlistSyncUrl,
          totalCIDs: this.banlist.cids.length
        });
      }
    } catch (error) {
      logger.warn('Failed to sync banlist from remote', { error });
    }
  }
}

export const banlistService = new BanlistService();
