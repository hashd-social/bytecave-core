/**
 * HASHD Vault - Feed Routes
 * 
 * Implements Requirement 10: Encrypted Multi-Writer Feeds
 * - GET /feed/:feedId - Get feed metadata and events (R10.8)
 * - GET /feed/:feedId/blobs - Get blob CIDs for feed (R10.8)
 * - POST /feed - Create new feed
 * - POST /feed/:feedId/entry - Add entry to feed
 * - GET /feed/:feedId/validate - Validate feed integrity
 */

import { Request, Response } from 'express';
import { feedService } from '../services/feed.service.js';
import { logger } from '../utils/logger.js';
import { FeedEvent, FeedType } from '../types/index.js';

/**
 * Get feed metadata and events (R10.8)
 * 
 * Query params:
 * - limit: number (default 50)
 * - cursor: string (for pagination)
 */
export async function getFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const cursor = req.query.cursor as string;

    const response = await feedService.getFeedEvents(feedId, limit, cursor);

    res.json(response);
  } catch (error: any) {
    logger.error('Failed to get feed', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        error: 'FEED_NOT_FOUND',
        message: error.message,
        timestamp: Date.now()
      });
      return;
    }

    res.status(500).json({
      error: 'FEED_FETCH_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Get blob CIDs for feed (R10.8)
 */
export async function getFeedBlobsHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId } = req.params;

    const cids = await feedService.getFeedBlobs(feedId);

    res.json({
      feedId,
      cids,
      count: cids.length,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to get feed blobs', error);
    res.status(500).json({
      error: 'FEED_BLOBS_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Create new feed
 * 
 * Body: {
 *   feedId: string,
 *   feedType: 'dm' | 'post' | 'listing' | 'activity',
 *   writers: string[]
 * }
 */
export async function createFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId, feedType, writers } = req.body;

    if (!feedId || !feedType || !writers) {
      res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'feedId, feedType, and writers are required',
        timestamp: Date.now()
      });
      return;
    }

    if (!Array.isArray(writers) || writers.length === 0) {
      res.status(400).json({
        error: 'INVALID_WRITERS',
        message: 'writers must be a non-empty array',
        timestamp: Date.now()
      });
      return;
    }

    const metadata = await feedService.createFeed(feedId, feedType as FeedType, writers);

    res.status(201).json({
      ...metadata,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to create feed', error);
    res.status(500).json({
      error: 'FEED_CREATE_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Add entry to feed
 * 
 * Body: FeedEvent
 */
export async function addFeedEntryHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId } = req.params;
    const event: FeedEvent = req.body;

    // Validate required fields
    if (!event.cid || !event.authorKey || !event.signature || event.timestamp === undefined) {
      res.status(400).json({
        error: 'INVALID_EVENT',
        message: 'cid, authorKey, signature, and timestamp are required',
        timestamp: Date.now()
      });
      return;
    }

    // Ensure feedId matches
    event.feedId = feedId;

    await feedService.addEntry(event);

    res.status(201).json({
      success: true,
      feedId,
      cid: event.cid,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to add feed entry', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        error: 'FEED_NOT_FOUND',
        message: error.message,
        timestamp: Date.now()
      });
      return;
    }

    if (error.message.includes('not authorized')) {
      res.status(403).json({
        error: 'UNAUTHORIZED',
        message: error.message,
        timestamp: Date.now()
      });
      return;
    }

    if (error.message.includes('Invalid signature')) {
      res.status(400).json({
        error: 'INVALID_SIGNATURE',
        message: error.message,
        timestamp: Date.now()
      });
      return;
    }

    res.status(500).json({
      error: 'ENTRY_ADD_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Validate feed integrity (R10.6)
 */
export async function validateFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId } = req.params;

    const result = await feedService.validateFeed(feedId);

    res.json({
      feedId,
      ...result,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to validate feed', error);
    res.status(500).json({
      error: 'VALIDATION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * Resolve forks in feed (R10.7)
 */
export async function resolveFeedForksHandler(req: Request, res: Response): Promise<void> {
  try {
    const { feedId } = req.params;

    const result = await feedService.resolveForks(feedId);

    res.json({
      feedId,
      ...result,
      timestamp: Date.now()
    });
  } catch (error: any) {
    logger.error('Failed to resolve forks', error);
    res.status(500).json({
      error: 'FORK_RESOLUTION_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
