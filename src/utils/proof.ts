/**
 * HASHD Vault - Storage Proof Utilities
 * 
 * Implements Requirement 4: Storage Proofs
 * - Challenge generation (R4.1)
 * - Proof signing (R4.1, R4.5)
 * - Proof verification (R4.3)
 */

import crypto from 'crypto';
import { StorageProof, ProofVerificationResult } from '../types/index.js';

/**
 * Generate a challenge for a CID at a given timestamp (R4.1)
 * @param cid Content identifier
 * @param timestamp Unix timestamp (truncated to hour boundary)
 * @returns Challenge hash
 */
export function generateChallenge(cid: string, timestamp?: number): string {
  // Truncate to hour boundary to prevent replay attacks
  const hourTimestamp = timestamp 
    ? Math.floor(timestamp / 3600) * 3600 
    : Math.floor(Date.now() / 1000 / 3600) * 3600;
  
  const data = Buffer.concat([
    Buffer.from(cid, 'hex'),
    Buffer.from(hourTimestamp.toString())
  ]);
  
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate proof data to be signed (R4.1)
 * @param cid Content identifier
 * @param challenge Challenge hash
 * @param nodeId Node identifier
 * @returns Hash to be signed
 */
export function generateProofData(cid: string, challenge: string, nodeId: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(cid, 'hex'),
    Buffer.from(challenge, 'hex'),
    Buffer.from(nodeId, 'utf8')
  ]);
  
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Sign a storage proof (R4.5)
 * @param privateKey Ed25519 private key (32 bytes)
 * @param cid Content identifier
 * @param challenge Challenge hash
 * @param nodeId Node identifier
 * @returns Signature (hex string)
 */
export function signProof(
  privateKey: Buffer,
  cid: string,
  challenge: string,
  nodeId: string
): string {
  const proofData = generateProofData(cid, challenge, nodeId);
  
  // Use Ed25519 for signing
  const signature = crypto.sign(null, proofData, {
    key: privateKey,
    format: 'der',
    type: 'pkcs8'
  });
  
  return signature.toString('hex');
}

/**
 * Verify a storage proof signature (R4.3)
 * @param proof Storage proof to verify
 * @param publicKey Ed25519 public key (hex string)
 * @returns Verification result
 */
export function verifyProof(
  proof: StorageProof,
  publicKey: string
): ProofVerificationResult {
  try {
    // Regenerate proof data
    const proofData = generateProofData(proof.cid, proof.challenge, proof.nodeId);
    
    // Verify signature
    const isValid = crypto.verify(
      null,
      proofData,
      {
        key: Buffer.from(publicKey, 'hex'),
        format: 'der',
        type: 'spki'
      },
      Buffer.from(proof.signature, 'hex')
    );
    
    if (!isValid) {
      return {
        valid: false,
        error: 'Invalid signature'
      };
    }
    
    // Check timestamp freshness (R4.3)
    const now = Math.floor(Date.now() / 1000);
    const proofAge = now - proof.timestamp;
    const maxAge = 3600; // 1 hour
    
    if (proofAge > maxAge) {
      return {
        valid: false,
        error: `Proof too old: ${proofAge}s (max: ${maxAge}s)`
      };
    }
    
    if (proofAge < -300) { // 5 minutes in future
      return {
        valid: false,
        error: 'Proof timestamp in future'
      };
    }
    
    return {
      valid: true,
      nodeId: proof.nodeId,
      timestamp: proof.timestamp
    };
  } catch (error: any) {
    return {
      valid: false,
      error: `Verification failed: ${error.message}`
    };
  }
}

/**
 * Verify challenge freshness (R4.3)
 * @param challenge Challenge hash
 * @param cid Content identifier
 * @param timestamp Timestamp used to generate challenge
 * @returns true if challenge is valid for the given CID and timestamp
 */
export function verifyChallengeFormat(
  challenge: string,
  cid: string,
  timestamp: number
): boolean {
  const expectedChallenge = generateChallenge(cid, timestamp);
  return challenge === expectedChallenge;
}

/**
 * Generate Ed25519 key pair for testing
 * @returns Key pair {publicKey, privateKey}
 */
export function generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  
  return {
    publicKey: Buffer.from(publicKey),
    privateKey: Buffer.from(privateKey)
  };
}

/**
 * Truncate timestamp to hour boundary (R4.1)
 * @param timestamp Unix timestamp in seconds
 * @returns Truncated timestamp
 */
export function truncateToHour(timestamp: number): number {
  return Math.floor(timestamp / 3600) * 3600;
}

/**
 * Check if proof is within valid time window (R4.6)
 * @param timestamp Proof timestamp
 * @param maxAgeSeconds Maximum age in seconds
 * @returns true if proof is fresh
 */
export function isProofFresh(timestamp: number, maxAgeSeconds: number = 3600): boolean {
  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;
  return age >= 0 && age <= maxAgeSeconds;
}
