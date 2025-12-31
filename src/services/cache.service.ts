/**
 * HASHD Vault - Cache Service
 * 
 * Simple LRU cache for frequently accessed blobs
 */

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface CacheEntry {
  data: Buffer;
  size: number;
  timestamp: number;
  accessCount: number;
}

export class CacheService {
  private cache: Map<string, CacheEntry> = new Map();
  private totalSize = 0;
  private maxSizeBytes: number;
  private hits = 0;
  private misses = 0;

  constructor() {
    this.maxSizeBytes = config.cacheSizeMB * 1024 * 1024;
  }

  /**
   * Get item from cache
   */
  get(key: string): Buffer | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.misses++;
      return null;
    }

    // Update access metrics
    entry.accessCount++;
    entry.timestamp = Date.now();
    
    this.hits++;
    return entry.data;
  }

  /**
   * Put item in cache
   */
  set(key: string, data: Buffer): void {
    // Don't cache if caching is effectively disabled (0 MB)
    if (this.maxSizeBytes === 0) {
      return;
    }

    const size = data.length;

    // Don't cache items larger than 10% of cache size
    if (size > this.maxSizeBytes * 0.1) {
      logger.debug('Item too large for cache', { key, size, maxSize: this.maxSizeBytes });
      return;
    }

    // Evict items if necessary
    while (this.totalSize + size > this.maxSizeBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    // Add to cache
    this.cache.set(key, {
      data,
      size,
      timestamp: Date.now(),
      accessCount: 1
    });

    this.totalSize += size;

    logger.debug('Item cached', { key, size, totalSize: this.totalSize, cacheSize: this.cache.size });
  }

  /**
   * Remove item from cache
   */
  delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.totalSize -= entry.size;
    }
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
    this.totalSize = 0;
    this.hits = 0;
    this.misses = 0;
    logger.info('Cache cleared');
  }

  /**
   * Evict least recently used item
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    // Find least recently used item
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.totalSize -= entry.size;
      logger.debug('Evicted from cache', { key: oldestKey, size: entry.size });
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.hits + this.misses > 0 
      ? (this.hits / (this.hits + this.misses)) * 100 
      : 0;

    return {
      size: this.cache.size,
      totalBytes: this.totalSize,
      maxBytes: this.maxSizeBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: Math.round(hitRate * 100) / 100
    };
  }
}

// Singleton instance
export const cacheService = new CacheService();
