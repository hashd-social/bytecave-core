/**
 * Tests for Cache Service (cacheSizeMB configuration)
 */

import { CacheService } from '../src/services/cache.service.js';

// Mock config
const mockConfig = {
  cacheSizeMB: 10 // 10MB cache for testing
};

jest.mock('../src/config/index.js', () => ({
  config: mockConfig
}));

describe('Cache Service', () => {
  let cacheService: CacheService;

  beforeEach(() => {
    cacheService = new CacheService();
    cacheService.clear();
  });

  describe('Basic Operations', () => {
    test('should store and retrieve items from cache', () => {
      const key = 'test-cid';
      const data = Buffer.from('test data');

      cacheService.set(key, data);
      const retrieved = cacheService.get(key);

      expect(retrieved).toEqual(data);
    });

    test('should return null for cache miss', () => {
      const result = cacheService.get('non-existent');
      expect(result).toBeNull();
    });

    test('should delete items from cache', () => {
      const key = 'test-cid';
      const data = Buffer.from('test data');

      cacheService.set(key, data);
      cacheService.delete(key);
      
      const result = cacheService.get(key);
      expect(result).toBeNull();
    });

    test('should clear entire cache', () => {
      cacheService.set('key1', Buffer.from('data1'));
      cacheService.set('key2', Buffer.from('data2'));

      cacheService.clear();

      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.get('key2')).toBeNull();
    });
  });

  describe('LRU Eviction', () => {
    test('should evict least recently used item when cache is full', () => {
      // Fill cache with 10MB of data
      const largeData = Buffer.alloc(2 * 1024 * 1024); // 2MB each
      
      cacheService.set('item1', largeData);
      cacheService.set('item2', largeData);
      cacheService.set('item3', largeData);
      cacheService.set('item4', largeData);
      cacheService.set('item5', largeData); // This should evict item1

      // item1 should be evicted
      expect(cacheService.get('item1')).toBeNull();
      // Others should still be there
      expect(cacheService.get('item5')).not.toBeNull();
    });

    test('should update access time on get', () => {
      const data = Buffer.from('test');
      
      cacheService.set('item1', data);
      cacheService.set('item2', data);
      
      // Access item1 to make it more recently used
      cacheService.get('item1');
      
      // Fill cache to trigger eviction
      const largeData = Buffer.alloc(9 * 1024 * 1024);
      cacheService.set('item3', largeData);
      
      // item2 should be evicted (least recently used)
      // item1 should still be there (recently accessed)
      expect(cacheService.get('item1')).not.toBeNull();
    });

    test('should not cache items larger than 10% of cache size', () => {
      const tooLarge = Buffer.alloc(2 * 1024 * 1024); // 2MB > 10% of 10MB
      
      cacheService.set('large-item', tooLarge);
      
      // Should not be cached
      expect(cacheService.get('large-item')).toBeNull();
    });
  });

  describe('Cache Statistics', () => {
    test('should track cache hits and misses', () => {
      const data = Buffer.from('test');
      cacheService.set('key1', data);

      cacheService.get('key1'); // Hit
      cacheService.get('key2'); // Miss
      cacheService.get('key1'); // Hit

      const stats = cacheService.getStats();
      
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
    });

    test('should track cache size', () => {
      const data = Buffer.alloc(1024 * 1024); // 1MB
      
      cacheService.set('item1', data);
      cacheService.set('item2', data);

      const stats = cacheService.getStats();
      
      expect(stats.size).toBe(2);
      expect(stats.totalBytes).toBe(2 * 1024 * 1024);
      expect(stats.maxBytes).toBe(10 * 1024 * 1024);
    });

    test('should reset stats on clear', () => {
      cacheService.set('key1', Buffer.from('data'));
      cacheService.get('key1');
      
      cacheService.clear();
      
      const stats = cacheService.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
    });
  });

  describe('Configuration', () => {
    test('should respect cacheSizeMB config setting', () => {
      const stats = cacheService.getStats();
      expect(stats.maxBytes).toBe(10 * 1024 * 1024);
    });

    test('should not cache when cacheSizeMB is 0', () => {
      // Create service with 0 cache size
      const noCacheService = new CacheService();
      // Mock config to return 0
      jest.spyOn(noCacheService as any, 'maxSizeBytes', 'get').mockReturnValue(0);
      
      noCacheService.set('key1', Buffer.from('data'));
      expect(noCacheService.get('key1')).toBeNull();
    });
  });
});
