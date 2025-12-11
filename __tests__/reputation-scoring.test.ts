/**
 * Tests for Reputation Scoring System
 */

import { ReputationService } from '../src/services/reputation.service.js';

describe('Reputation Scoring', () => {
  let reputationService: ReputationService;

  beforeEach(() => {
    reputationService = new ReputationService();
  });

  describe('Event Recording', () => {
    test('should record proof success event', async () => {
      await reputationService.recordEvent('proof-success', 'node-1', 'cid-123');
      
      const reputation = await reputationService.getNodeReputation('node-1');
      
      expect(reputation.events.length).toBeGreaterThan(0);
      expect(reputation.events[0].type).toBe('proof-success');
    });

    test('should record proof failure event', async () => {
      await reputationService.recordEvent('proof-failure', 'node-1', 'cid-123');
      
      const reputation = await reputationService.getNodeReputation('node-1');
      
      expect(reputation.events.length).toBeGreaterThan(0);
      expect(reputation.events[0].type).toBe('proof-failure');
    });

    test('should record multiple events', async () => {
      await reputationService.recordEvent('proof-success', 'node-1');
      await reputationService.recordEvent('blob-available', 'node-1');
      await reputationService.recordEvent('uptime-ping', 'node-1');
      
      const reputation = await reputationService.getNodeReputation('node-1');
      
      expect(reputation.events.length).toBe(3);
    });
  });

  describe('Score Calculation', () => {
    test('should start with initial score of 500', () => {
      const score = reputationService.calculateScore('new-node');
      
      expect(score).toBe(500);
    });

    test('should increase score for positive events', async () => {
      const nodeId = 'node-1';
      
      // Record multiple successful proofs
      for (let i = 0; i < 10; i++) {
        await reputationService.recordEvent('proof-success', nodeId);
      }
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeGreaterThan(500);
    });

    test('should decrease score for negative events', async () => {
      const nodeId = 'node-1';
      
      // Record proof failures
      await reputationService.recordEvent('proof-failure', nodeId);
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeLessThan(500);
    });

    test('should clamp score between 0 and 1000', async () => {
      const nodeId = 'node-1';
      
      // Record many positive events
      for (let i = 0; i < 100; i++) {
        await reputationService.recordEvent('proof-success', nodeId);
      }
      
      let score = reputationService.calculateScore(nodeId);
      expect(score).toBeLessThanOrEqual(1000);
      
      // Record many negative events
      for (let i = 0; i < 100; i++) {
        await reputationService.recordEvent('blob-corrupted', nodeId);
      }
      
      score = reputationService.calculateScore(nodeId);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Reputation Penalties', () => {
    test('should apply penalty for missing blob', async () => {
      const nodeId = 'node-1';
      
      await reputationService.applyPenalty(nodeId, 'blob-missing', 'cid-123');
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeLessThan(500);
    });

    test('should apply severe penalty for corrupted blob', async () => {
      const nodeId = 'node-1';
      
      await reputationService.applyPenalty(nodeId, 'blob-corrupted', 'cid-123');
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeLessThan(500);
    });

    test('should apply critical penalty for invalid signature', async () => {
      const nodeId = 'node-1';
      
      await reputationService.applyPenalty(nodeId, 'invalid-signature', 'cid-123');
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeLessThan(500);
    });
  });

  describe('Reputation Rewards', () => {
    test('should apply reward for successful proof', async () => {
      const nodeId = 'node-1';
      
      await reputationService.applyReward(nodeId, 'proof-success', 'cid-123');
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeGreaterThan(500);
    });

    test('should apply reward for blob availability', async () => {
      const nodeId = 'node-1';
      
      await reputationService.applyReward(nodeId, 'blob-available', 'cid-123');
      
      const score = reputationService.calculateScore(nodeId);
      
      expect(score).toBeGreaterThan(500);
    });
  });

  describe('Reputation Decay', () => {
    test('should apply decay to old events', async () => {
      const nodeId = 'node-1';
      
      // Record event
      await reputationService.recordEvent('proof-success', nodeId);
      
      // Calculate score immediately
      const scoreNow = reputationService.calculateScore(nodeId);
      
      // Calculate score as if 30 days passed
      const futureTimestamp = Date.now() + (30 * 24 * 60 * 60 * 1000);
      const scoreFuture = reputationService.calculateScore(nodeId, futureTimestamp);
      
      // Future score should be closer to 500 (initial) due to decay
      expect(Math.abs(scoreFuture - 500)).toBeLessThan(Math.abs(scoreNow - 500));
    });
  });

  describe('Statistics', () => {
    test('should calculate reputation statistics', async () => {
      await reputationService.recordEvent('proof-success', 'node-1');
      await reputationService.recordEvent('proof-success', 'node-2');
      await reputationService.recordEvent('proof-failure', 'node-3');
      
      const stats = await reputationService.getStats();
      
      expect(stats.totalEvents).toBeGreaterThan(0);
      expect(stats.uniqueNodes).toBeGreaterThan(0);
      expect(stats.avgScore).toBeGreaterThan(0);
    });
  });
});
