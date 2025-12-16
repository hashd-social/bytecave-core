/**
 * HASHD Vault - Replicate Route
 * POST /replicate - Receive replicated blob from peer
 */

import { Request, Response } from 'express';
import { storageService } from '../services/storage.service.js';
import { metricsService } from '../services/metrics.service.js';
import { logger } from '../utils/logger.js';
import { validateCiphertext, verifyCID } from '../utils/cid.js';
import { validateReplicateRequest } from '../utils/validation.js';
import { ReplicateRequest, ReplicateResponse, CIDMismatchError } from '../types/index.js';

export async function replicateHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    // Validate request
    validateReplicateRequest(req.body);

    const { cid, ciphertext, mimeType, fromPeer, contentType, guildId } = req.body as ReplicateRequest;

    logger.debug('Replication request received', { cid, fromPeer, contentType });

    // Validate and convert ciphertext
    const ciphertextBuffer = validateCiphertext(ciphertext);

    // Verify CID matches ciphertext
    const isValid = verifyCID(cid, ciphertextBuffer);
    if (!isValid) {
      throw new CIDMismatchError(cid, 'computed CID does not match');
    }

    // Check if already stored
    const alreadyStored = await storageService.hasBlob(cid);

    if (!alreadyStored) {
      // Store blob with replication and content metadata
      await storageService.storeBlob(cid, ciphertextBuffer, mimeType, { 
        fromPeer,
        contentType,
        guildId
      });
      logger.info('Replicated blob stored', { cid, fromPeer, size: ciphertextBuffer.length, contentType });
    } else {
      logger.debug('Blob already stored', { cid });
    }

    const response: ReplicateResponse = {
      success: true,
      cid,
      alreadyStored
    };

    const latency = Date.now() - startTime;
    metricsService.recordRequest(true, latency);
    metricsService.recordReplication(true);

    res.status(200).json(response);
  } catch (error: any) {
    const latency = Date.now() - startTime;
    metricsService.recordRequest(false, latency);
    metricsService.recordReplication(false);

    logger.error('Replication request failed', error);

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.code || 'REPLICATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
