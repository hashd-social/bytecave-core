/**
 * HASHD Vault - Storage Service
 * 
 * Handles blob and metadata storage using filesystem
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { generateMetadataIntegrityHash, verifyMetadataIntegrity } from '../utils/cid.js';
import { BlobMetadata, BlobNotFoundError, StorageFullError } from '../types/index.js';
import { cacheService } from './cache.service.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class StorageService {
  private blobsDir: string;
  private metaDir: string;
  private initialized = false;

  constructor() {
    this.blobsDir = path.join(config.dataDir, 'blobs');
    this.metaDir = path.join(config.dataDir, 'meta');
  }

  /**
   * Initialize storage service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create directories
      await fs.mkdir(this.blobsDir, { recursive: true });
      await fs.mkdir(this.metaDir, { recursive: true });

      // Create environment marker file for safety checks
      await this.createEnvironmentMarker();

      this.initialized = true;
      logger.info('Storage service initialized', {
        blobsDir: this.blobsDir,
        metaDir: this.metaDir,
        environment: config.nodeEnv
      });
    } catch (error) {
      logger.error('Failed to initialize storage service', error);
      throw error;
    }
  }

  /**
   * Create environment marker file
   * 
   * SECURITY: Creates a marker file that identifies the environment
   * - Helps detect if data directory was manually moved
   * - Prevents dev nodes from accidentally using production data
   * - Provides recovery information if data is deleted
   */
  private async createEnvironmentMarker(): Promise<void> {
    const markerPath = path.join(config.dataDir, '.vault-environment');
    
    try {
      // Check if marker exists
      const exists = await fs.access(markerPath).then(() => true).catch(() => false);
      
      if (exists) {
        // Read existing marker
        const existingMarker = JSON.parse(await fs.readFile(markerPath, 'utf-8'));
        
        // CRITICAL: Detect environment mismatch
        if (existingMarker.environment !== config.nodeEnv) {
          const isDangerousMismatch = 
            (existingMarker.environment === 'production' && config.nodeEnv === 'development') ||
            (existingMarker.environment === 'production' && config.nodeEnv === 'test');
          
          if (isDangerousMismatch) {
            throw new Error(
              `⛔ ENVIRONMENT MISMATCH DETECTED!\n` +
              `Data directory was created in: ${existingMarker.environment}\n` +
              `Current NODE_ENV: ${config.nodeEnv}\n` +
              `This prevents dev nodes from accessing production data.\n` +
              `If this is intentional, delete ${markerPath} and restart.`
            );
          } else {
            logger.warn('Environment changed', {
              previous: existingMarker.environment,
              current: config.nodeEnv,
              dataDir: config.dataDir
            });
          }
        }
      }
      
      // Create/update marker
      const marker = {
        environment: config.nodeEnv,
        nodeId: config.nodeId,
        createdAt: exists ? JSON.parse(await fs.readFile(markerPath, 'utf-8')).createdAt : Date.now(),
        lastStarted: Date.now(),
        version: '1.0.0'
      };
      
      await fs.writeFile(markerPath, JSON.stringify(marker, null, 2));
      
      // Make it read-only in production
      if (config.nodeEnv === 'production') {
        await fs.chmod(markerPath, 0o444); // Read-only
      }
    } catch (error: any) {
      if (error.message.includes('ENVIRONMENT MISMATCH')) {
        throw error; // Re-throw security errors
      }
      logger.warn('Failed to create environment marker', error);
    }
  }

  /**
   * Store a blob with application metadata (v2)
   */
  async storeBlob(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: { 
      fromPeer?: string;
      appId?: string;
      contentType?: string;
      sender?: string;
      timestamp?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    await this.ensureInitialized();
    await this.checkStorageCapacity();

    const blobPath = this.getBlobPath(cid);
    const metaPath = this.getMetaPath(cid);

    // Check if already exists
    const exists = await this.hasBlob(cid);
    if (exists) {
      logger.debug('Blob already exists', { cid });
      return;
    }

    try {
      // Compress if enabled
      let dataToStore = ciphertext;
      let compressed = false;
      
      if (config.compressionEnabled) {
        try {
          const compressedData = await gzip(ciphertext);
          // Only use compression if it actually reduces size
          if (compressedData.length < ciphertext.length) {
            dataToStore = compressedData;
            compressed = true;
            logger.debug('Blob compressed', { 
              cid, 
              originalSize: ciphertext.length, 
              compressedSize: compressedData.length,
              ratio: Math.round((compressedData.length / ciphertext.length) * 100) + '%'
            });
          }
        } catch (err) {
          logger.warn('Compression failed, storing uncompressed', { cid, error: err });
        }
      }

      // Write blob atomically (temp file + rename)
      const tempPath = `${blobPath}.tmp`;
      await fs.writeFile(tempPath, dataToStore);
      await fs.rename(tempPath, blobPath);

      // Create metadata (v2 - with application metadata)
      const createdAt = Date.now();
      const metadata: BlobMetadata = {
        cid,
        size: ciphertext.length,
        mimeType,
        createdAt,
        version: 2, // Schema version (2 = with appId metadata)
        compressed, // Track if blob is compressed
        // SECURITY: Generate integrity hash to detect metadata tampering
        integrityHash: generateMetadataIntegrityHash(cid, ciphertext.length, mimeType, createdAt, false),
        // Application metadata (v2)
        appId: options?.appId,
        contentType: options?.contentType,
        sender: options?.sender,
        timestamp: options?.timestamp,
        metadata: options?.metadata,
        replication: options?.fromPeer ? {
          fromPeer: options.fromPeer,
          replicatedAt: Date.now(),
          replicatedTo: []
        } : {
          replicatedTo: []
        },
        metrics: {
          retrievalCount: 0,
          lastAccessed: Date.now(),
          avgLatency: 0
        }
      };

      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

      logger.info('Blob stored', { cid, size: ciphertext.length });
    } catch (error) {
      logger.error('Failed to store blob', error, { cid });
      // Cleanup on failure
      try {
        await fs.unlink(blobPath).catch(() => {});
        await fs.unlink(metaPath).catch(() => {});
      } catch {}
      throw error;
    }
  }

  /**
   * Get a blob
   */
  async getBlob(cid: string): Promise<{ ciphertext: Buffer; metadata: BlobMetadata }> {
    await this.ensureInitialized();

    // Check cache first
    const cached = cacheService.get(cid);
    if (cached) {
      const metaPath = this.getMetaPath(cid);
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const metadata: BlobMetadata = JSON.parse(metaContent);
      
      // Update access metrics
      this.updateAccessMetrics(cid, metadata).catch(err => 
        logger.warn('Failed to update access metrics', { cid, error: err.message })
      );
      
      return { ciphertext: cached, metadata };
    }

    const blobPath = this.getBlobPath(cid);
    const metaPath = this.getMetaPath(cid);

    try {
      const [storedData, metaContent] = await Promise.all([
        fs.readFile(blobPath),
        fs.readFile(metaPath, 'utf-8')
      ]);

      const metadata: BlobMetadata = JSON.parse(metaContent);

      // Decompress if needed
      let ciphertext = storedData;
      if (metadata.compressed) {
        try {
          ciphertext = await gunzip(storedData);
        } catch (err) {
          logger.error('Decompression failed', { cid, error: err });
          throw new Error('Failed to decompress blob');
        }
      }

      // Cache the uncompressed data
      cacheService.set(cid, ciphertext);

      // Update access metrics
      this.updateAccessMetrics(cid, metadata).catch(err => 
        logger.warn('Failed to update access metrics', { cid, error: err.message })
      );

      return { ciphertext, metadata };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new BlobNotFoundError(cid);
      }
      logger.error('Failed to read blob', error, { cid });
      throw error;
    }
  }

  /**
   * Check if blob exists
   */
  async hasBlob(cid: string): Promise<boolean> {
    await this.ensureInitialized();
    
    const blobPath = this.getBlobPath(cid);
    try {
      await fs.access(blobPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a blob (soft delete - move to trash)
   */
  async deleteBlob(cid: string): Promise<void> {
    await this.ensureInitialized();

    const blobPath = this.getBlobPath(cid);
    const metaPath = this.getMetaPath(cid);

    try {
      // Remove from cache
      cacheService.delete(cid);
      
      await Promise.all([
        fs.unlink(blobPath),
        fs.unlink(metaPath)
      ]);

      logger.info('Blob deleted', { cid });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new BlobNotFoundError(cid);
      }
      logger.error('Failed to delete blob', error, { cid });
      throw error;
    }
  }

  /**
   * Get metadata
   * SECURITY: Verifies integrity hash to detect tampering
   */
  async getMetadata(cid: string): Promise<BlobMetadata> {
    await this.ensureInitialized();

    const metaPath = this.getMetaPath(cid);

    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      const metadata = JSON.parse(content) as BlobMetadata;
      
      // SECURITY: Verify metadata integrity
      const integrity = verifyMetadataIntegrity(metadata);
      if (!integrity.valid) {
        logger.error('SECURITY: Metadata tampering detected', { 
          cid, 
          reason: integrity.reason 
        });
        throw new Error(`METADATA_TAMPERED: Integrity check failed for ${cid}`);
      }
      
      if (integrity.reason === 'legacy_no_hash') {
        logger.debug('Legacy metadata without integrity hash', { cid });
      }
      
      return metadata;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new BlobNotFoundError(cid);
      }
      throw error;
    }
  }

  /**
   * Update metadata
   * SECURITY: Regenerates integrity hash if critical fields change
   */
  async updateMetadata(cid: string, updates: Partial<BlobMetadata>): Promise<void> {
    await this.ensureInitialized();

    const metaPath = this.getMetaPath(cid);

    try {
      const metadata = await this.getMetadata(cid);
      const updated = { ...metadata, ...updates };
      
      // SECURITY: Regenerate integrity hash if critical fields changed
      if ('pinned' in updates || 'size' in updates || 'mimeType' in updates) {
        updated.integrityHash = generateMetadataIntegrityHash(
          updated.cid,
          updated.size,
          updated.mimeType,
          updated.createdAt,
          updated.pinned || false
        );
      }
      
      await fs.writeFile(metaPath, JSON.stringify(updated, null, 2));
    } catch (error) {
      logger.error('Failed to update metadata', error, { cid });
      throw error;
    }
  }

  /**
   * List all blobs
   */
  async listBlobs(): Promise<BlobMetadata[]> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.metaDir);
      const blobs: BlobMetadata[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const cid = file.replace('.json', '');
        try {
          const metadata = await this.getMetadata(cid);
          blobs.push(metadata);
        } catch (error) {
          logger.warn('Failed to read metadata for blob', { cid, error });
        }
      }

      // Sort by creation time (newest first)
      blobs.sort((a, b) => b.createdAt - a.createdAt);

      return blobs;
    } catch (error) {
      logger.error('Failed to list blobs', error);
      return [];
    }
  }

  /**
   * Pin a blob (R9.3, R9.6)
   * Makes blob permanent and immune to GC
   */
  async pinBlob(cid: string): Promise<void> {
    await this.ensureInitialized();

    const metadata = await this.getMetadata(cid);
    metadata.pinned = true;
    
    await this.updateMetadata(cid, { pinned: true });

    logger.info('Blob pinned', { cid });
  }

  /**
   * Unpin a blob (R9.3, R9.6)
   * Makes blob eligible for GC again
   */
  async unpinBlob(cid: string): Promise<void> {
    await this.ensureInitialized();

    const metadata = await this.getMetadata(cid);
    metadata.pinned = false;
    
    await this.updateMetadata(cid, { pinned: false });

    logger.info('Blob unpinned', { cid });
  }

  /**
   * List all pinned blobs (R9.7)
   */
  async listPinnedBlobs(): Promise<BlobMetadata[]> {
    await this.ensureInitialized();

    const allBlobs = await this.listBlobs();
    return allBlobs.filter(blob => blob.pinned === true);
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{ blobCount: number; totalSize: number; pinnedCount?: number; pinnedSize?: number }> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.blobsDir);
      let totalSize = 0;
      let pinnedCount = 0;
      let pinnedSize = 0;

      for (const file of files) {
        if (file.endsWith('.tmp')) continue;
        const filePath = path.join(this.blobsDir, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        
        // Check if pinned
        const cid = file.replace('.enc', '');
        try {
          const metadata = await this.getMetadata(cid);
          if (metadata.pinned) {
            pinnedCount++;
            pinnedSize += stats.size;
          }
        } catch {
          // Ignore metadata read errors
        }
      }

      return {
        blobCount: files.filter(f => !f.endsWith('.tmp')).length,
        totalSize,
        pinnedCount,
        pinnedSize
      };
    } catch (error) {
      logger.error('Failed to get storage stats', error);
      return { blobCount: 0, totalSize: 0, pinnedCount: 0, pinnedSize: 0 };
    }
  }

  /**
   * Get free disk space in bytes
   */
  async getFreeDiskSpace(): Promise<number> {
    await this.ensureInitialized();
    
    try {
      // Use Node.js fs.statfs (available in Node 18+) or fallback to platform-specific commands
      const { statfs } = await import('fs/promises');
      const stats = await (statfs as any)(config.dataDir);
      return stats.bavail * stats.bsize; // Available blocks * block size
    } catch (error) {
      // Fallback: use platform-specific command
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      try {
        if (process.platform === 'win32') {
          // Windows: use wmic
          const { stdout } = await execAsync(`wmic logicaldisk where "DeviceID='${config.dataDir.charAt(0)}:'" get FreeSpace`);
          const match = stdout.match(/\d+/);
          return match ? parseInt(match[0]) : 0;
        } else {
          // Unix/Linux/Mac: use df
          const { stdout } = await execAsync(`df -k "${config.dataDir}" | tail -1 | awk '{print $4}'`);
          return parseInt(stdout.trim()) * 1024; // Convert KB to bytes
        }
      } catch (cmdError) {
        logger.warn('Failed to get free disk space', cmdError);
        return 0;
      }
    }
  }

  /**
   * Private helper methods
   */

  private getBlobPath(cid: string): string {
    return path.join(this.blobsDir, `${cid}.enc`);
  }

  private getMetaPath(cid: string): string {
    return path.join(this.metaDir, `${cid}.json`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async checkStorageCapacity(): Promise<void> {
    const stats = await this.getStats();
    const maxSizeBytes = config.maxStorageGB * 1024 * 1024 * 1024;

    if (stats.totalSize >= maxSizeBytes) {
      throw new StorageFullError();
    }
  }

  private async updateAccessMetrics(cid: string, metadata: BlobMetadata): Promise<void> {
    if (!metadata.metrics) {
      metadata.metrics = {
        retrievalCount: 0,
        lastAccessed: Date.now(),
        avgLatency: 0
      };
    }

    metadata.metrics.retrievalCount++;
    metadata.metrics.lastAccessed = Date.now();

    await this.updateMetadata(cid, { metrics: metadata.metrics });
  }
}

export const storageService = new StorageService();
