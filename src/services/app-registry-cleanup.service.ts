/**
 * HASHD Vault - App Registry Cleanup Service
 * 
 * Handles cleanup of unauthorized blobs when REQUIRE_APP_REGISTRY changes from false to true
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';

export class AppRegistryCleanupService {
  private initialized = false;
  private lastRequireAppRegistry: boolean | null = null;

  /**
   * Initialize the cleanup service and check for config changes
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Store the initial state
      this.lastRequireAppRegistry = config.requireAppRegistry;
      
      logger.info('App registry cleanup service initialized', {
        requireAppRegistry: config.requireAppRegistry,
        allowedApps: config.allowedApps
      });

      this.initialized = true;
    } catch (error: any) {
      logger.error('Failed to initialize app registry cleanup service', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Check if config has changed and cleanup if needed
   * Should be called periodically or on config reload
   */
  async checkAndCleanup(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentRequireAppRegistry = config.requireAppRegistry;

    // Check if REQUIRE_APP_REGISTRY changed from false to true
    if (this.lastRequireAppRegistry === false && currentRequireAppRegistry === true) {
      logger.warn('REQUIRE_APP_REGISTRY changed from false to true - starting cleanup of unauthorized blobs', {
        allowedApps: config.allowedApps
      });

      await this.cleanupUnauthorizedBlobs();
    }

    // Update the last known state
    this.lastRequireAppRegistry = currentRequireAppRegistry;
  }

  /**
   * Remove all blobs that are not from allowed apps
   */
  async cleanupUnauthorizedBlobs(): Promise<void> {
    try {
      const blobs = await storageService.listBlobs();
      let removedCount = 0;
      let keptCount = 0;
      let errorCount = 0;

      logger.info('Starting cleanup of unauthorized blobs', {
        totalBlobs: blobs.length,
        allowedApps: config.allowedApps
      });

      for (const blob of blobs) {
        try {
          // Skip if blob has no appId (legacy blobs or system blobs)
          if (!blob.appId) {
            logger.debug('Skipping blob without appId', { cid: blob.cid });
            keptCount++;
            continue;
          }

          // Check if app is in allowed list
          if (!config.allowedApps.includes(blob.appId)) {
            logger.info('Removing unauthorized blob', {
              cid: blob.cid,
              appId: blob.appId,
              allowedApps: config.allowedApps
            });

            await storageService.deleteBlob(blob.cid);
            removedCount++;
          } else {
            keptCount++;
          }
        } catch (error: any) {
          logger.error('Failed to process blob during cleanup', {
            cid: blob.cid,
            error: error.message
          });
          errorCount++;
        }
      }

      logger.info('Completed cleanup of unauthorized blobs', {
        total: blobs.length,
        removed: removedCount,
        kept: keptCount,
        errors: errorCount
      });
    } catch (error: any) {
      logger.error('Failed to cleanup unauthorized blobs', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Manually trigger cleanup (for testing or admin operations)
   */
  async forceCleanup(): Promise<void> {
    logger.warn('Force cleanup triggered - removing all unauthorized blobs');
    await this.cleanupUnauthorizedBlobs();
  }
}

export const appRegistryCleanupService = new AppRegistryCleanupService();
