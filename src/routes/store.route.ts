/**
 * HASHD Vault - Store Route
 * POST /store - Store encrypted blob
 */

import { Request, Response } from 'express';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';
import { replicationService } from '../services/replication.service.js';
import { metricsService } from '../services/metrics.service.js';
import { logger } from '../utils/logger.js';
import { generateCID, validateCiphertext } from '../utils/cid.js';
import { validateStoreRequest } from '../utils/validation.js';
import { StoreRequest, StoreResponse } from '../types/index.js';

export async function storeHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    // Validate request
    validateStoreRequest(req.body);

    const { ciphertext, mimeType } = req.body as StoreRequest;

    // Validate and convert ciphertext
    const ciphertextBuffer = validateCiphertext(ciphertext);

    // Generate CID
    const cid = generateCID(ciphertextBuffer);

    logger.info('Store request received', { cid, size: ciphertextBuffer.length });

    // Check capacity before storing (Requirement 2.7)
    const stats = await storageService.getStats();
    const maxCapacityBytes = config.maxStorageGB * 1024 * 1024 * 1024;
    const newTotalSize = stats.totalSize + ciphertextBuffer.length;
    
    if (newTotalSize > maxCapacityBytes) {
      throw new Error(`CAPACITY_EXCEEDED: Node is full (${stats.totalSize}/${maxCapacityBytes} bytes)`);
    }

    // Store blob locally
    await storageService.storeBlob(cid, ciphertextBuffer, mimeType);

    // Replicate to peers (async, don't wait)
    const replicationPromise = replicationService
      .replicateToAll(cid, ciphertextBuffer, mimeType)
      .then(peers => {
        logger.debug('Replication completed', { cid, peers: peers.length });
        return peers;
      })
      .catch(err => {
        logger.warn('Replication failed', { cid, error: err.message });
        return [];
      });

    // Wait for replication with timeout
    const replicationSuggested = await Promise.race([
      replicationPromise,
      new Promise<string[]>(resolve => setTimeout(() => resolve([]), 2000))
    ]);

    const response: StoreResponse = {
      cid,
      replicationSuggested,
      storedAt: Date.now()
    };

    const latency = Date.now() - startTime;
    metricsService.recordRequest(true, latency, ciphertextBuffer.length);

    res.status(201).json(response);

    logger.info('Blob stored successfully', {
      cid,
      size: ciphertextBuffer.length,
      latency,
      replicated: replicationSuggested.length
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
