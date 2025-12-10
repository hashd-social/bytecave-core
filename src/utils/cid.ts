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
