/**
 * Tests for Storage Proof Generation and Verification
 */

import { 
  generateChallenge, 
  signProof, 
  verifyProof, 
  generateKeyPair,
  truncateToHour,
  isProofFresh
} from '../src/utils/proof.js';
import { StorageProof } from '../src/types/index.js';

describe('Challenge Generation', () => {
  test('should generate consistent challenge for same CID and timestamp', () => {
    const cid = '123abc';
    const timestamp = 1702234567;
    
    const challenge1 = generateChallenge(cid, timestamp);
    const challenge2 = generateChallenge(cid, timestamp);
    
    expect(challenge1).toBe(challenge2);
  });

  test('should generate different challenges for different CIDs', () => {
    const timestamp = 1702234567;
    
    const challenge1 = generateChallenge('abc123', timestamp);
    const challenge2 = generateChallenge('def456', timestamp);
    
    expect(challenge1).not.toBe(challenge2);
  });

  test('should truncate timestamp to hour boundary', () => {
    const cid = '123abc';
    const timestamp1 = 1702234567; // Some time in an hour
    const timestamp2 = 1702234999; // Different time, same hour
    
    const challenge1 = generateChallenge(cid, timestamp1);
    const challenge2 = generateChallenge(cid, timestamp2);
    
    // Should be same if in same hour
    const hour1 = Math.floor(timestamp1 / 3600) * 3600;
    const hour2 = Math.floor(timestamp2 / 3600) * 3600;
    
    if (hour1 === hour2) {
      expect(challenge1).toBe(challenge2);
    }
  });

  test('should generate valid hex string', () => {
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    
    expect(challenge).toMatch(/^[0-9a-f]+$/);
    expect(challenge).toHaveLength(64); // SHA-256
  });
});

describe('Proof Signing', () => {
  test('should sign proof with private key', () => {
    const { privateKey } = generateKeyPair();
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    
    const signature = signProof(privateKey, cid, challenge, nodeId);
    
    expect(signature).toBeTruthy();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
  });

  test('should generate different signatures for different data', () => {
    const { privateKey } = generateKeyPair();
    const challenge = generateChallenge('cid');
    const nodeId = 'test-node';
    
    const sig1 = signProof(privateKey, 'abc123different', challenge, nodeId);
    const sig2 = signProof(privateKey, 'def456different', challenge, nodeId);
    
    expect(sig1).not.toBe(sig2);
  });
});

describe('Proof Verification', () => {
  test('should verify valid proof', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    const timestamp = Math.floor(Date.now() / 1000);
    
    const signature = signProof(privateKey, cid, challenge, nodeId);
    
    const proof: StorageProof = {
      cid,
      nodeId,
      timestamp,
      challenge,
      signature,
      publicKey: publicKey.toString('hex')
    };
    
    const result = verifyProof(proof, publicKey.toString('hex'));
    
    expect(result.valid).toBe(true);
    expect(result.nodeId).toBe(nodeId);
  });

  test('should reject proof with invalid signature', () => {
    const { publicKey } = generateKeyPair();
    const { privateKey: wrongKey } = generateKeyPair();
    
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    const timestamp = Math.floor(Date.now() / 1000);
    
    const signature = signProof(wrongKey, cid, challenge, nodeId);
    
    const proof: StorageProof = {
      cid,
      nodeId,
      timestamp,
      challenge,
      signature,
      publicKey: publicKey.toString('hex')
    };
    
    const result = verifyProof(proof, publicKey.toString('hex'));
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid signature');
  });

  test('should reject stale proof', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    
    const signature = signProof(privateKey, cid, challenge, nodeId);
    
    const proof: StorageProof = {
      cid,
      nodeId,
      timestamp: oldTimestamp,
      challenge,
      signature,
      publicKey: publicKey.toString('hex')
    };
    
    const result = verifyProof(proof, publicKey.toString('hex'));
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too old');
  });

  test('should reject future proof', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const cid = '123abc';
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
    
    const signature = signProof(privateKey, cid, challenge, nodeId);
    
    const proof: StorageProof = {
      cid,
      nodeId,
      timestamp: futureTimestamp,
      challenge,
      signature,
      publicKey: publicKey.toString('hex')
    };
    
    const result = verifyProof(proof, publicKey.toString('hex'));
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('future');
  });
});

describe('Timestamp Utilities', () => {
  test('should truncate timestamp to hour boundary', () => {
    const timestamp = 1702234567; // Some specific time
    const truncated = truncateToHour(timestamp);
    
    expect(truncated % 3600).toBe(0);
    expect(truncated).toBeLessThanOrEqual(timestamp);
  });

  test('should check proof freshness', () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = now - 1800; // 30 minutes ago
    const stale = now - 7200; // 2 hours ago
    
    expect(isProofFresh(fresh, 3600)).toBe(true);
    expect(isProofFresh(stale, 3600)).toBe(false);
  });
});
