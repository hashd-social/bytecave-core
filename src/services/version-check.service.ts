/**
 * Version Check Service
 * 
 * Monitors node version against contract minVersion and enforces version requirements.
 * Nodes below minVersion enter OUTDATED status and cannot participate in storage/replication.
 */

import { logger } from '../utils/logger.js';
import { contractIntegrationService } from './contract-integration.service.js';

const VERSION = '1.0.0';

export class VersionCheckService {
  private minVersion: string | null = null;
  private isOutdated: boolean = false;
  private isOutdatedWarning: boolean = false; // Patch version mismatch only
  private checkInterval: NodeJS.Timeout | null = null;

  /**
   * Start version monitoring
   */
  async start(): Promise<void> {
    logger.info('Starting version check service');

    // Initial check
    await this.checkVersion();

    // Check every 5 minutes
    this.checkInterval = setInterval(() => {
      this.checkVersion().catch((err: Error) =>
        logger.error('Failed to check version', err)
      );
    }, 300000);
  }

  /**
   * Stop version monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Version check service stopped');
  }

  /**
   * Check if node version meets minimum requirement
   */
  private async checkVersion(): Promise<void> {
    if (!contractIntegrationService.isInitialized()) {
      return;
    }

    try {
      const minVer = await contractIntegrationService.getMinVersion();
      
      if (!minVer) {
        // No minimum version set in contract
        this.minVersion = null;
        this.isOutdated = false;
        this.isOutdatedWarning = false;
        return;
      }

      this.minVersion = minVer;
      const wasOutdated = this.isOutdated;
      const wasOutdatedWarning = this.isOutdatedWarning;
      
      const severity = this.getVersionMismatchSeverity(VERSION, minVer);

      // ONLY major version mismatch blocks operations
      this.isOutdated = severity === 'major';
      
      // Minor or patch version mismatch = WARNING (shows warning but doesn't block)
      this.isOutdatedWarning = severity === 'minor' || severity === 'patch';

      // Log status changes
      if (!wasOutdated && this.isOutdated) {
        logger.warn('='.repeat(60));
        logger.warn('NODE VERSION OUTDATED - OPERATIONS BLOCKED');
        logger.warn(`Current version: ${VERSION}`);
        logger.warn(`Required version: ${minVer}`);
        logger.warn('MAJOR version mismatch - storage and replication disabled');
        logger.warn('Please update to continue participating in the network');
        logger.warn('='.repeat(60));
      } else if (!wasOutdatedWarning && this.isOutdatedWarning) {
        logger.warn('='.repeat(60));
        logger.warn('NODE VERSION OUTDATED - WARNING ONLY');
        logger.warn(`Current version: ${VERSION}`);
        logger.warn(`Required version: ${minVer}`);
        logger.warn(`${severity === 'minor' ? 'Minor' : 'Patch'} version mismatch - operations continue normally`);
        logger.warn('Please update when convenient');
        logger.warn('='.repeat(60));
      } else if (wasOutdated && !this.isOutdated && !this.isOutdatedWarning) {
        logger.info('Node version is now up to date - resuming normal operations');
      } else if (wasOutdatedWarning && !this.isOutdated && !this.isOutdatedWarning) {
        logger.info('Node version is now up to date');
      }
    } catch (error) {
      logger.error('Failed to check version against contract', error);
    }
  }

  /**
   * Check version mismatch severity
   * Returns: 'none' | 'patch' | 'minor' | 'major'
   */
  private getVersionMismatchSeverity(current: string, required: string): 'none' | 'patch' | 'minor' | 'major' {
    const currentParts = current.split('.').map(Number);
    const requiredParts = required.split('.').map(Number);

    const [currentMajor = 0, currentMinor = 0, currentPatch = 0] = currentParts;
    const [requiredMajor = 0, requiredMinor = 0, requiredPatch = 0] = requiredParts;

    // Major version mismatch (x.0.0)
    if (currentMajor < requiredMajor) {
      return 'major';
    }

    // Minor version mismatch (1.x.0)
    if (currentMajor === requiredMajor && currentMinor < requiredMinor) {
      return 'minor';
    }

    // Patch version mismatch (1.0.x)
    if (currentMajor === requiredMajor && currentMinor === requiredMinor && currentPatch < requiredPatch) {
      return 'patch';
    }

    return 'none';
  }

  /**
   * Check if node is outdated
   */
  isNodeOutdated(): boolean {
    return this.isOutdated;
  }

  /**
   * Get minimum required version from contract
   */
  getMinVersion(): string | null {
    return this.minVersion;
  }

  /**
   * Get current node version
   */
  getCurrentVersion(): string {
    return VERSION;
  }

  /**
   * Get version status for health checks
   */
  getVersionStatus(): {
    current: string;
    minimum: string | null;
    outdated: boolean;
    outdatedWarning: boolean;
  } {
    return {
      current: VERSION,
      minimum: this.minVersion,
      outdated: this.isOutdated,
      outdatedWarning: this.isOutdatedWarning
    };
  }
}

export const versionCheckService = new VersionCheckService();
