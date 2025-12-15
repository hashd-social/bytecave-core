/**
 * HASHD Vault - Security Tests: Integrity Protection
 * 
 * Tests for:
 * 1. Ciphertext integrity (CID verification)
 * 2. Metadata integrity (HMAC protection)
 * 3. Replication state integrity (HMAC protection)
 */

import {
  generateCID,
  verifyCID,
  generateMetadataIntegrityHash,
  verifyMetadataIntegrity,
  generateReplicationStateHash,
  verifyReplicationStateIntegrity
} from '../src/utils/cid.js';

describe('Security: Ciphertext Integrity', () => {
  const validCiphertext = Buffer.from('encrypted data here');
  let validCID: string;

  beforeEach(() => {
    validCID = generateCID(validCiphertext);
  });

  test('should generate consistent CID for same content', () => {
    const cid1 = generateCID(validCiphertext);
    const cid2 = generateCID(validCiphertext);
    expect(cid1).toBe(cid2);
  });

  test('should generate different CID for different content', () => {
    const otherCiphertext = Buffer.from('different encrypted data');
    const otherCID = generateCID(otherCiphertext);
    expect(otherCID).not.toBe(validCID);
  });

  test('should verify valid ciphertext matches CID', () => {
    expect(verifyCID(validCID, validCiphertext)).toBe(true);
  });

  test('should reject tampered ciphertext', () => {
    const tamperedCiphertext = Buffer.from('tampered encrypted data');
    expect(verifyCID(validCID, tamperedCiphertext)).toBe(false);
  });

  test('should reject ciphertext with single byte change', () => {
    const tamperedCiphertext = Buffer.from(validCiphertext);
    tamperedCiphertext[0] = tamperedCiphertext[0] ^ 0xFF; // Flip bits
    expect(verifyCID(validCID, tamperedCiphertext)).toBe(false);
  });

  test('should reject ciphertext with appended data', () => {
    const tamperedCiphertext = Buffer.concat([validCiphertext, Buffer.from('extra')]);
    expect(verifyCID(validCID, tamperedCiphertext)).toBe(false);
  });

  test('should reject truncated ciphertext', () => {
    const tamperedCiphertext = validCiphertext.subarray(0, validCiphertext.length - 1);
    expect(verifyCID(validCID, tamperedCiphertext)).toBe(false);
  });

  test('should reject empty ciphertext for non-empty CID', () => {
    expect(verifyCID(validCID, Buffer.from(''))).toBe(false);
  });
});

