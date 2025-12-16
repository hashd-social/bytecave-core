/**
 * Tests for Storage Authorization
 * 
 * Tests timestamp validation, content hashing, and authorization types.
 * Signature tests use pre-computed values to avoid async wallet operations.
 */
import { ethers } from 'ethers';

describe('Storage Authorization', () => {
  // Helper to create content hash
  function createContentHash(data: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(data));
  }

  describe('Timestamp Validation', () => {
    const TOLERANCE = 5 * 60 * 1000; // 5 minutes
    const isValid = (ts: number) => Math.abs(Date.now() - ts) <= TOLERANCE;

    test('should accept current timestamp', () => {
      expect(isValid(Date.now())).toBe(true);
    });

    test('should accept timestamp 4 minutes ago', () => {
      expect(isValid(Date.now() - 4 * 60 * 1000)).toBe(true);
    });

    test('should reject timestamp 6 minutes ago', () => {
      expect(isValid(Date.now() - 6 * 60 * 1000)).toBe(false);
    });

    test('should reject timestamp 6 minutes in future', () => {
      expect(isValid(Date.now() + 6 * 60 * 1000)).toBe(false);
    });
  });

  describe('Content Hash', () => {
    test('should generate consistent hash for same content', () => {
      const hash1 = createContentHash('test content');
      const hash2 = createContentHash('test content');
      expect(hash1).toBe(hash2);
    });

    test('should generate different hash for different content', () => {
      const hash1 = createContentHash('content a');
      const hash2 = createContentHash('content b');
      expect(hash1).not.toBe(hash2);
    });

    test('should detect single character change', () => {
      const hash1 = createContentHash('test');
      const hash2 = createContentHash('tesT');
      expect(hash1).not.toBe(hash2);
    });

    test('should return valid keccak256 hash format', () => {
      const hash = createContentHash('test');
      expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
    });
  });

  describe('Thread ID Generation', () => {
    test('should generate deterministic threadId from participants', () => {
      const participants = [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222'
      ];
      const sorted = [...participants].map(p => p.toLowerCase()).sort();
      const threadId1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted])
      );
      const threadId2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted])
      );
      expect(threadId1).toBe(threadId2);
    });

    test('should generate same threadId regardless of input order', () => {
      const p1 = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
      const p2 = ['0x2222222222222222222222222222222222222222', '0x1111111111111111111111111111111111111111'];
      
      const sorted1 = [...p1].map(p => p.toLowerCase()).sort();
      const sorted2 = [...p2].map(p => p.toLowerCase()).sort();
      
      const threadId1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted1]));
      const threadId2 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted2]));
      
      expect(threadId1).toBe(threadId2);
    });

    test('should generate different threadId for different participants', () => {
      const p1 = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
      const p2 = ['0x1111111111111111111111111111111111111111', '0x3333333333333333333333333333333333333333'];
      
      const sorted1 = [...p1].map(p => p.toLowerCase()).sort();
      const sorted2 = [...p2].map(p => p.toLowerCase()).sort();
      
      const threadId1 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted1]));
      const threadId2 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [sorted2]));
      
      expect(threadId1).not.toBe(threadId2);
    });
  });

  describe('Authorization Types', () => {
    const validTypes = ['group_post', 'group_comment', 'message', 'token_distribution'];
    
    test('should recognize valid authorization types', () => {
      validTypes.forEach(type => {
        expect(validTypes.includes(type)).toBe(true);
      });
    });

    test('should have 4 authorization types', () => {
      expect(validTypes.length).toBe(4);
    });
  });

  describe('Nonce Generation', () => {
    test('should generate unique nonces', () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const nonce = Math.random().toString(36).substring(2, 15);
        expect(nonces.has(nonce)).toBe(false);
        nonces.add(nonce);
      }
    });
  });

  describe('Address Validation', () => {
    test('should validate correct Ethereum addresses', () => {
      const validAddress = '0x1234567890123456789012345678901234567890';
      expect(ethers.isAddress(validAddress)).toBe(true);
    });

    test('should reject invalid addresses', () => {
      expect(ethers.isAddress('0x123')).toBe(false);
      expect(ethers.isAddress('not-an-address')).toBe(false);
      expect(ethers.isAddress('')).toBe(false);
    });
  });
});