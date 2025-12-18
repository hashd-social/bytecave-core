/**
 * HASHD Vault - Store Route
 * POST /store - Store encrypted blob with authorization
 * 
 * Requires on-chain authorization verification for:
 * - group_post: Sender must be group member
 * - group_comment: Sender must be group member
 * - message: Sender must be thread participant
 * - token_distribution: Sender must be group owner
 */

import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';
import { replicationService } from '../services/replication.service.js';
import { metricsService } from '../services/metrics.service.js';
import { storageAuthorizationService } from '../services/storage-authorization.service.js';
import { logger } from '../utils/logger.js';
import { generateCID, validateCiphertext } from '../utils/cid.js';
import { 
  AuthorizedStoreRequest, 
  AuthorizedStoreResponse,
  StorageAuthorization
} from '../types/index.js';
import { normalizeContentType, extractGuildId } from '../middleware/content-filter.middleware.js';

/**
 * Validate the authorization object structure
 */
function validateAuthorization(auth: any): auth is StorageAuthorization {
  if (!auth || typeof auth !== 'object') return false;
  if (!['group_post', 'group_comment', 'message', 'token_distribution'].includes(auth.type)) return false;
  if (!auth.sender || !ethers.isAddress(auth.sender)) return false;
  if (!auth.signature || typeof auth.signature !== 'string') return false;
  if (!auth.timestamp || typeof auth.timestamp !== 'number') return false;
  if (!auth.nonce || typeof auth.nonce !== 'string') return false;
  if (!auth.contentHash || typeof auth.contentHash !== 'string') return false;
  
  // Type-specific validation
  if (auth.type === 'group_post' || auth.type === 'group_comment') {
    if (!auth.groupPostsAddress || !ethers.isAddress(auth.groupPostsAddress)) return false;
  }
  if (auth.type === 'message') {
    if (!auth.threadId || typeof auth.threadId !== 'string') return false;
    if (!auth.participants || !Array.isArray(auth.participants) || auth.participants.length < 2) return false;
  }
  if (auth.type === 'token_distribution') {
    if (!auth.tokenAddress || !ethers.isAddress(auth.tokenAddress)) return false;
  }
  
  return true;
}

export async function storeHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const { ciphertext, mimeType, authorization } = req.body as AuthorizedStoreRequest;

    // Validate required fields
    if (!ciphertext || typeof ciphertext !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'ciphertext is required',
        timestamp: Date.now()
      });
      return;
    }

    if (!mimeType || typeof mimeType !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'mimeType is required',
        timestamp: Date.now()
      });
      return;
    }

    if (!authorization) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'authorization is required',
        timestamp: Date.now()
      });
      return;
    }

    // Validate authorization structure
    if (!validateAuthorization(authorization)) {
      res.status(400).json({
        error: 'INVALID_AUTHORIZATION',
        message: 'Invalid authorization object structure',
        timestamp: Date.now()
      });
      return;
    }

    // Validate and convert ciphertext
    const ciphertextBuffer = validateCiphertext(ciphertext);

    // Compute content hash for verification
    const actualContentHash = ethers.keccak256(ciphertextBuffer);

    // Verify authorization
    const authResult = await storageAuthorizationService.verifyAuthorization(
      authorization,
      actualContentHash
    );

    if (!authResult.authorized) {
      logger.warn('Authorization failed', {
        sender: authorization.sender,
        type: authorization.type,
        error: authResult.error
      });
      
      res.status(403).json({
        error: 'FORBIDDEN',
        message: authResult.error || 'Authorization failed',
        details: authResult.details,
        timestamp: Date.now()
      });
      return;
    }

    // Generate CID
    const cid = generateCID(ciphertextBuffer);

    // Check if CID is blocked
    const { blockedContentService } = await import('../services/blocked-content.service.js');
    if (await blockedContentService.isBlocked(cid)) {
      logger.warn('Storage rejected: CID is blocked', { cid, sender: authorization.sender });
      res.status(403).json({
        error: 'CONTENT_BLOCKED',
        message: 'This content is blocked by node policy',
        timestamp: Date.now()
      });
      return;
    }

    logger.info('Authorized store request', { 
      cid, 
      size: ciphertextBuffer.length,
      sender: authorization.sender,
      type: authorization.type
    });

    // Check capacity before storing
    const stats = await storageService.getStats();
    const maxCapacityBytes = config.maxStorageGB * 1024 * 1024 * 1024;
    const newTotalSize = stats.totalSize + ciphertextBuffer.length;
    
    if (newTotalSize > maxCapacityBytes) {
      res.status(507).json({
        error: 'STORAGE_FULL',
        message: 'Node storage capacity exceeded',
        timestamp: Date.now()
      });
      return;
    }

    // Extract content type and guild ID for policy tracking
    const contentType = normalizeContentType(authorization.type) || undefined;
    const guildId = extractGuildId(authorization) || undefined;

    // Store blob locally with content metadata
    await storageService.storeBlob(cid, ciphertextBuffer, mimeType, {
      contentType,
      guildId
    });

    // Replicate to peers (async, don't wait)
    const replicationPromise = replicationService
      .replicateToAll(cid, ciphertextBuffer, mimeType)
      .then(peers => {
        logger.debug('Replication completed', { cid, peers: peers.length });
        return peers.length;
      })
      .catch(err => {
        logger.warn('Replication failed', { cid, error: err.message });
        return 0;
      });

    // Wait for replication with timeout
    const confirmedReplicas = await Promise.race([
      replicationPromise,
      new Promise<number>(resolve => setTimeout(() => resolve(0), 2000))
    ]);

    const response: AuthorizedStoreResponse = {
      success: true,
      cid,
      timestamp: Date.now(),
      replicationStatus: {
        target: config.replicationFactor,
        confirmed: confirmedReplicas + 1 // +1 for this node
      }
    };

    const latency = Date.now() - startTime;
    metricsService.recordRequest(true, latency, ciphertextBuffer.length);

    res.status(201).json(response);

    logger.info('Blob stored successfully', {
      cid,
      size: ciphertextBuffer.length,
      sender: authorization.sender,
      type: authorization.type,
      latency,
      replicas: confirmedReplicas + 1
    });
  } catch (error: any) {
    const latency = Date.now() - startTime;
    metricsService.recordRequest(false, latency);

    logger.error('Store request failed', error);

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.code || 'STORE_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
