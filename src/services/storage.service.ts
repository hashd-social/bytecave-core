/**
 * HASHD Vault - Storage Service
 * 
 * Handles blob and metadata storage using filesystem
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { BlobMetadata, BlobNotFoundError, StorageFullError } from '../types/index.js';

export class StorageService {
  private blobsDir: string;
  private metaDir: string;
  private initialized = false;

  constructor() {
    this.blobsDir = path.join(config.dataDir, 'blobs');
    this.metaDir = path.join(config.dataDir, 'meta');
  }

  /**
   * Initialize storage directories
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.blobsDir, { recursive: true });
      await fs.mkdir(this.metaDir, { recursive: true });
      
      logger.info('Storage directories initialized', {
        blobsDir: this.blobsDir,
        metaDir: this.metaDir
      });

      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize storage', error);
      throw error;
    }
  }

  /**
   * Store a blob
   */
  async storeBlob(
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    replicationMeta?: { fromPeer: string }
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
      // Write blob atomically (temp file + rename)
      const tempPath = `${blobPath}.tmp`;
      await fs.writeFile(tempPath, ciphertext);
      await fs.rename(tempPath, blobPath);

      // Create metadata
      const metadata: BlobMetadata = {
        cid,
        size: ciphertext.length,
        mimeType,
        createdAt: Date.now(),
        version: 1, // Schema version
        replication: replicationMeta ? {
          fromPeer: replicationMeta.fromPeer,
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

    const blobPath = this.getBlobPath(cid);
    const metaPath = this.getMetaPath(cid);

    try {
      const [ciphertext, metaContent] = await Promise.all([
        fs.readFile(blobPath),
        fs.readFile(metaPath, 'utf-8')
      ]);

      const metadata: BlobMetadata = JSON.parse(metaContent);

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
   */
  async getMetadata(cid: string): Promise<BlobMetadata> {
    await this.ensureInitialized();

    const metaPath = this.getMetaPath(cid);

    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new BlobNotFoundError(cid);
      }
      throw error;
    }
  }

  /**
   * Update metadata
   */
  async updateMetadata(cid: string, updates: Partial<BlobMetadata>): Promise<void> {
    await this.ensureInitialized();

    const metaPath = this.getMetaPath(cid);

    try {
      const metadata = await this.getMetadata(cid);
      const updated = { ...metadata, ...updates };
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
  async getStats(): Promise<{ blobCount: number; totalSize: number }> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.blobsDir);
      let totalSize = 0;

      for (const file of files) {
        if (file.endsWith('.tmp')) continue;
        const filePath = path.join(this.blobsDir, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }

      return {
        blobCount: files.filter(f => !f.endsWith('.tmp')).length,
        totalSize
      };
    } catch (error) {
      logger.error('Failed to get storage stats', error);
      return { blobCount: 0, totalSize: 0 };
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
