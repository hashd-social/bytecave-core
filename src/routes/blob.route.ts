/**
 * HASHD Vault - Blob Route
 * GET /blob/:cid - Retrieve stored blob
 */

import { Request, Response } from 'express';
import { storageService } from '../services/storage.service.js';
import { banlistService } from '../services/banlist.service.js';
import { metricsService } from '../services/metrics.service.js';
import { logger } from '../utils/logger.js';
import { validateCIDParam } from '../utils/validation.js';
import { bufferToBase64 } from '../utils/cid.js';
import { BlobResponse, BlobBannedError } from '../types/index.js';

export async function blobHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const { cid } = req.params;

    // Validate CID
    validateCIDParam(cid);

    logger.debug('Blob request received', { cid });

    // Check banlist
    const isBanned = await banlistService.isBanned(cid);
    if (isBanned) {
      throw new BlobBannedError(cid);
    }

    // Retrieve blob
    const { ciphertext, metadata } = await storageService.getBlob(cid);

    const response: BlobResponse = {
      cid,
      ciphertext: bufferToBase64(ciphertext),
      mimeType: metadata.mimeType,
      createdAt: metadata.createdAt,
      size: metadata.size,
      version: metadata.version
    };

    const latency = Date.now() - startTime;
    metricsService.recordRequest(true, latency, ciphertext.length);

    res.status(200).json(response);

    logger.debug('Blob retrieved successfully', {
      cid,
      size: ciphertext.length,
      latency
    });
  } catch (error: any) {
    const latency = Date.now() - startTime;
    metricsService.recordRequest(false, latency);

    logger.error('Blob request failed', error, { cid: req.params.cid });

    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.code || 'BLOB_RETRIEVAL_FAILED',
      message: error.message,
      cid: req.params.cid,
      timestamp: Date.now()
    });
  }
}
