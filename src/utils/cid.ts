/**
 * HASHD Vault - Content Identifier (CID) Utilities
 * 
 * Uses SHA-256 for deterministic content addressing
 */

import crypto from 'crypto';
import { InvalidRequestError } from '../types/index.js';

/**
 * Generate CID from ciphertext
 * @param ciphertext - Base64 or hex encoded ciphertext
 * @returns 64-character hex string (SHA-256 hash)
 */
export function generateCID(ciphertext: string | Buffer): string {
  const buffer = Buffer.isBuffer(ciphertext)
    ? ciphertext
    : Buffer.from(ciphertext, 'base64');

  const hash = crypto.createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Verify that CID matches ciphertext
 * @param cid - Expected CID
 * @param ciphertext - Ciphertext to verify
 * @returns true if CID matches
 */
export function verifyCID(cid: string, ciphertext: string | Buffer): boolean {
  const computedCID = generateCID(ciphertext);
  return computedCID === cid.toLowerCase();
}

/**
 * Validate CID format
 * @param cid - CID to validate
 * @returns true if valid format
 */
export function isValidCID(cid: string): boolean {
  // CID must be 64-character hex string (SHA-256)
  return /^[a-f0-9]{64}$/i.test(cid);
}

/**
 * Validate and normalize ciphertext
 * @param ciphertext - Ciphertext string
 * @returns Buffer
 */
export function validateCiphertext(ciphertext: string): Buffer {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new InvalidRequestError('ciphertext must be a non-empty string');
  }

  // Try to decode as base64
  try {
    return Buffer.from(ciphertext, 'base64');
  } catch (error) {
    throw new InvalidRequestError('ciphertext must be valid base64');
  }
}

/**
 * Convert buffer to base64 string
 * @param buffer - Buffer to convert
 * @returns Base64 string
 */
export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Generate integrity hash for metadata
 * SECURITY: Creates HMAC of critical metadata fields to detect tampering
 * @param cid - Content ID (used as part of the key)
 * @param size - Blob size
 * @param mimeType - MIME type
 * @param createdAt - Creation timestamp
 * @param pinned - Pin status
 * @returns Hex string of HMAC
 */
export function generateMetadataIntegrityHash(
  cid: string,
  size: number,
  mimeType: string,
  createdAt: number,
  pinned: boolean = false
): string {
  // Use CID as part of the key to bind metadata to specific blob
  const key = `vault-meta-${cid}`;
  const data = `${cid}:${size}:${mimeType}:${createdAt}:${pinned}`;
  
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * Verify metadata integrity hash
 * @param metadata - Metadata object to verify
 * @returns true if integrity hash is valid or missing (legacy), false if tampered
 */
export function verifyMetadataIntegrity(metadata: {
  cid: string;
  size: number;
  mimeType: string;
  createdAt: number;
  pinned?: boolean;
  integrityHash?: string;
}): { valid: boolean; reason?: string } {
  // Legacy metadata without hash - allow but flag
  if (!metadata.integrityHash) {
    return { valid: true, reason: 'legacy_no_hash' };
  }

  const expectedHash = generateMetadataIntegrityHash(
    metadata.cid,
    metadata.size,
    metadata.mimeType,
    metadata.createdAt,
    metadata.pinned || false
  );

  if (metadata.integrityHash !== expectedHash) {
    return { valid: false, reason: 'hash_mismatch' };
  }

  return { valid: true };
}

/**
 * Generate integrity hash for replication state
 * SECURITY: Prevents tampering with replication claims
 */
export function generateReplicationStateHash(
  cid: string,
  replicationFactor: number,
  confirmedNodes: string[],
  complete: boolean
): string {
  const key = `vault-repl-${cid}`;
  // Sort confirmed nodes for deterministic hash
  const sortedNodes = [...confirmedNodes].sort().join(',');
  const data = `${cid}:${replicationFactor}:${sortedNodes}:${complete}`;
  
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * Verify replication state integrity
 */
export function verifyReplicationStateIntegrity(state: {
  cid: string;
  replicationFactor: number;
  confirmedNodes: string[];
  complete: boolean;
  integrityHash?: string;
}): { valid: boolean; reason?: string } {
  if (!state.integrityHash) {
    return { valid: true, reason: 'legacy_no_hash' };
  }

  const expectedHash = generateReplicationStateHash(
    state.cid,
    state.replicationFactor,
    state.confirmedNodes,
    state.complete
  );

  if (state.integrityHash !== expectedHash) {
    return { valid: false, reason: 'hash_mismatch' };
  }

  return { valid: true };
}
