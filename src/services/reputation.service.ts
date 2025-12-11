/**
 * HASHD Vault - Reputation Service
 * 
 * Implements Requirement 5: Node Reputation & Reliability Scoring
 * - Event tracking (R5.1)
 * - Score calculation with decay (R5.5)
 * - Penalty application (R5.6)
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ReputationEvent, ReputationEventType, ReputationScore, NodeReputationData } from '../types/index.js';

// Event weights and penalties (R5.1, R5.6)
const EVENT_WEIGHTS: Record<ReputationEventType, number> = {
  'proof-success': 15,
  'proof-failure': -200,
  'blob-available': 10,
  'blob-missing': -250,
  'blob-corrupted': -500,
  'uptime-ping': 5,
  'replication-accepted': 10,
  'replication-failed': -100,
  'invalid-signature': -600,
  'stale-proof': -200,
  'slow-response': -50,
  'no-response': -150
};

const SCORE_MIN = 0;
const SCORE_MAX = 1000;
const INITIAL_SCORE = 500; // Neutral starting point
const DECAY_HALF_LIFE_DAYS = 14; // R5.5

export class ReputationService {
  private eventsFile: string;
  private events: ReputationEvent[] = [];
  private initialized = false;

  constructor() {
    this.eventsFile = path.join(config.dataDir, 'reputation-events.json');
  }

  /**
   * Initialize reputation service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load existing events
      await this.loadEvents();

      this.initialized = true;
      logger.info('Reputation service initialized', {
        eventCount: this.events.length
      });
    } catch (error) {
      logger.error('Failed to initialize reputation service', error);
      throw error;
    }
  }

  /**
   * Record a reputation event (R5.1)
   */
  async recordEvent(
    type: ReputationEventType,
    nodeId?: string,
    cid?: string,
    details?: any
  ): Promise<void> {
    const event: ReputationEvent = {
      type,
      timestamp: Date.now(),
      nodeId: nodeId || config.nodeId,
      cid,
      details
    };

    this.events.push(event);

    // Save events periodically
    if (this.events.length % 10 === 0) {
      await this.saveEvents();
    }

    logger.debug('Reputation event recorded', { type, nodeId, cid });
  }

  /**
   * Calculate reputation score for a node (R5.1, R5.5)
   */
  calculateScore(nodeId: string, asOfTimestamp?: number): number {
    const now = asOfTimestamp || Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    // Filter events for this node in last 7 days
    const relevantEvents = this.events.filter(e =>
      e.nodeId === nodeId &&
      e.timestamp >= sevenDaysAgo &&
      e.timestamp <= now
    );

    if (relevantEvents.length === 0) {
      return INITIAL_SCORE;
    }

    // Calculate weighted sum with decay (R5.5)
    let weightedSum = 0;
    for (const event of relevantEvents) {
      const weight = EVENT_WEIGHTS[event.type] || 0;
      const ageInDays = (now - event.timestamp) / (24 * 60 * 60 * 1000);
      
      // Exponential decay: exp(-(days / half_life))
      const decayFactor = Math.exp(-(ageInDays / DECAY_HALF_LIFE_DAYS));
      
      weightedSum += weight * decayFactor;
    }

    // Start from initial score and apply weighted sum
    let score = INITIAL_SCORE + weightedSum;

    // Clamp to valid range
    score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));

    return Math.round(score);
  }

  /**
   * Get reputation score for a node (R5.4)
   */
  async getNodeReputation(nodeId: string): Promise<NodeReputationData> {
    const nodeEvents = this.events.filter(e => e.nodeId === nodeId);
    
    const firstEvent = nodeEvents[0];
    const lastEvent = nodeEvents[nodeEvents.length - 1];

    return {
      nodeId,
      score: this.calculateScore(nodeId),
      events: nodeEvents.slice(-100), // Last 100 events
      firstSeen: firstEvent?.timestamp || Date.now(),
      lastSeen: lastEvent?.timestamp || Date.now()
    };
  }

  /**
   * Get reputation snapshot (R5.3)
   */
  async getSnapshot(): Promise<{ nodeId: string; score: number; timestamp: number }> {
    return {
      nodeId: config.nodeId,
      score: this.calculateScore(config.nodeId),
      timestamp: Date.now()
    };
  }

  /**
   * Get all node scores
   */
  async getAllScores(): Promise<ReputationScore[]> {
    const nodeIds = new Set(this.events.map(e => e.nodeId).filter(Boolean) as string[]);
    const scores: ReputationScore[] = [];

    for (const nodeId of nodeIds) {
      const nodeEvents = this.events.filter(e => e.nodeId === nodeId);
      const lastEvent = nodeEvents[nodeEvents.length - 1];

      scores.push({
        nodeId,
        score: this.calculateScore(nodeId),
        lastSeen: lastEvent?.timestamp || 0,
        eventCount: nodeEvents.length,
        lastUpdated: Date.now()
      });
    }

    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply reputation penalty (R5.6)
   */
  async applyPenalty(
    nodeId: string,
    eventType: ReputationEventType,
    cid?: string,
    details?: any
  ): Promise<void> {
    await this.recordEvent(eventType, nodeId, cid, details);
    
    const newScore = this.calculateScore(nodeId);
    logger.info('Reputation penalty applied', {
      nodeId,
      eventType,
      penalty: EVENT_WEIGHTS[eventType],
      newScore
    });
  }

  /**
   * Apply reputation reward
   */
  async applyReward(
    nodeId: string,
    eventType: ReputationEventType,
    cid?: string,
    details?: any
  ): Promise<void> {
    await this.recordEvent(eventType, nodeId, cid, details);
    
    const newScore = this.calculateScore(nodeId);
    logger.debug('Reputation reward applied', {
      nodeId,
      eventType,
      reward: EVENT_WEIGHTS[eventType],
      newScore
    });
  }

  /**
   * Clean up old events (older than 30 days)
   */
  async cleanupOldEvents(): Promise<void> {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const initialCount = this.events.length;

    this.events = this.events.filter(e => e.timestamp >= thirtyDaysAgo);

    const removed = initialCount - this.events.length;
    if (removed > 0) {
      await this.saveEvents();
      logger.info('Cleaned up old reputation events', { removed });
    }
  }

  /**
   * Load events from disk
   */
  private async loadEvents(): Promise<void> {
    try {
      const data = await fs.readFile(this.eventsFile, 'utf8');
      this.events = JSON.parse(data);
      logger.debug('Loaded reputation events', { count: this.events.length });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.events = [];
        logger.debug('No existing reputation events found');
      } else {
        throw error;
      }
    }
  }

  /**
   * Save events to disk
   */
  private async saveEvents(): Promise<void> {
    try {
      await fs.writeFile(
        this.eventsFile,
        JSON.stringify(this.events, null, 2)
      );
    } catch (error) {
      logger.error('Failed to save reputation events', error);
    }
  }

  /**
   * Get reputation statistics
   */
  async getStats(): Promise<{
    totalEvents: number;
    uniqueNodes: number;
    avgScore: number;
    topNodes: ReputationScore[];
  }> {
    const scores = await this.getAllScores();
    const avgScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length
      : INITIAL_SCORE;

    return {
      totalEvents: this.events.length,
      uniqueNodes: scores.length,
      avgScore: Math.round(avgScore),
      topNodes: scores.slice(0, 10)
    };
  }
}

// Singleton instance
export const reputationService = new ReputationService();
