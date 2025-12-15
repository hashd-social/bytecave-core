/**
 * HASHD Vault - Proof Route
 * POST /proofs/generate - Generate storage proof (R4.2)
 */

import { Request, Response } from 'express';
import { proofService } from '../services/proof.service.js';
import { storageService } from '../services/storage.service.js';
import { reputationService } from '../services/reputation.service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { ProofGenerateRequest, ProofGenerateResponse } from '../types/index.js';

/**
 * Generate storage proof for a CID (R4.2)
 */
export async function proofGenerateHandler(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    // Validate request
    const { cid, challenge } = req.body as ProofGenerateRequest;

    if (!cid || typeof cid !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'cid is required and must be a string',
        timestamp: Date.now()
      });
      return;
    }

    if (!challenge || typeof challenge !== 'string') {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'challenge is required and must be a string',
        timestamp: Date.now()
      });
      return;
    }

    logger.debug('Proof generation request', { cid, challenge });

    // Check if blob exists (R4.9 - Missing blob handling)
    const hasBlob = await storageService.hasBlob(cid);
    if (!hasBlob) {
      res.status(404).json({
        error: 'BLOB_NOT_FOUND',
        message: `Blob not found: ${cid}`,
        timestamp: Date.now()
      });
      return;
    }

    // Generate proof
    const proof = await proofService.generateProof(cid, challenge);

    // Record successful proof generation (R5.9)
    await reputationService.applyReward(config.nodeId, 'proof-success', cid);

    const response: ProofGenerateResponse = {
      nodeId: config.nodeId,
      proof: proof.signature,
      publicKey: proof.publicKey,
      timestamp: proof.timestamp,
      challenge: proof.challenge,
      cid: proof.cid
    };

    const latency = Date.now() - startTime;

    res.status(200).json(response);

    logger.info('Proof generated successfully', {
      cid,
      nodeId: config.nodeId,
      latency
    });
  } catch (error: any) {
    // Record proof failure (R5.9)
    await reputationService.applyPenalty(config.nodeId, 'proof-failure', req.body.cid);

    logger.error('Proof generation failed', error);

    res.status(500).json({
      error: 'PROOF_GENERATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get proofs for a CID
 */
export async function proofListHandler(req: Request, res: Response): Promise<void> {
  try {
    const { cid } = req.params;

    if (!cid) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'cid parameter is required',
        timestamp: Date.now()
      });
      return;
    }

    const proofs = await proofService.getProofs(cid);

    res.json({
      cid,
      count: proofs.length,
      proofs
    });
  } catch (error: any) {
    logger.error('Failed to list proofs', error);

    res.status(500).json({
      error: 'PROOF_LIST_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get proof statistics
 */
export async function proofStatsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await proofService.getStats();

    res.json({
      ...stats,
      publicKey: proofService.getPublicKey(),
      nodeId: config.nodeId
    });
  } catch (error: any) {
    logger.error('Failed to get proof stats', error);

    res.status(500).json({
      error: 'PROOF_STATS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
