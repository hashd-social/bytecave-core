/**
 * HASHD Vault - Client-Side Proof Verification (R4.3)
 * 
 * This module can be used by clients to verify storage proofs
 * WITHOUT relying on the node itself.
 * 
 * Usage in React/Web:
 * import { verifyStorageProof, generateChallenge } from './proof-verification';
 */

import crypto from 'crypto';

export interface StorageProofData {
  cid: string;
  nodeId: string;
  timestamp: number;
  challenge: string;
  signature: string;
  publicKey: string;
}

export interface NodeRegistryInfo {
  nodeId: string;
  publicKey: string;
  active: boolean;
  url: string;
}

export interface ProofVerificationOptions {
  maxAgeSeconds?: number;          // Maximum proof age (default: 3600)
  requireNodeActive?: boolean;      // Require node to be active (default: true)
  registryInfo?: NodeRegistryInfo;  // Optional registry data for verification
}

export interface ProofVerificationResult {
  valid: boolean;
  nodeId?: string;
  timestamp?: number;
  errors: string[];
  warnings: string[];
}

/**
 * Generate a challenge for a CID (R4.1)
 * @param cid Content identifier (hex string)
 * @param timestamp Unix timestamp (optional, defaults to current hour)
 * @returns Challenge hash (hex string)
 */
export function generateChallenge(cid: string, timestamp?: number): string {
  // Truncate to hour boundary
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
 * Verify a storage proof (R4.3)
 * 
 * This function performs complete client-side verification:
 * 1. Node is registered and active (if registry info provided)
 * 2. Public key matches on-chain record
 * 3. Signature is valid
 * 4. Challenge timestamp is fresh
 * 
 * @param proof Storage proof to verify
 * @param options Verification options
 * @returns Verification result with errors/warnings
 */
export function verifyStorageProof(
  proof: StorageProofData,
  options: ProofVerificationOptions = {}
): ProofVerificationResult {
  const {
    maxAgeSeconds = 3600,
    requireNodeActive = true,
    registryInfo
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Verify node is registered and active (R4.3)
  if (registryInfo) {
    if (registryInfo.nodeId !== proof.nodeId) {
      errors.push('Node ID mismatch with registry');
    }

    if (registryInfo.publicKey !== proof.publicKey) {
      errors.push('Public key mismatch with registry');
    }

    if (requireNodeActive && !registryInfo.active) {
      errors.push('Node is not active in registry');
    }
  } else {
    warnings.push('Registry info not provided - cannot verify node registration');
  }

  // 2. Verify timestamp freshness (R4.3)
  const now = Math.floor(Date.now() / 1000);
  const proofAge = now - proof.timestamp;

  if (proofAge > maxAgeSeconds) {
    errors.push(`Proof too old: ${proofAge}s (max: ${maxAgeSeconds}s)`);
  }

  if (proofAge < -300) { // 5 minutes in future
    errors.push('Proof timestamp in future');
  }

  // 3. Verify signature (R4.3)
  try {
    const proofData = generateProofData(proof.cid, proof.challenge, proof.nodeId);
    
    const isValid = crypto.verify(
      null,
      proofData,
      {
        key: Buffer.from(proof.publicKey, 'hex'),
        format: 'der',
        type: 'spki'
      },
      Buffer.from(proof.signature, 'hex')
    );

    if (!isValid) {
      errors.push('Invalid signature');
    }
  } catch (error: any) {
    errors.push(`Signature verification failed: ${error.message}`);
  }

  // 4. Verify challenge format (R4.3)
  try {
    const expectedChallenge = generateChallenge(proof.cid, proof.timestamp);
    if (proof.challenge !== expectedChallenge) {
      warnings.push('Challenge format may be incorrect');
    }
  } catch (error: any) {
    warnings.push(`Challenge verification failed: ${error.message}`);
  }

  return {
    valid: errors.length === 0,
    nodeId: proof.nodeId,
    timestamp: proof.timestamp,
    errors,
    warnings
  };
}

/**
 * Generate proof data hash (same as server-side)
 * @param cid Content identifier
 * @param challenge Challenge hash
 * @param nodeId Node identifier
 * @returns Hash to verify signature against
 */
function generateProofData(cid: string, challenge: string, nodeId: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(cid, 'hex'),
    Buffer.from(challenge, 'hex'),
    Buffer.from(nodeId, 'utf8')
  ]);
  
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Request a proof from a node (R4.2, R4.6)
 * @param nodeUrl Node API URL
 * @param cid Content identifier
 * @param challenge Challenge hash
 * @returns Storage proof or null if failed
 */
export async function requestProofFromNode(
  nodeUrl: string,
  cid: string,
  challenge: string
): Promise<StorageProofData | null> {
  try {
    const response = await fetch(`${nodeUrl}/proofs/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ cid, challenge })
    });

    if (!response.ok) {
      console.error(`Proof request failed: ${response.status}`);
      return null;
    }

    const data: any = await response.json();

    return {
      cid: data.cid,
      nodeId: data.nodeId,
      timestamp: data.timestamp,
      challenge: data.challenge,
      signature: data.proof,
      publicKey: data.publicKey
    };
  } catch (error) {
    console.error('Failed to request proof:', error);
    return null;
  }
}

/**
 * Verify node can provide valid proof before replication (R4.6)
 * @param nodeUrl Node API URL
 * @param cid Content identifier
 * @param registryInfo Node registry information
 * @returns true if node passes proof verification
 */
export async function verifyNodeBeforeReplication(
  nodeUrl: string,
  cid: string,
  registryInfo?: NodeRegistryInfo
): Promise<boolean> {
  // Generate challenge
  const challenge = generateChallenge(cid);

  // Request proof
  const proof = await requestProofFromNode(nodeUrl, cid, challenge);
  if (!proof) {
    return false;
  }

  // Verify proof
  const result = verifyStorageProof(proof, { registryInfo });
  
  if (!result.valid) {
    console.error('Proof verification failed:', result.errors);
    return false;
  }

  if (result.warnings.length > 0) {
    console.warn('Proof verification warnings:', result.warnings);
  }

  return true;
}

/**
 * Check if proof is fresh (R4.6)
 * @param timestamp Proof timestamp
 * @param maxAgeSeconds Maximum age in seconds
 * @returns true if proof is within valid time window
 */
export function isProofFresh(timestamp: number, maxAgeSeconds: number = 3600): boolean {
  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;
  return age >= 0 && age <= maxAgeSeconds;
}

/**
 * Truncate timestamp to hour boundary
 * @param timestamp Unix timestamp in seconds
 * @returns Truncated timestamp
 */
export function truncateToHour(timestamp: number): number {
  return Math.floor(timestamp / 3600) * 3600;
}
