/**
 * HASHD Vault - Validation Utilities
 */

import { InvalidRequestError, PayloadTooLargeError } from '../types/index.js';
import { config } from '../config/index.js';
import { isValidCID } from './cid.js';

/**
 * Validate store request
 */
export function validateStoreRequest(body: any): void {
  if (!body || typeof body !== 'object') {
    throw new InvalidRequestError('Request body must be a JSON object');
  }

  if (!body.ciphertext || typeof body.ciphertext !== 'string') {
    throw new InvalidRequestError('ciphertext is required and must be a string');
  }

  if (!body.mimeType || typeof body.mimeType !== 'string') {
    throw new InvalidRequestError('mimeType is required and must be a string');
  }

  // For MVP, only support application/json
  if (body.mimeType !== 'application/json') {
    throw new InvalidRequestError('Only application/json mimeType is supported');
  }

  // Check size limit
  const sizeBytes = Buffer.from(body.ciphertext, 'base64').length;
  const maxSizeBytes = config.maxBlobSizeMB * 1024 * 1024;

  if (sizeBytes > maxSizeBytes) {
    throw new PayloadTooLargeError(sizeBytes, maxSizeBytes);
  }
}

/**
 * Validate replicate request
 */
export function validateReplicateRequest(body: any): void {
  if (!body || typeof body !== 'object') {
    throw new InvalidRequestError('Request body must be a JSON object');
  }

  if (!body.cid || typeof body.cid !== 'string') {
    throw new InvalidRequestError('cid is required and must be a string');
  }

  if (!isValidCID(body.cid)) {
    throw new InvalidRequestError('cid must be a valid 64-character hex string');
  }

  if (!body.ciphertext || typeof body.ciphertext !== 'string') {
    throw new InvalidRequestError('ciphertext is required and must be a string');
  }

  if (!body.mimeType || typeof body.mimeType !== 'string') {
    throw new InvalidRequestError('mimeType is required and must be a string');
  }

  if (!body.fromPeer || typeof body.fromPeer !== 'string') {
    throw new InvalidRequestError('fromPeer is required and must be a string');
  }

  // Validate fromPeer is a valid URL
  try {
    new URL(body.fromPeer);
  } catch (error) {
    throw new InvalidRequestError('fromPeer must be a valid URL');
  }
}

/**
 * Validate CID parameter
 */
export function validateCIDParam(cid: string): void {
  if (!cid || typeof cid !== 'string') {
    throw new InvalidRequestError('CID parameter is required');
  }

  if (!isValidCID(cid)) {
    throw new InvalidRequestError('CID must be a valid 64-character hex string');
  }
}