describe('Security: Metadata Integrity', () => {
  const validMetadata = {
    cid: 'abc123def456',
    size: 1024,
    mimeType: 'text/plain',
    createdAt: 1700000000000,
    pinned: false,
    integrityHash: ''
  };

  beforeEach(() => {
    validMetadata.integrityHash = generateMetadataIntegrityHash(
      validMetadata.cid,
      validMetadata.size,
      validMetadata.mimeType,
      validMetadata.createdAt,
      validMetadata.pinned
    );
  });

  test('should generate consistent hash for same metadata', () => {
    const hash1 = generateMetadataIntegrityHash(
      validMetadata.cid,
      validMetadata.size,
      validMetadata.mimeType,
      validMetadata.createdAt,
      validMetadata.pinned
    );
    const hash2 = generateMetadataIntegrityHash(
      validMetadata.cid,
      validMetadata.size,
      validMetadata.mimeType,
      validMetadata.createdAt,
      validMetadata.pinned
    );
    expect(hash1).toBe(hash2);
  });

  test('should verify valid metadata', () => {
    const result = verifyMetadataIntegrity(validMetadata);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('should allow legacy metadata without hash', () => {
    const legacyMetadata = { ...validMetadata, integrityHash: undefined };
    const result = verifyMetadataIntegrity(legacyMetadata);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('legacy_no_hash');
  });

  test('should reject tampered mimeType', () => {
    const tampered = { ...validMetadata, mimeType: 'application/malware' };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered size', () => {
    const tampered = { ...validMetadata, size: 999999 };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered createdAt', () => {
    const tampered = { ...validMetadata, createdAt: 1600000000000 };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered pinned status', () => {
    const tampered = { ...validMetadata, pinned: true };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered CID in metadata', () => {
    const tampered = { ...validMetadata, cid: 'different_cid_xyz' };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject corrupted integrity hash', () => {
    const tampered = { ...validMetadata, integrityHash: 'corrupted_hash_value' };
    const result = verifyMetadataIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });
});

describe('Security: Replication State Integrity', () => {
  const validState = {
    cid: 'abc123def456',
    replicationFactor: 3,
    confirmedNodes: ['http://node1:3000', 'http://node2:3000'],
    complete: true,
    integrityHash: ''
  };

  beforeEach(() => {
    validState.integrityHash = generateReplicationStateHash(
      validState.cid,
      validState.replicationFactor,
      validState.confirmedNodes,
      validState.complete
    );
  });

  test('should generate consistent hash for same state', () => {
    const hash1 = generateReplicationStateHash(
      validState.cid,
      validState.replicationFactor,
      validState.confirmedNodes,
      validState.complete
    );
    const hash2 = generateReplicationStateHash(
      validState.cid,
      validState.replicationFactor,
      validState.confirmedNodes,
      validState.complete
    );
    expect(hash1).toBe(hash2);
  });

  test('should generate same hash regardless of node order', () => {
    const hash1 = generateReplicationStateHash(
      validState.cid,
      validState.replicationFactor,
      ['http://node1:3000', 'http://node2:3000'],
      validState.complete
    );
    const hash2 = generateReplicationStateHash(
      validState.cid,
      validState.replicationFactor,
      ['http://node2:3000', 'http://node1:3000'], // Different order
      validState.complete
    );
    expect(hash1).toBe(hash2);
  });

  test('should verify valid replication state', () => {
    const result = verifyReplicationStateIntegrity(validState);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('should allow legacy state without hash', () => {
    const legacyState = { ...validState, integrityHash: undefined };
    const result = verifyReplicationStateIntegrity(legacyState);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('legacy_no_hash');
  });

  test('should reject tampered confirmedNodes (added fake node)', () => {
    const tampered = {
      ...validState,
      confirmedNodes: [...validState.confirmedNodes, 'http://fake-node:9999']
    };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered confirmedNodes (removed node)', () => {
    const tampered = {
      ...validState,
      confirmedNodes: ['http://node1:3000'] // Removed one
    };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered complete status', () => {
    const tampered = { ...validState, complete: false };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered replicationFactor', () => {
    const tampered = { ...validState, replicationFactor: 1 };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject tampered CID', () => {
    const tampered = { ...validState, cid: 'different_cid' };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });

  test('should reject corrupted integrity hash', () => {
    const tampered = { ...validState, integrityHash: 'corrupted_hash' };
    const result = verifyReplicationStateIntegrity(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash_mismatch');
  });
});

describe('Security: Attack Scenarios', () => {
  describe('Ciphertext Tampering Attack', () => {
    test('should detect malware injection into blob', () => {
      const originalContent = Buffer.from('legitimate encrypted content');
      const cid = generateCID(originalContent);
      
      // Attacker replaces content with malware
      const malware = Buffer.from('malicious payload here');
      
      // Verification should fail
      expect(verifyCID(cid, malware)).toBe(false);
    });
  });

  describe('Metadata Tampering Attack', () => {
    test('should detect MIME type spoofing (serve malware as image)', () => {
      const metadata = {
        cid: 'malware_blob_cid',
        size: 5000,
        mimeType: 'application/x-executable',
        createdAt: Date.now(),
        pinned: false,
        integrityHash: ''
      };
      
      metadata.integrityHash = generateMetadataIntegrityHash(
        metadata.cid,
        metadata.size,
        metadata.mimeType,
        metadata.createdAt,
        metadata.pinned
      );
      
      // Attacker changes MIME type to trick clients
      const tampered = { ...metadata, mimeType: 'image/png' };
      
      const result = verifyMetadataIntegrity(tampered);
      expect(result.valid).toBe(false);
    });

    test('should detect pin status manipulation', () => {
      const metadata = {
        cid: 'important_blob',
        size: 1000,
        mimeType: 'text/plain',
        createdAt: Date.now(),
        pinned: true, // User pinned this
        integrityHash: ''
      };
      
      metadata.integrityHash = generateMetadataIntegrityHash(
        metadata.cid,
        metadata.size,
        metadata.mimeType,
        metadata.createdAt,
        metadata.pinned
      );
      
      // Attacker removes pin to allow GC deletion
      const tampered = { ...metadata, pinned: false };
      
      const result = verifyMetadataIntegrity(tampered);
      expect(result.valid).toBe(false);
    });
  });

  describe('Replication State Tampering Attack', () => {
    test('should detect false replication claims (data loss attack)', () => {
      const state = {
        cid: 'important_data',
        replicationFactor: 3,
        confirmedNodes: [], // Actually no replicas
        complete: false,
        integrityHash: ''
      };
      
      state.integrityHash = generateReplicationStateHash(
        state.cid,
        state.replicationFactor,
        state.confirmedNodes,
        state.complete
      );
      
      // Attacker claims blob is fully replicated to allow deletion
      const tampered = {
        ...state,
        confirmedNodes: ['http://fake1:3000', 'http://fake2:3000', 'http://fake3:3000'],
        complete: true
      };
      
      const result = verifyReplicationStateIntegrity(tampered);
      expect(result.valid).toBe(false);
    });

    test('should detect "safe to delete" manipulation', () => {
      const state = {
        cid: 'last_copy_of_data',
        replicationFactor: 3,
        confirmedNodes: ['http://node1:3000'], // Only 1 replica
        complete: false,
        integrityHash: ''
      };
      
      state.integrityHash = generateReplicationStateHash(
        state.cid,
        state.replicationFactor,
        state.confirmedNodes,
        state.complete
      );
      
      // Attacker marks as complete to trick GC
      const tampered = { ...state, complete: true };
      
      const result = verifyReplicationStateIntegrity(tampered);
      expect(result.valid).toBe(false);
    });
  });
});
