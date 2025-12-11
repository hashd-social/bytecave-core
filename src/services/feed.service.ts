/**
 * HASHD Vault - Feed Service
 * 
 * Implements Requirement 10: Encrypted Multi-Writer Feeds
 * - Feed management (R10.1)
 * - Entry storage and retrieval (R10.2, R10.3)
 * - Root entry handling (R10.4)
 * - Thread reconstruction (R10.6)
 * - Fork resolution (R10.7)
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';
import { verifySignature } from '../utils/crypto.js';
import {
  FeedEvent,
  FeedMetadata,
  FeedType,
  FeedDiscoveryResponse,
  FeedValidationResult,
  ForkResolutionResult
} from '../types/index.js';

export class FeedService {
  private feedsDir: string;
  private initialized = false;

  constructor() {
    this.feedsDir = path.join(config.dataDir, 'feeds');
  }

  /**
   * Initialize feed service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.feedsDir, { recursive: true });
      this.initialized = true;
      logger.info('Feed service initialized', { feedsDir: this.feedsDir });
    } catch (error) {
      logger.error('Failed to initialize feed service', error);
      throw error;
    }
  }

  /**
   * Create a new feed (R10.1)
   */
  async createFeed(
    feedId: string,
    feedType: FeedType,
    writers: string[]
  ): Promise<FeedMetadata> {
    await this.ensureInitialized();

    const metadata: FeedMetadata = {
      feedId,
      feedType,
      rootCid: null,
      writers,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      entryCount: 0
    };

    await this.saveFeedMetadata(metadata);

    logger.info('Feed created', { feedId, feedType, writers: writers.length });

    return metadata;
  }

  /**
   * Add entry to feed (R10.2, R10.3)
   * Each action creates a new blob
   */
  async addEntry(event: FeedEvent): Promise<void> {
    await this.ensureInitialized();

    // Validate event signature (R10.6)
    const isValid = await this.validateEventSignature(event);
    if (!isValid) {
      throw new Error('Invalid event signature');
    }

    // Get feed metadata
    const metadata = await this.getFeedMetadata(event.feedId);
    if (!metadata) {
      throw new Error(`Feed ${event.feedId} not found`);
    }

    // Verify writer authorization (R10.5)
    if (!metadata.writers.includes(event.authorKey)) {
      throw new Error(`Author ${event.authorKey} not authorized for feed ${event.feedId}`);
    }

    // Verify blob exists
    const blobExists = await storageService.hasBlob(event.cid);
    if (!blobExists) {
      throw new Error(`Blob ${event.cid} not found`);
    }

    // If this is the first entry, set as root (R10.4)
    if (metadata.rootCid === null && event.parentCid === null) {
      metadata.rootCid = event.cid;
    }

    // Save event
    await this.saveEvent(event);

    // Update metadata
    metadata.entryCount++;
    metadata.lastUpdatedAt = Date.now();
    await this.saveFeedMetadata(metadata);

    logger.info('Feed entry added', {
      feedId: event.feedId,
      cid: event.cid,
      parentCid: event.parentCid,
      author: event.authorKey.substring(0, 8)
    });
  }

  /**
   * Get feed metadata
   */
  async getFeedMetadata(feedId: string): Promise<FeedMetadata | null> {
    await this.ensureInitialized();

    try {
      const metadataPath = this.getFeedMetadataPath(feedId);
      const content = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get all events for a feed (R10.8)
   */
  async getFeedEvents(
    feedId: string,
    limit = 50,
    cursor?: string
  ): Promise<FeedDiscoveryResponse> {
    await this.ensureInitialized();

    const metadata = await this.getFeedMetadata(feedId);
    if (!metadata) {
      throw new Error(`Feed ${feedId} not found`);
    }

    // Get all events
    const allEvents = await this.loadAllEvents(feedId);

    // Sort by timestamp
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Apply cursor pagination
    let startIndex = 0;
    if (cursor) {
      startIndex = allEvents.findIndex(e => e.cid === cursor) + 1;
    }

    const events = allEvents.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allEvents.length;
    const nextCursor = hasMore ? events[events.length - 1].cid : undefined;

    return {
      feedId,
      metadata,
      events,
      cursor: nextCursor,
      hasMore
    };
  }

  /**
   * Get blob CIDs for a feed (R10.8)
   */
  async getFeedBlobs(feedId: string): Promise<string[]> {
    await this.ensureInitialized();

    const events = await this.loadAllEvents(feedId);
    return events.map(e => e.cid);
  }

  /**
   * Validate feed chain integrity (R10.6)
   */
  async validateFeed(feedId: string): Promise<FeedValidationResult> {
    const result: FeedValidationResult = {
      valid: true,
      errors: [],
      warnings: []
    };

    try {
      const metadata = await this.getFeedMetadata(feedId);
      if (!metadata) {
        result.valid = false;
        result.errors.push('Feed not found');
        return result;
      }

      const events = await this.loadAllEvents(feedId);

      // Validate each event
      for (const event of events) {
        // Check signature
        const sigValid = await this.validateEventSignature(event);
        if (!sigValid) {
          result.valid = false;
          result.errors.push(`Invalid signature for event ${event.cid}`);
        }

        // Check writer authorization
        if (!metadata.writers.includes(event.authorKey)) {
          result.valid = false;
          result.errors.push(`Unauthorized writer ${event.authorKey} for event ${event.cid}`);
        }

        // Check blob exists
        const blobExists = await storageService.hasBlob(event.cid);
        if (!blobExists) {
          result.warnings.push(`Blob ${event.cid} not found`);
        }

        // Check parent chain
        if (event.parentCid) {
          const parentExists = events.some(e => e.cid === event.parentCid);
          if (!parentExists) {
            result.warnings.push(`Parent ${event.parentCid} not found for event ${event.cid}`);
          }
        }
      }

      // Check root entry
      if (metadata.rootCid) {
        const rootExists = events.some(e => e.cid === metadata.rootCid);
        if (!rootExists) {
          result.errors.push(`Root entry ${metadata.rootCid} not found`);
          result.valid = false;
        }
      }

    } catch (error: any) {
      result.valid = false;
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Resolve forks in feed (R10.7)
   * 
   * Rules:
   * 1. Longest valid chain wins
   * 2. If equal length → earliest timestamp root
   * 3. If still tied → lexicographically lowest CID
   */
  async resolveForks(feedId: string): Promise<ForkResolutionResult> {
    const events = await this.loadAllEvents(feedId);
    const metadata = await this.getFeedMetadata(feedId);

    if (!metadata) {
      throw new Error(`Feed ${feedId} not found`);
    }

    // Build chains from root
    const chains = this.buildChains(events, metadata.rootCid);

    if (chains.length <= 1) {
      return {
        winningChain: chains[0] || [],
        discardedChains: [],
        reason: 'No forks detected'
      };
    }

    // Sort chains by resolution rules
    chains.sort((a, b) => {
      // Rule 1: Longest chain wins
      if (a.length !== b.length) {
        return b.length - a.length;
      }

      // Rule 2: Earliest timestamp root
      const aRoot = a[0];
      const bRoot = b[0];
      if (aRoot.timestamp !== bRoot.timestamp) {
        return aRoot.timestamp - bRoot.timestamp;
      }

      // Rule 3: Lexicographically lowest CID
      return aRoot.cid.localeCompare(bRoot.cid);
    });

    return {
      winningChain: chains[0],
      discardedChains: chains.slice(1),
      reason: chains.length > 1 ? 'Fork resolved by chain length/timestamp/CID' : 'No forks'
    };
  }

  /**
   * Build chains from events
   */
  private buildChains(events: FeedEvent[], rootCid: string | null): FeedEvent[][] {
    if (!rootCid) return [];

    const chains: FeedEvent[][] = [];

    // Find all root events
    const roots = events.filter(e => e.parentCid === null || e.cid === rootCid);

    for (const root of roots) {
      const chain: FeedEvent[] = [root];
      let current = root;

      // Follow the chain
      while (true) {
        const children = events.filter(e => e.parentCid === current.cid);
        if (children.length === 0) break;

        // If multiple children, we have a fork - take the first one
        const next = children[0];
        chain.push(next);
        current = next;
      }

      chains.push(chain);
    }

    return chains;
  }

  /**
   * Validate event signature (R10.6)
   */
  private async validateEventSignature(event: FeedEvent): Promise<boolean> {
    try {
      // Construct message to verify
      const message = JSON.stringify({
        feedId: event.feedId,
        cid: event.cid,
        parentCid: event.parentCid,
        timestamp: event.timestamp,
        authorKey: event.authorKey
      });

      return verifySignature(message, event.signature, event.authorKey);
    } catch (error) {
      logger.error('Signature validation failed', error);
      return false;
    }
  }

  /**
   * Save feed metadata
   */
  private async saveFeedMetadata(metadata: FeedMetadata): Promise<void> {
    const feedDir = path.join(this.feedsDir, metadata.feedId);
    await fs.mkdir(feedDir, { recursive: true });
    
    const metadataPath = this.getFeedMetadataPath(metadata.feedId);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Save event
   */
  private async saveEvent(event: FeedEvent): Promise<void> {
    const eventsDir = path.join(this.feedsDir, event.feedId);
    await fs.mkdir(eventsDir, { recursive: true });

    const eventPath = path.join(eventsDir, `${event.cid}.json`);
    await fs.writeFile(eventPath, JSON.stringify(event, null, 2));
  }

  /**
   * Load all events for a feed
   */
  private async loadAllEvents(feedId: string): Promise<FeedEvent[]> {
    const eventsDir = path.join(this.feedsDir, feedId);

    try {
      const files = await fs.readdir(eventsDir);
      const events: FeedEvent[] = [];

      for (const file of files) {
        if (!file.endsWith('.json') || file === 'metadata.json') continue;

        const eventPath = path.join(eventsDir, file);
        const content = await fs.readFile(eventPath, 'utf-8');
        events.push(JSON.parse(content));
      }

      return events;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get feed metadata file path
   */
  private getFeedMetadataPath(feedId: string): string {
    return path.join(this.feedsDir, feedId, 'metadata.json');
  }

  /**
   * Ensure service is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export const feedService = new FeedService();
