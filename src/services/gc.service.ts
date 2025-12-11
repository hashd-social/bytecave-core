/**
 * HASHD Vault - Garbage Collection Service
 * 
 * Implements Requirement 8: Garbage Collection & Retention Policies
 * - Safety checks (R8.1, R8.3)
 * - Retention policies (R8.2)
 * - Metadata tracking (R8.4)
 * - Execution engine (R8.5)
 * - Replication-aware deletion (R8.7)
 * - Priority ordering (R8.8)
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';
import { shouldNodeStoreCid } from '../utils/sharding.js';
import { verifyReplication, formatVerificationResult } from '../utils/replication-verification.js';
import { GCResult, GCStatus, GCCandidate, BlobMetadata } from '../types/index.js';

export class GarbageCollectionService {
  private running = false;
  private lastRun = 0;
  private totalDeleted = 0;
  private totalSkippedPinned = 0;
  private totalSkippedInsufficientReplicas = 0;
  private gcInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize GC service and start periodic execution
   */
  async initialize(): Promise<void> {
    if (!config.gcEnabled) {
      logger.info('Garbage collection disabled');
      return;
    }

    logger.info('Garbage collection initialized', {
      mode: config.gcRetentionMode,
      maxStorageMB: config.gcMaxStorageMB,
      intervalMinutes: config.gcIntervalMinutes
    });

    // Start periodic GC
    this.startPeriodicGC();
  }

  /**
   * Start periodic GC execution (R8.5)
   */
  private startPeriodicGC(): void {
    const intervalMs = config.gcIntervalMinutes * 60 * 1000;

    this.gcInterval = setInterval(async () => {
      try {
        await this.runGC(false);
      } catch (error) {
        logger.error('Periodic GC failed', error);
      }
    }, intervalMs);

    logger.info('Periodic GC started', { intervalMinutes: config.gcIntervalMinutes });
  }

  /**
   * Stop periodic GC
   */
  stop(): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
      logger.info('Periodic GC stopped');
    }
  }

  /**
   * Run garbage collection (R8.5)
   * 
   * @param simulate Dry-run mode - don't actually delete
   * @returns GC result
   */
  async runGC(simulate = false): Promise<GCResult> {
    if (this.running) {
      throw new Error('GC already running');
    }

    this.running = true;
    const startTime = Date.now();

    try {
      logger.info('Starting garbage collection', { simulate, mode: config.gcRetentionMode });

      const result: GCResult = {
        checked: 0,
        deleted: 0,
        skippedPinned: 0,
        skippedInsufficientReplicas: 0,
        skippedShardMismatch: 0,
        freedBytes: 0,
        deletedCids: []
      };

      // Get all blobs
      const allBlobs = await storageService.listBlobs();
      result.checked = allBlobs.length;

      // Get deletion candidates based on retention policy
      const candidates = await this.getDeletionCandidates(allBlobs.map(b => b.cid));

      logger.debug('GC candidates identified', { count: candidates.length });

      // Process each candidate
      for (const candidate of candidates) {
        const canDelete = await this.canSafelyDelete(candidate.cid);

        if (!canDelete.allowed) {
          // Track skip reason
          if (canDelete.reason === 'pinned') {
            result.skippedPinned++;
          } else if (canDelete.reason === 'insufficient_replicas') {
            result.skippedInsufficientReplicas++;
          } else if (canDelete.reason === 'shard_mismatch') {
            result.skippedShardMismatch++;
          }

          logger.debug('Skipping blob deletion', {
            cid: candidate.cid,
            reason: canDelete.reason
          });
          continue;
        }

        // Delete the blob
        if (!simulate) {
          await storageService.deleteBlob(candidate.cid);
        }

        result.deleted++;
        result.freedBytes += candidate.size;
        result.deletedCids.push(candidate.cid);

        logger.info('Blob deleted by GC', {
          cid: candidate.cid,
          size: candidate.size,
          simulate
        });
      }

      // Update stats
      if (!simulate) {
        this.lastRun = Date.now();
        this.totalDeleted += result.deleted;
        this.totalSkippedPinned += result.skippedPinned;
        this.totalSkippedInsufficientReplicas += result.skippedInsufficientReplicas;
      }

      const duration = Date.now() - startTime;

      logger.info('Garbage collection completed', {
        ...result,
        durationMs: duration,
        simulate
      });

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Get deletion candidates based on retention policy (R8.2, R8.8)
   */
  private async getDeletionCandidates(allBlobs: string[]): Promise<GCCandidate[]> {
    const candidates: GCCandidate[] = [];
    const now = Date.now();

    for (const cid of allBlobs) {
      const metadata = await storageService.getMetadata(cid);
      if (!metadata) continue;

      const age = (now - metadata.createdAt) / (24 * 60 * 60 * 1000); // days
      const lastAccessed = metadata.metrics?.lastAccessed || metadata.createdAt;
      const timeSinceAccess = (now - lastAccessed) / (24 * 60 * 60 * 1000);

      // Calculate priority (R8.8)
      // Higher priority = delete first
      let priority = 0;
      priority += age * 10; // Older = higher priority
      priority += timeSinceAccess * 5; // Less accessed = higher priority
      priority += metadata.size / (1024 * 1024); // Larger = slightly higher priority

      if (metadata.pinned) {
        priority = -1000; // Pinned = never delete
      }

      candidates.push({
        cid,
        size: metadata.size,
        age,
        lastAccessed,
        pinned: metadata.pinned || false,
        priority
      });
    }

    // Filter based on retention mode
    let filtered = candidates;

    if (config.gcRetentionMode === 'time' || config.gcRetentionMode === 'hybrid') {
      // Include blobs older than maxBlobAgeDays
      // Keep pinned blobs in the list so they can be properly tracked as skipped
      filtered = filtered.filter(c => c.pinned || c.age > config.gcMaxBlobAgeDays);
    }

    if (config.gcRetentionMode === 'size' || config.gcRetentionMode === 'hybrid') {
      // Check if we're over storage limit
      const stats = await storageService.getStats();
      const usedMB = stats.totalSize / (1024 * 1024);

      if (usedMB > config.gcMaxStorageMB) {
        const excessMB = usedMB - config.gcMaxStorageMB;
        const excessBytes = excessMB * 1024 * 1024;

        // Sort by priority and take enough to free up space
        // Pinned blobs have priority -1000 so they'll be at the end
        const sorted = [...filtered].sort((a, b) => b.priority - a.priority);
        let freedBytes = 0;
        const selected = [];

        for (const candidate of sorted) {
          // Always include pinned blobs so they can be tracked as skipped
          if (candidate.pinned) {
            selected.push(candidate);
            continue;
          }
          
          if (freedBytes < excessBytes) {
            selected.push(candidate);
            freedBytes += candidate.size;
          }
        }
        
        filtered = selected;
      }
    }

    // Sort by priority (highest priority = delete first)
    // Pinned blobs will be at the end with priority -1000
    return filtered.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Check if a blob can be safely deleted (R8.1, R8.3)
   */
  private async canSafelyDelete(cid: string): Promise<{ allowed: boolean; reason?: string }> {
    // R8.3: Safety check pipeline

    // 1. Check if pinned (R8.1)
    const metadata = await storageService.getMetadata(cid);
    if (!metadata) {
      return { allowed: false, reason: 'metadata_missing' };
    }

    if (metadata.pinned) {
      return { allowed: false, reason: 'pinned' };
    }

    // 2. Check shard responsibility (R8.1)
    const belongsToShard = shouldNodeStoreCid(cid, config.nodeShards, config.shardCount);
    if (!belongsToShard) {
      return { allowed: false, reason: 'shard_mismatch' };
    }

    // 3. Check replication factor (R8.1, R8.7)
    const hasEnoughReplicas = await this.checkReplicationFactor(cid, metadata);
    if (!hasEnoughReplicas) {
      return { allowed: false, reason: 'insufficient_replicas' };
    }

    // All checks passed
    return { allowed: true };
  }

  /**
   * Check if replication factor is satisfied (R8.7)
   * 
   * Ensures at least replicationFactor - 1 other nodes have the blob
   * Optionally verifies replicas are online and have valid proofs
   */
  private async checkReplicationFactor(cid: string, metadata: BlobMetadata): Promise<boolean> {
    // Count known replicas from replication metadata
    const replicaNodes = metadata.replication?.replicatedTo || [];
    const knownReplicas = replicaNodes.length;

    // We need at least replicationFactor - 1 other nodes
    // (since we're about to delete our copy)
    const requiredOtherReplicas = config.replicationFactor - 1;

    if (knownReplicas < requiredOtherReplicas) {
      logger.debug('Insufficient replicas for deletion', {
        cid,
        known: knownReplicas,
        required: requiredOtherReplicas
      });
      return false;
    }

    // Enhanced verification: Check if replicas are actually online (R8.7)
    if (config.gcVerifyReplicas && replicaNodes.length > 0) {
      try {
        const verification = await verifyReplication(
          cid,
          replicaNodes,
          requiredOtherReplicas,
          config.gcVerifyProofs
        );

        if (!verification.sufficient) {
          logger.debug('Insufficient active replicas for deletion', {
            cid,
            ...verification,
            summary: formatVerificationResult(verification)
          });
          return false;
        }

        logger.debug('Replication verified for deletion', {
          cid,
          summary: formatVerificationResult(verification)
        });
      } catch (error: any) {
        logger.warn('Replication verification failed, assuming insufficient', {
          cid,
          error: error.message
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Get GC status (R8.6)
   */
  async getStatus(): Promise<GCStatus> {
    const stats = await storageService.getStats();
    const usedMB = stats.totalSize / (1024 * 1024);

    const nextRun = this.lastRun + (config.gcIntervalMinutes * 60 * 1000);

    return {
      enabled: config.gcEnabled,
      retentionMode: config.gcRetentionMode,
      maxStorageMB: config.gcMaxStorageMB,
      usedStorageMB: Math.round(usedMB * 100) / 100,
      lastRun: this.lastRun,
      deletedCount: this.totalDeleted,
      skippedPinned: this.totalSkippedPinned,
      skippedInsufficientReplicas: this.totalSkippedInsufficientReplicas,
      nextRun
    };
  }

  /**
   * Check if GC is currently running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// Singleton instance
export const gcService = new GarbageCollectionService();
