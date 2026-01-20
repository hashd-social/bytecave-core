/**
 * ByteCave - App Registry Cleanup Service
 * 
 * Handles cleanup of unauthorized blobs when REQUIRE_APP_REGISTRY changes from false to true
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';

export class AppRegistryCleanupService {
  private initialized = false;
  private lastAllowedApps: string[] | null = null;

  /**
   * Initialize the cleanup service and check for config changes
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Store the initial state
      this.lastAllowedApps = config.allowedApps;
      
      logger.info('App registry cleanup service initialized', {
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
   * Check if config has changed and trigger cleanup if needed
   * Should be called periodically or on config reload
   */
  async checkAndCleanup(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    const currentAllowedApps = config.allowedApps;

    // Check if allowedApps changed (became more restrictive)
    const hasAllowedAppsFilter = currentAllowedApps && currentAllowedApps.length > 0;
    const hadNoFilter = !this.lastAllowedApps || this.lastAllowedApps.length === 0;
    
    if (hadNoFilter && hasAllowedAppsFilter) {
      logger.warn('Allowed apps filter enabled - starting cleanup of unauthorized blobs', {
        allowedApps: currentAllowedApps
      });

      await this.cleanupUnauthorizedBlobs();
    }

    // Update the last known state
    this.lastAllowedApps = currentAllowedApps;
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
