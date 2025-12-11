/**
 * Integration Tests for HASHD Vault
 * 
 * Tests end-to-end workflows combining multiple components
 */

import { generateCID, validateCiphertext } from '../src/utils/cid.js';
import { generateChallenge, signProof, verifyProof, generateKeyPair } from '../src/utils/proof.js';
import { calculateShardKey, shouldNodeStoreCid } from '../src/utils/sharding.js';
import { selectNodesForReplicationWithShards } from '../src/utils/node-selection.js';
import { StorageProof } from '../src/types/index.js';

describe('End-to-End Blob Storage Workflow', () => {
  test('should complete full blob storage workflow', () => {
    // 1. Client encrypts and encodes blob
    const plaintext = 'Hello, HASHD Vault!';
    const ciphertext = Buffer.from(plaintext); // In reality, this would be encrypted
    const base64Ciphertext = ciphertext.toString('base64');
    
    // 2. Generate CID
    const cid = generateCID(ciphertext);
    expect(cid).toBeTruthy();
    expect(cid).toHaveLength(64);
    
    // 3. Validate ciphertext
    const validatedCiphertext = validateCiphertext(base64Ciphertext);
    expect(validatedCiphertext).toEqual(ciphertext);
    
    // 4. Calculate shard
    const shardCount = 1024;
    const shardKey = calculateShardKey(cid, shardCount);
    expect(shardKey).toBeGreaterThanOrEqual(0);
    expect(shardKey).toBeLessThan(shardCount);
    
    // 5. Check if node should store
    const nodeShards = [{ start: 0, end: 1023 }];
    const shouldStore = shouldNodeStoreCid(cid, nodeShards, shardCount);
    expect(shouldStore).toBe(true);
  });
});

describe('End-to-End Proof Workflow', () => {
  test('should complete full proof generation and verification', () => {
    // 1. Generate node keys
    const { publicKey, privateKey } = generateKeyPair();
    
    // 2. Store a blob
    const ciphertext = Buffer.from('test data');
    const cid = generateCID(ciphertext);
    
    // 3. Client generates challenge
    const challenge = generateChallenge(cid);
    expect(challenge).toBeTruthy();
    
    // 4. Node generates proof
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
    
    // 5. Client verifies proof
    const result = verifyProof(proof, publicKey.toString('hex'));
    expect(result.valid).toBe(true);
    expect(result.nodeId).toBe(nodeId);
  });

  test('should reject invalid proof in workflow', () => {
    const { publicKey } = generateKeyPair();
    const { privateKey: wrongKey } = generateKeyPair();
    
    const ciphertext = Buffer.from('test data');
    const cid = generateCID(ciphertext);
    const challenge = generateChallenge(cid);
    const nodeId = 'test-node';
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Sign with wrong key
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
  });
});

describe('End-to-End Replication Workflow', () => {
  test('should select nodes for replication with sharding', () => {
    // 1. Client has a blob
    const ciphertext = Buffer.from('test data');
    const cid = generateCID(ciphertext);
    
    // 2. Calculate shard
    const shardCount = 1024;
    const shardKey = calculateShardKey(cid, shardCount);
    
    // 3. Get available nodes
    const availableNodes = [
      { 
        nodeId: 'node-1', 
        url: 'http://node1.test', 
        score: 800,
        shards: [{ start: 0, end: 255 }]
      },
      { 
        nodeId: 'node-2', 
        url: 'http://node2.test', 
        score: 750,
        shards: [{ start: 256, end: 511 }]
      },
      { 
        nodeId: 'node-3', 
        url: 'http://node3.test', 
        score: 700,
        shards: [{ start: 512, end: 767 }]
      },
      { 
        nodeId: 'node-4', 
        url: 'http://node4.test', 
        score: 650,
        shards: [{ start: 768, end: 1023 }]
      }
    ];
    
    // 4. Select nodes for replication
    const replicationFactor = 3;
    const result = selectNodesForReplicationWithShards(
      cid,
      availableNodes,
      replicationFactor,
      shardCount
    );
    
    // 5. Verify selection
    expect(result.selected.length).toBeGreaterThan(0);
    
    // All selected nodes should be responsible for the shard
    result.selected.forEach(node => {
      const nodeWithShards = node as any; // Type assertion for test
      if (nodeWithShards.shards) {
        const isResponsible = nodeWithShards.shards.some((range: any) => 
          shardKey >= range.start && shardKey <= range.end
        );
        expect(isResponsible).toBe(true);
      }
    });
  });
});

describe('End-to-End Shard Distribution', () => {
  test('should distribute blobs across shards evenly', () => {
    const shardCount = 256;
    const shardDistribution = new Array(shardCount).fill(0);
    
    // Generate 1000 CIDs and track their shards
    for (let i = 0; i < 1000; i++) {
      const ciphertext = Buffer.from(`blob-${i}`);
      const cid = generateCID(ciphertext);
      const shardKey = calculateShardKey(cid, shardCount);
      
      shardDistribution[shardKey]++;
    }
    
    // Check distribution is relatively even
    const avg = 1000 / shardCount;
    const nonZeroShards = shardDistribution.filter(count => count > 0).length;
    
    // Should use most shards
    expect(nonZeroShards).toBeGreaterThan(shardCount * 0.8);
    
    // No shard should be heavily overloaded
    const maxCount = Math.max(...shardDistribution);
    expect(maxCount).toBeLessThan(avg * 3);
  });
});

describe('End-to-End Reputation Impact', () => {
  test('should affect node selection based on reputation', () => {
    const cid = '123abc';
    const shardCount = 1024;
    
    const nodes = [
      { 
        nodeId: 'good-node', 
        url: 'http://good.test', 
        score: 900,
        shards: [{ start: 0, end: 1023 }]
      },
      { 
        nodeId: 'bad-node', 
        url: 'http://bad.test', 
        score: 100, // Below threshold
        shards: [{ start: 0, end: 1023 }]
      }
    ];
    
    const result = selectNodesForReplicationWithShards(
      cid,
      nodes,
      2,
      shardCount
    );
    
    // Bad node should be excluded
    const selectedIds = result.selected.map(n => n.nodeId);
    expect(selectedIds).not.toContain('bad-node');
    
    // Should have exclusion reason
    const badNodeExclusion = result.excluded.find(e => e.nodeId === 'bad-node');
    expect(badNodeExclusion).toBeDefined();
    expect(badNodeExclusion?.reason).toContain('reputation');
  });
});
