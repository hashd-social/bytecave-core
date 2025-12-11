/**
 * Tests for Writer Authorization
 * 
 * Covers Requirement 12: Unified Writer Authorization
 */

import { writerAuthorizationService } from '../src/services/writer-authorization.service.js';
import { signMessage } from '../src/utils/crypto.js';
import { FeedEvent, GuildPostingRules, WriterContext } from '../src/types/index.js';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

describe('Writer Authorization (Requirement 12)', () => {
  // Generate test keypairs
  const aliceKeypair = nacl.sign.keyPair();
  const bobKeypair = nacl.sign.keyPair();
  const aliceKey = Buffer.from(aliceKeypair.publicKey).toString('hex');
  const bobKey = Buffer.from(bobKeypair.publicKey).toString('hex');
  const alicePrivateKey = Buffer.from(aliceKeypair.secretKey).toString('hex');
  const bobPrivateKey = Buffer.from(bobKeypair.secretKey).toString('hex');

  const aliceContext: WriterContext = {
    writerPubKey: aliceKey,
    walletAddress: '0xAlice',
    mailboxId: 'alice-mailbox'
  };

  const bobContext: WriterContext = {
    writerPubKey: bobKey,
    walletAddress: '0xBob',
    mailboxId: 'bob-mailbox'
  };

  beforeEach(() => {
    writerAuthorizationService.clearCache();
  });

  describe('Deterministic Key Signing (R12.1)', () => {
    test('should verify valid signature', () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      const isValid = writerAuthorizationService.verifyWriterSignature(event);
      expect(isValid).toBe(true);
    });

    test('should reject invalid signature', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'invalid-signature'
      };

      const isValid = writerAuthorizationService.verifyWriterSignature(event);
      expect(isValid).toBe(false);
    });

    test('should reject signature from wrong key', () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, bobPrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      const isValid = writerAuthorizationService.verifyWriterSignature(event);
      expect(isValid).toBe(false);
    });
  });

  describe('Message Chain Validation (R12.2)', () => {
    test('should accept root message without parent', () => {
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

      const result = writerAuthorizationService.validateMessageChain(event, []);
      expect(result.authorized).toBe(true);
    });

    test('should accept message with valid parent', () => {
      const timestamp1 = Date.now();
      const message1 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'parent-cid',
        parentCid: null,
        timestamp: timestamp1,
        authorKey: aliceKey
      });
      const signature1 = signMessage(message1, alicePrivateKey);

      const parent: FeedEvent = {
        feedId: 'test-feed',
        cid: 'parent-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: timestamp1,
        signature: signature1
      };

      const timestamp2 = Date.now();
      const message2 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'parent-cid',
        timestamp: timestamp2,
        authorKey: aliceKey
      });
      const signature2 = signMessage(message2, alicePrivateKey);

      const child: FeedEvent = {
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'parent-cid',
        authorKey: aliceKey,
        timestamp: timestamp2,
        signature: signature2
      };

      const result = writerAuthorizationService.validateMessageChain(child, [parent]);
      expect(result.authorized).toBe(true);
    });

    test('should reject message with missing parent', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'child-cid',
        parentCid: 'nonexistent-parent',
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'sig'
      };

      const result = writerAuthorizationService.validateMessageChain(event, []);
      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('chain');
    });
  });

  describe('DM Authorization (R12.3)', () => {
    test('should allow writer in allowlist', () => {
      const result = writerAuthorizationService.checkDMAuthorization(
        'alice-mailbox',
        'dm-channel',
        ['alice-mailbox', 'bob-mailbox'],
        []
      );

      expect(result.authorized).toBe(true);
    });

    test('should reject writer not in allowlist', () => {
      const result = writerAuthorizationService.checkDMAuthorization(
        'charlie-mailbox',
        'dm-channel',
        ['alice-mailbox', 'bob-mailbox'],
        []
      );

      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('blocklist');
    });

    test('should reject blocked writer', () => {
      const result = writerAuthorizationService.checkDMAuthorization(
        'alice-mailbox',
        'dm-channel',
        ['alice-mailbox', 'bob-mailbox'],
        ['alice-mailbox']
      );

      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('blocklist');
    });
  });

  describe('Guild Posting Authorization (R12.4)', () => {
    test('should allow public tier posting', () => {
      const rules: GuildPostingRules = {
        tier: 'public'
      };

      const result = writerAuthorizationService.checkGuildPostingAuthorization(
        '0xAlice',
        aliceKey,
        rules,
        []
      );

      expect(result.authorized).toBe(true);
    });

    test('should allow member tier posting', () => {
      const rules: GuildPostingRules = {
        tier: 'members',
        memberList: ['0xAlice', '0xBob']
      };

      const result = writerAuthorizationService.checkGuildPostingAuthorization(
        '0xAlice',
        aliceKey,
        rules,
        []
      );

      expect(result.authorized).toBe(true);
    });

    test('should reject non-member posting', () => {
      const rules: GuildPostingRules = {
        tier: 'members',
        memberList: ['0xBob']
      };

      const result = writerAuthorizationService.checkGuildPostingAuthorization(
        '0xAlice',
        aliceKey,
        rules,
        []
      );

      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('tier');
    });

    test('should reject banned wallet', () => {
      const rules: GuildPostingRules = {
        tier: 'public'
      };

      const result = writerAuthorizationService.checkGuildPostingAuthorization(
        '0xAlice',
        aliceKey,
        rules,
        ['0xAlice']
      );

      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('blocklist');
    });

    test('should allow prime key holders', () => {
      const rules: GuildPostingRules = {
        tier: 'prime_key',
        primeKeyHolders: ['0xAlice']
      };

      const result = writerAuthorizationService.checkGuildPostingAuthorization(
        '0xAlice',
        aliceKey,
        rules,
        []
      );

      expect(result.authorized).toBe(true);
    });
  });

  describe('Timestamp Validation (R12.7)', () => {
    test('should accept recent timestamp', () => {
      const result = writerAuthorizationService.validateTimestamp(Date.now());
      expect(result.authorized).toBe(true);
    });

    test('should reject old timestamp', () => {
      const oldTimestamp = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      const result = writerAuthorizationService.validateTimestamp(oldTimestamp);
      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('timestamp');
    });

    test('should reject future timestamp', () => {
      const futureTimestamp = Date.now() + (10 * 60 * 1000); // 10 minutes future
      const result = writerAuthorizationService.validateTimestamp(futureTimestamp);
      expect(result.authorized).toBe(false);
      expect(result.rejectionType).toBe('timestamp');
    });
  });

  describe('Comprehensive Event Validation (R12.7)', () => {
    test('should validate complete event', () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      const validated = writerAuthorizationService.validateEvent(event, {
        writerContext: aliceContext
      });

      expect(validated.state).toBe('valid');
      expect(validated.validationErrors).toHaveLength(0);
    });

    test('should reject event with invalid signature', () => {
      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'test-cid',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: Date.now(),
        signature: 'invalid'
      };

      const validated = writerAuthorizationService.validateEvent(event, {
        writerContext: aliceContext
      });

      expect(validated.state).toBe('invalid');
      expect(validated.validationErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Feed Assembly (R12.6)', () => {
    test('should assemble and validate feed', () => {
      const timestamp1 = Date.now();
      const message1 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        timestamp: timestamp1,
        authorKey: aliceKey
      });
      const signature1 = signMessage(message1, alicePrivateKey);

      const event1: FeedEvent = {
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        authorKey: aliceKey,
        timestamp: timestamp1,
        signature: signature1
      };

      const timestamp2 = Date.now() + 1000;
      const message2 = JSON.stringify({
        feedId: 'test-feed',
        cid: 'msg-2',
        parentCid: 'msg-1',
        timestamp: timestamp2,
        authorKey: bobKey
      });
      const signature2 = signMessage(message2, bobPrivateKey);

      const event2: FeedEvent = {
        feedId: 'test-feed',
        cid: 'msg-2',
        parentCid: 'msg-1',
        authorKey: bobKey,
        timestamp: timestamp2,
        signature: signature2
      };

      const writerContexts = new Map([
        [aliceKey, aliceContext],
        [bobKey, bobContext]
      ]);

      const validated = writerAuthorizationService.assembleFeed(
        [event1, event2],
        { writerContexts }
      );

      expect(validated.length).toBe(2);
      expect(validated.every(e => e.state === 'valid')).toBe(true);
    });

    test('should filter censored events', () => {
      const timestamp = Date.now();
      const message = JSON.stringify({
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        timestamp,
        authorKey: aliceKey
      });
      const signature = signMessage(message, alicePrivateKey);

      const event: FeedEvent = {
        feedId: 'test-feed',
        cid: 'msg-1',
        parentCid: null,
        authorKey: aliceKey,
        timestamp,
        signature
      };

      const validated = writerAuthorizationService.assembleFeed(
        [event],
        {
          dmAllowlist: ['bob-mailbox'],
          dmBlocklist: [],
          writerContexts: new Map([[aliceKey, aliceContext]])
        }
      );

      expect(validated.length).toBe(0); // Censored
    });
  });

  describe('Allowlist/Blocklist Management', () => {
    test('should set and get allowlist', () => {
      writerAuthorizationService.setAllowlist('channel-1', ['alice', 'bob']);
      const allowlist = writerAuthorizationService.getAllowlist('channel-1');
      expect(allowlist).toEqual(['alice', 'bob']);
    });

    test('should set and get blocklist', () => {
      writerAuthorizationService.setBlocklist('channel-1', ['charlie']);
      const blocklist = writerAuthorizationService.getBlocklist('channel-1');
      expect(blocklist).toEqual(['charlie']);
    });
  });
});
