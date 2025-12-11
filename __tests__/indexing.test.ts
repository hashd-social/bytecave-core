/**
 * Tests for Blob Indexing & Query Layer
 * 
 * Covers Requirement 15: Blob Indexing
 */

import { indexService } from '../src/services/index.service.js';
import { IndexableBlobMetadata } from '../src/types/index.js';

describe('Blob Indexing & Query Layer (Requirement 15)', () => {
  beforeEach(async () => {
    await indexService.initialize();
    indexService.clearIndexes();
  });

  describe('Index Storage (R15.1)', () => {
    test('should index blob with metadata', async () => {
      const metadata: IndexableBlobMetadata = {
        type: 'message',
        threadId: 'thread-123',
        timestamp: Date.now(),
        size: 1024
      };

      await indexService.indexBlob('cid-1', metadata);

      const entry = await indexService.getBlobMetadata('cid-1');
      expect(entry).toBeDefined();
      expect(entry?.cid).toBe('cid-1');
      expect(entry?.type).toBe('message');
    });

    test('should not duplicate index entries', async () => {
      const metadata: IndexableBlobMetadata = {
        type: 'message',
        threadId: 'thread-123',
        timestamp: Date.now(),
        size: 1024
      };

      await indexService.indexBlob('cid-1', metadata);
      await indexService.indexBlob('cid-1', metadata);

      const stats = indexService.getStats();
      expect(stats.totalEntries).toBe(1);
    });

    test('should index different blob types', async () => {
      const types: Array<'message' | 'post' | 'comment' | 'attachment'> = [
        'message',
        'post',
        'comment',
        'attachment'
      ];

      for (let i = 0; i < types.length; i++) {
        await indexService.indexBlob(`cid-${i}`, {
          type: types[i],
          threadId: 'thread-1',
          timestamp: Date.now(),
          size: 1024
        });
      }

      const stats = indexService.getStats();
      expect(stats.totalEntries).toBe(4);
      expect(stats.byType.message).toBe(1);
      expect(stats.byType.post).toBe(1);
      expect(stats.byType.comment).toBe(1);
      expect(stats.byType.attachment).toBe(1);
    });
  });

  describe('Query Latest (R15.3)', () => {
    test('should query latest blobs', async () => {
      for (let i = 0; i < 5; i++) {
        await indexService.indexBlob(`cid-${i}`, {
          type: 'message',
          threadId: 'thread-1',
          timestamp: Date.now() + i,
          size: 1024
        });
      }

      const result = await indexService.queryLatest(undefined, 3);
      expect(result.entries.length).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    test('should query by type', async () => {
      await indexService.indexBlob('msg-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      await indexService.indexBlob('post-1', {
        type: 'post',
        threadId: 'thread-2',
        guildId: 'guild-1',
        timestamp: Date.now(),
        size: 2048
      });

      const result = await indexService.queryLatest('message');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('message');
    });

    test('should return newest first', async () => {
      const timestamps = [1000, 2000, 3000];
      for (let i = 0; i < timestamps.length; i++) {
        await indexService.indexBlob(`cid-${i}`, {
          type: 'message',
          threadId: 'thread-1',
          timestamp: timestamps[i],
          size: 1024
        });
      }

      const result = await indexService.queryLatest();
      expect(result.entries[0].timestamp).toBe(3000);
      expect(result.entries[1].timestamp).toBe(2000);
      expect(result.entries[2].timestamp).toBe(1000);
    });
  });

  describe('Pagination (R15.3)', () => {
    test('should paginate results', async () => {
      for (let i = 0; i < 10; i++) {
        await indexService.indexBlob(`cid-${i}`, {
          type: 'message',
          threadId: 'thread-1',
          timestamp: Date.now() + i,
          size: 1024
        });
      }

      const page1 = await indexService.queryLatest(undefined, 3);
      expect(page1.entries.length).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBeDefined();

      const page2 = await indexService.queryLatest(undefined, 3, page1.cursor);
      expect(page2.entries.length).toBe(3);
      expect(page2.entries[0].cid).not.toBe(page1.entries[0].cid);
    });

    test('should indicate no more results', async () => {
      await indexService.indexBlob('cid-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      const result = await indexService.queryLatest(undefined, 10);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeUndefined();
    });
  });

  describe('Thread Queries (R15.3)', () => {
    test('should query thread messages', async () => {
      await indexService.indexBlob('msg-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      await indexService.indexBlob('msg-2', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now() + 1000,
        size: 1024
      });

      await indexService.indexBlob('msg-3', {
        type: 'message',
        threadId: 'thread-2',
        timestamp: Date.now(),
        size: 1024
      });

      const result = await indexService.queryThread('thread-1');
      expect(result.entries.length).toBe(2);
      expect(result.entries.every(e => e.threadId === 'thread-1')).toBe(true);
    });

    test('should support thread pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await indexService.indexBlob(`msg-${i}`, {
          type: 'message',
          threadId: 'thread-1',
          timestamp: Date.now() + i,
          size: 1024
        });
      }

      const result = await indexService.queryThread('thread-1', 2);
      expect(result.entries.length).toBe(2);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('Delta Sync (R15.4)', () => {
    test('should return only new entries', async () => {
      const baseTime = Date.now();

      await indexService.indexBlob('old-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: baseTime,
        size: 1024
      });

      await indexService.indexBlob('new-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: baseTime + 5000,
        size: 1024
      });

      const delta = await indexService.queryThreadDelta('thread-1', baseTime + 1000);
      expect(delta.newEntries.length).toBe(1);
      expect(delta.newEntries[0].cid).toBe('new-1');
    });

    test('should return empty delta if nothing new', async () => {
      await indexService.indexBlob('msg-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: 1000,
        size: 1024
      });

      const delta = await indexService.queryThreadDelta('thread-1', 2000);
      expect(delta.newEntries.length).toBe(0);
      expect(delta.count).toBe(0);
    });

    test('should return delta metadata', async () => {
      const sinceTimestamp = Date.now();

      const delta = await indexService.queryThreadDelta('thread-1', sinceTimestamp);
      expect(delta.sinceTimestamp).toBe(sinceTimestamp);
      expect(delta.currentTimestamp).toBeGreaterThanOrEqual(sinceTimestamp);
    });
  });

  describe('Guild Queries (R15.3)', () => {
    test('should query guild blobs', async () => {
      await indexService.indexBlob('post-1', {
        type: 'post',
        threadId: 'thread-1',
        guildId: 'guild-1',
        timestamp: Date.now(),
        size: 2048
      });

      await indexService.indexBlob('post-2', {
        type: 'post',
        threadId: 'thread-2',
        guildId: 'guild-2',
        timestamp: Date.now(),
        size: 2048
      });

      const result = await indexService.queryGuild('guild-1');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].guildId).toBe('guild-1');
    });

    test('should query guild posts only', async () => {
      await indexService.indexBlob('post-1', {
        type: 'post',
        threadId: 'thread-1',
        guildId: 'guild-1',
        timestamp: Date.now(),
        size: 2048
      });

      await indexService.indexBlob('comment-1', {
        type: 'comment',
        threadId: 'thread-1',
        guildId: 'guild-1',
        parentCid: 'post-1',
        timestamp: Date.now() + 1000,
        size: 512
      });

      const result = await indexService.queryGuildPosts('guild-1');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].type).toBe('post');
    });

    test('should query comments for post', async () => {
      await indexService.indexBlob('post-1', {
        type: 'post',
        threadId: 'thread-1',
        guildId: 'guild-1',
        timestamp: Date.now(),
        size: 2048
      });

      await indexService.indexBlob('comment-1', {
        type: 'comment',
        threadId: 'thread-1',
        guildId: 'guild-1',
        parentCid: 'post-1',
        timestamp: Date.now() + 1000,
        size: 512
      });

      await indexService.indexBlob('comment-2', {
        type: 'comment',
        threadId: 'thread-1',
        guildId: 'guild-1',
        parentCid: 'post-1',
        timestamp: Date.now() + 2000,
        size: 512
      });

      const result = await indexService.queryComments('guild-1', 'post-1');
      expect(result.entries.length).toBe(2);
      expect(result.entries.every(e => e.parentCid === 'post-1')).toBe(true);
    });
  });

  describe('Index Removal (GC)', () => {
    test('should remove blob from index', async () => {
      await indexService.indexBlob('cid-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      await indexService.removeFromIndex('cid-1');

      const entry = await indexService.getBlobMetadata('cid-1');
      expect(entry).toBeNull();
    });

    test('should update stats after removal', async () => {
      await indexService.indexBlob('cid-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      let stats = indexService.getStats();
      expect(stats.totalEntries).toBe(1);

      await indexService.removeFromIndex('cid-1');

      stats = indexService.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  describe('Privacy Guarantees (R15.9)', () => {
    test('should use privacy-preserving thread IDs', async () => {
      const metadata: IndexableBlobMetadata = {
        type: 'message',
        threadId: 'keccak256-hash-of-thread-nonce',
        timestamp: Date.now(),
        size: 1024
      };

      await indexService.indexBlob('cid-1', metadata);

      const entry = await indexService.getBlobMetadata('cid-1');
      expect(entry?.threadId).toBe('keccak256-hash-of-thread-nonce');
      // Thread ID should not reveal mailbox IDs
    });

    test('should not store decrypted content', async () => {
      const metadata: IndexableBlobMetadata = {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      };

      await indexService.indexBlob('cid-1', metadata);

      const entry = await indexService.getBlobMetadata('cid-1');
      // Entry should only have metadata, no content
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('plaintext');
    });
  });

  describe('Statistics', () => {
    test('should provide index statistics', async () => {
      await indexService.indexBlob('msg-1', {
        type: 'message',
        threadId: 'thread-1',
        timestamp: Date.now(),
        size: 1024
      });

      await indexService.indexBlob('post-1', {
        type: 'post',
        threadId: 'thread-2',
        guildId: 'guild-1',
        timestamp: Date.now(),
        size: 2048
      });

      const stats = indexService.getStats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.byType.message).toBe(1);
      expect(stats.byType.post).toBe(1);
      expect(stats.threads).toBe(2);
      expect(stats.guilds).toBe(1);
    });
  });

  describe('Performance (R15.8)', () => {
    test('should handle large number of entries', async () => {
      const count = 1000;
      const startTime = Date.now();

      for (let i = 0; i < count; i++) {
        await indexService.indexBlob(`cid-${i}`, {
          type: 'message',
          threadId: `thread-${i % 100}`,
          timestamp: Date.now() + i,
          size: 1024
        });
      }

      const indexTime = Date.now() - startTime;
      expect(indexTime).toBeLessThan(5000); // Should index 1000 entries in <5s

      const queryStart = Date.now();
      await indexService.queryLatest(undefined, 50);
      const queryTime = Date.now() - queryStart;
      expect(queryTime).toBeLessThan(100); // Query should be fast
    });
  });
});
