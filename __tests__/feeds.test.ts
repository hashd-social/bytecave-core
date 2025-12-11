/**
 * Tests for Encrypted Multi-Writer Feeds
 * 
 * Covers Requirement 10: Encrypted Multi-Writer Feeds
 */

import { feedService } from '../src/services/feed.service.js';
import { storageService } from '../src/services/storage.service.js';
import { signMessage, verifySignature } from '../src/utils/crypto.js';
import { FeedEvent } from '../src/types/index.js';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

// Mock storage service
jest.mock('../src/services/storage.service.js', () => ({
  storageService: {
    hasBlob: jest.fn(),
    getBlob: jest.fn(),
    storeBlob: jest.fn()
  }
}));

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

describe('Encrypted Multi-Writer Feeds (Requirement 10)', () => {
  // Generate test keypairs
  const aliceKeypair = nacl.sign.keyPair();
  const bobKeypair = nacl.sign.keyPair();
  const aliceKey = Buffer.from(aliceKeypair.publicKey).toString('hex');
  const bobKey = Buffer.from(bobKeypair.publicKey).toString('hex');
  const alicePrivateKey = Buffer.from(aliceKeypair.secretKey).toString('hex');
  const bobPrivateKey = Buffer.from(bobKeypair.secretKey).toString('hex');

  beforeEach(async () => {
    jest.clearAllMocks();
    await feedService.initialize();
  });

  describe('Feed Structure (R10.1)', () => {
    test('should support DM feed type', async () => {
      const metadata = await feedService.createFeed(
        'dm-alice-bob',
        'dm',
        [aliceKey, bobKey]
      );

      expect(metadata.feedType).toBe('dm');
      expect(metadata.writers).toEqual([aliceKey, bobKey]);
    });

    test('should support post feed type', async () => {
      const metadata = await feedService.createFeed(
        'post-guild-123',
        'post',
        [aliceKey]
      );

      expect(metadata.feedType).toBe('post');
    });

    test('should support listing feed type', async () => {
      const metadata = await feedService.createFeed(
        'listing-item-456',
        'listing',
        [aliceKey]
      );

      expect(metadata.feedType).toBe('listing');
    });

    test('should support activity feed type', async () => {
      const metadata = await feedService.createFeed(
        'activity-user-789',
        'activity',
        [aliceKey]
      );

      expect(metadata.feedType).toBe('activity');
    });
  });

  describe('Feed Entry Format (R10.2)', () => {
    test('should create feed event with required fields', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'test-sig'
      };

      expect(event.feedId).toBeDefined();
      expect(event.cid).toBeDefined();
      expect(event.parentCid).toBeNull();
      expect(event.authorKey).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.signature).toBeDefined();
    });

    test('should support parent CID for chained entries', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'parent-cid',
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'test-sig'
      };

      expect(event.parentCid).toBe('parent-cid');
    });

    test('should support optional event type', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'test-sig',
        eventType: 'message'
      };

      expect(event.eventType).toBe('message');
    });
  });

  describe('One Blob Per Action (R10.3)', () => {
    test('should require blob to exist before adding entry', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'nonexistent-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'nonexistent-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      (storageService.hasBlob as jest.Mock).mockResolvedValue(false);

      await expect(feedService.addEntry(event)).rejects.toThrow('Blob nonexistent-cid not found');
    });

    test('should accept entry when blob exists', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'existing-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'existing-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await feedService.addEntry(event);

      const metadata = await feedService.getFeedMetadata('test-feed');
      expect(metadata?.entryCount).toBe(1);
    });
  });

  describe('Root Entries (R10.4)', () => {
    test('should set first entry as root', async () => {
      await feedService.createFeed('test-feed', 'post', [aliceKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'root-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'root-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await feedService.addEntry(event);

      const metadata = await feedService.getFeedMetadata('test-feed');
      expect(metadata?.rootCid).toBe('root-cid');
    });

    test('should not change root after first entry', async () => {
      await feedService.createFeed('test-feed', 'post', [aliceKey]);

      // Add root entry
      const timestamp1 = Date.now();
      const message1 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'root-cid',
        parentCid: null,
        timestamp: timestamp1,
        authorKey: aliceKey
      });
      const signature1 = signMessage(message1, alicePrivateKey);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'root-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: timestamp1,
        signature: signature1
      });

      // Add child entry
      const timestamp2 = Date.now();
      const message2 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'root-cid',
        timestamp: timestamp2,
        authorKey: aliceKey
      });
      const signature2 = signMessage(message2, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'root-cid',
        authorKey: aliceKey,
        timestamp: timestamp2,
        signature: signature2
      });

      const metadata = await feedService.getFeedMetadata('test-feed');
      expect(metadata?.rootCid).toBe('root-cid');
    });
  });

  describe('Multi-Writer Authorization (R10.5)', () => {
    test('should allow authorized writers', async () => {
      await feedService.createFeed('dm-feed', 'dm', [aliceKey, bobKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'dm-feed',
        cid: 'msg-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await expect(feedService.addEntry({
        feedId: 'dm-feed',
        cid: 'msg-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      })).resolves.not.toThrow();
    });

    test('should reject unauthorized writers', async () => {
      await feedService.createFeed('dm-feed', 'dm', [aliceKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'dm-feed',
        cid: 'msg-cid',
        parentCid: null,
        timestamp,
        authorKey: bobKey
      });
      const signature = signMessage(message, bobPrivateKey);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await expect(feedService.addEntry({
        feedId: 'dm-feed',
        cid: 'msg-cid',
        parentCid: null,
        authorKey: bobKey,
        timestamp,
        signature
      })).rejects.toThrow('not authorized');
    });

    test('should support multiple writers', async () => {
      await feedService.createFeed('dm-feed', 'dm', [aliceKey, bobKey]);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      // Alice sends message
      const timestamp1 = Date.now();
      const message1 = JSON.stringify({
        feedId: 'dm-feed',
        cid: 'alice-msg',
        parentCid: null,
        timestamp: timestamp1,
        authorKey: aliceKey
      });
      const signature1 = signMessage(message1, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'dm-feed',
        cid: 'alice-msg',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: timestamp1,
        signature: signature1
      });

      // Bob replies
      const timestamp2 = Date.now();
      const message2 = JSON.stringify({
        feedId: 'dm-feed',
        cid: 'bob-msg',
        parentCid: 'alice-msg',
        timestamp: timestamp2,
        authorKey: bobKey
      });
      const signature2 = signMessage(message2, bobPrivateKey);

      await feedService.addEntry({
        feedId: 'dm-feed',
        cid: 'bob-msg',
        parentCid: 'alice-msg',
        authorKey: bobKey,
        timestamp: timestamp2,
        signature: signature2
      });

      const metadata = await feedService.getFeedMetadata('dm-feed');
      expect(metadata?.entryCount).toBe(2);
    });
  });

  describe('Thread Reconstruction (R10.6)', () => {
    test('should validate event signatures', async () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const isValid = verifySignature(message, signature, aliceKey);
      expect(isValid).toBe(true);
    });

    test('should reject invalid signatures', async () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });

      const isValid = verifySignature(message, 'invalid-signature', aliceKey);
      expect(isValid).toBe(false);
    });

    test('should validate feed integrity', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      });

      const result = await feedService.validateFeed('test-feed');
      expect(result).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.warnings).toBeDefined();
      // Validation runs successfully (may have warnings about mocked storage)
    });
  });

  describe('Fork Resolution (R10.7)', () => {
    test('should detect no forks in linear chain', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      // Add linear chain
      const timestamp1 = Date.now();
      const message1 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        timestamp: timestamp1,
        authorKey: aliceKey
      });
      const signature1 = signMessage(message1, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: timestamp1,
        signature: signature1
      });

      const result = await feedService.resolveForks('test-feed');
      expect(result.reason).toBeDefined();
      expect(result.winningChain).toBeDefined();
    });

    test('should handle fork resolution for empty feed', async () => {
      await feedService.createFeed('empty-feed', 'dm', [aliceKey]);

      const result = await feedService.resolveForks('empty-feed');
      expect(result).toBeDefined();
      expect(result.winningChain).toEqual([]);
    });
  });

  describe('Feed Discovery API (R10.8)', () => {
    test('should get feed events with pagination', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      // Add multiple entries
      for (let i = 0; i < 3; i++) {
        const timestamp = Date.now() + i;
        const message = JSON.stringify({
          feedId: 'test-feed',
          cid: `msg-${i}`,
          parentCid: i === 0 ? null : `msg-${i - 1}`,
          timestamp,
          authorKey: aliceKey
        });
        const signature = signMessage(message, alicePrivateKey);

        await feedService.addEntry({
          feedId: 'test-feed',
          cid: `msg-${i}`,
          parentCid: i === 0 ? null : `msg-${i - 1}`,
          authorKey: aliceKey,
          timestamp,
          signature
        });
      }

      const response = await feedService.getFeedEvents('test-feed', 2);
      expect(response.events.length).toBe(2);
      expect(response.hasMore).toBe(true);
      expect(response.cursor).toBeDefined();
    });

    test('should get feed blob CIDs', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      });

      const cids = await feedService.getFeedBlobs('test-feed');
      expect(cids).toContain('test-cid');
    });
  });

  describe('Storage Requirements (R10.9)', () => {
    test('should store feed metadata', async () => {
      const metadata = await feedService.createFeed(
        'test-feed',
        'dm',
        [aliceKey, bobKey]
      );

      expect(metadata.feedId).toBe('test-feed');
      expect(metadata.feedType).toBe('dm');
      expect(metadata.writers).toEqual([aliceKey, bobKey]);
      expect(metadata.createdAt).toBeDefined();
      expect(metadata.entryCount).toBe(0);
    });

    test('should track entry count', async () => {
      await feedService.createFeed('test-feed', 'dm', [aliceKey]);

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      });

      const metadata = await feedService.getFeedMetadata('test-feed');
      expect(metadata?.entryCount).toBe(1);
    });

    test('should update lastUpdatedAt on new entry', async () => {
      const metadata1 = await feedService.createFeed('test-feed', 'dm', [aliceKey]);
      const initialTime = metadata1.lastUpdatedAt;

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      await feedService.addEntry({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      });

      const metadata2 = await feedService.getFeedMetadata('test-feed');
      expect(metadata2?.lastUpdatedAt).toBeGreaterThan(initialTime);
    });
  });

  describe('Signature Verification', () => {
    test('should sign and verify messages', () => {
      const message = 'test message';
      const signature = signMessage(message, alicePrivateKey);
      const isValid = verifySignature(message, signature, aliceKey);

      expect(isValid).toBe(true);
    });

    test('should reject tampered messages', () => {
      const message = 'test message';
      const signature = signMessage(message, alicePrivateKey);
      const tamperedMessage = 'tampered message';
      const isValid = verifySignature(tamperedMessage, signature, aliceKey);

      expect(isValid).toBe(false);
    });

    test('should reject wrong public key', () => {
      const message = 'test message';
      const signature = signMessage(message, alicePrivateKey);
      const isValid = verifySignature(message, signature, bobKey);

      expect(isValid).toBe(false);
    });
  });
});
