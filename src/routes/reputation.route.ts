/**
 * HASHD Vault - Reputation Routes
 * 
 * Implements Requirement 5: Reputation API
 * - GET /reputation/score (R5.7)
 * - GET /reputation/snapshot (R5.3, R5.7)
 * - POST /reputation/report (R5.7)
 * - GET /node/reputation (R5.4)
 */

import { Request, Response } from 'express';
import { reputationService } from '../services/reputation.service.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ReputationReport } from '../types/index.js';

/**
 * Get node's reputation score (R5.7)
 */
export async function reputationScoreHandler(_req: Request, res: Response): Promise<void> {
  try {
    const reputation = await reputationService.getNodeReputation(config.nodeId);

    res.json({
      nodeId: reputation.nodeId,
      score: reputation.score,
      eventCount: reputation.events.length,
      firstSeen: reputation.firstSeen,
      lastSeen: reputation.lastSeen
    });
  } catch (error: any) {
    logger.error('Failed to get reputation score', error);

    res.status(500).json({
      error: 'REPUTATION_SCORE_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get reputation snapshot (R5.3, R5.7)
 */
export async function reputationSnapshotHandler(_req: Request, res: Response): Promise<void> {
  try {
    const snapshot = await reputationService.getSnapshot();

    res.json(snapshot);
  } catch (error: any) {
    logger.error('Failed to get reputation snapshot', error);

    res.status(500).json({
      error: 'REPUTATION_SNAPSHOT_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Submit reputation report (R5.7)
 */
export async function reputationReportHandler(req: Request, res: Response): Promise<void> {
  try {
    const report = req.body as ReputationReport;

    // Validate report
    if (!report.nodeId || !report.eventType) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'nodeId and eventType are required',
        timestamp: Date.now()
      });
      return;
    }

    // Record the event
    await reputationService.recordEvent(
      report.eventType,
      report.nodeId,
      report.cid,
      { reporter: report.reporter || 'anonymous' }
    );

    logger.info('Reputation report received', {
      nodeId: report.nodeId,
      eventType: report.eventType,
      reporter: report.reporter
    });

    res.json({
      success: true,
      message: 'Report recorded',
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to process reputation report', error);

    res.status(500).json({
      error: 'REPUTATION_REPORT_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get node's full reputation data (R5.4)
 */
export async function nodeReputationHandler(_req: Request, res: Response): Promise<void> {
  try {
    const reputation = await reputationService.getNodeReputation(config.nodeId);

    res.json({
      nodeId: reputation.nodeId,
      score: reputation.score,
      events: reputation.events,
      firstSeen: reputation.firstSeen,
      lastSeen: reputation.lastSeen
    });
  } catch (error: any) {
    logger.error('Failed to get node reputation', error);

    res.status(500).json({
      error: 'NODE_REPUTATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get reputation statistics
 */
export async function reputationStatsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await reputationService.getStats();

    res.json(stats);
  } catch (error: any) {
    logger.error('Failed to get reputation stats', error);

    res.status(500).json({
      error: 'REPUTATION_STATS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get all node scores
 */
export async function allScoresHandler(_req: Request, res: Response): Promise<void> {
  try {
    const scores = await reputationService.getAllScores();

    res.json({
      count: scores.length,
      scores
    });
  } catch (error: any) {
    logger.error('Failed to get all scores', error);

    res.status(500).json({
      error: 'ALL_SCORES_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
