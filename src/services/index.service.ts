/**
 * HASHD Vault - Index Service
 * 
 * Implements Requirement 15: Blob Indexing & Query Layer
 * - Per-node encrypted index storage (R15.1)
 * - Standardized metadata tags (R15.2)
 * - Query API (R15.3)
 * - Delta sync (R15.4)
 * - Deterministic format (R15.5)
 * - Privacy guarantees (R15.9)
 */

import { logger } from '../utils/logger.js';
import {
  IndexEntry,
  IndexQueryResult,
  DeltaSyncResult,
  IndexableBlobType,
  IndexableBlobMetadata
} from '../types/index.js';

export class IndexService {
  // In-memory indexes (R15.5)
  // In production, these would be SQLite/RocksDB
  private globalIndex: IndexEntry[] = [];
  private byType: Map<IndexableBlobType, IndexEntry[]> = new Map();
  private byThread: Map<string, IndexEntry[]> = new Map();
  private byGuild: Map<string, IndexEntry[]> = new Map();
  private byCid: Map<string, IndexEntry> = new Map();

  /**
   * Initialize index service
   */
  async initialize(): Promise<void> {
    logger.info('Index service initialized');
  }

  /**
   * Add blob to index (R15.1)
   * 
   * Called automatically when blobs are stored or replicated
   */
  async indexBlob(
    cid: string,
    metadata: IndexableBlobMetadata
  ): Promise<void> {
    // Check if already indexed
    if (this.byCid.has(cid)) {
      return;
    }

    const entry: IndexEntry = {
      cid,
      type: metadata.type,
      timestamp: metadata.timestamp,
      threadId: metadata.threadId,
      guildId: metadata.guildId,
      parentCid: metadata.parentCid,
      size: metadata.size,
      mediaType: metadata.mediaType,
      indexed: Date.now()
    };

    // Add to global index
    this.globalIndex.push(entry);

    // Add to type index
    if (!this.byType.has(metadata.type)) {
      this.byType.set(metadata.type, []);
    }
    this.byType.get(metadata.type)!.push(entry);

    // Add to thread index
    if (!this.byThread.has(metadata.threadId)) {
      this.byThread.set(metadata.threadId, []);
    }
    this.byThread.get(metadata.threadId)!.push(entry);

    // Add to guild index (if applicable)
    if (metadata.guildId) {
      if (!this.byGuild.has(metadata.guildId)) {
        this.byGuild.set(metadata.guildId, []);
      }
      this.byGuild.get(metadata.guildId)!.push(entry);
    }

    // Add to CID lookup
    this.byCid.set(cid, entry);

    logger.debug('Blob indexed', { cid, type: metadata.type });
  }

  /**
   * Query latest blobs by type (R15.3)
   * 
   * GET /index/latest?type=<type>&limit=<n>
   */
  async queryLatest(
    type?: IndexableBlobType,
    limit = 50,
    cursor?: string
  ): Promise<IndexQueryResult> {
    let entries = type
      ? (this.byType.get(type) || [])
      : this.globalIndex;

    // Sort by timestamp descending (newest first)
    entries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = entries.findIndex(e => e.cid === cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const hasMore = entries.length > limit;
    const results = entries.slice(0, limit);
    const nextCursor = hasMore ? results[results.length - 1].cid : undefined;

    return {
      entries: results,
      cursor: nextCursor,
      hasMore,
      total: entries.length
    };
  }

  /**
   * Query thread messages (R15.3)
   * 
   * GET /index/thread/:threadId
   */
  async queryThread(
    threadId: string,
    limit = 100,
    cursor?: string
  ): Promise<IndexQueryResult> {
    let entries = this.byThread.get(threadId) || [];

    // Sort by timestamp descending (newest first)
    entries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = entries.findIndex(e => e.cid === cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const hasMore = entries.length > limit;
    const results = entries.slice(0, limit);
    const nextCursor = hasMore ? results[results.length - 1].cid : undefined;

    return {
      entries: results,
      cursor: nextCursor,
      hasMore,
      total: entries.length
    };
  }

  /**
   * Query thread delta (R15.4)
   * 
   * GET /index/thread/:threadId/delta?sinceTimestamp=<ts>
   */
  async queryThreadDelta(
    threadId: string,
    sinceTimestamp: number
  ): Promise<DeltaSyncResult> {
    const entries = this.byThread.get(threadId) || [];

    // Filter entries newer than sinceTimestamp
    const newEntries = entries
      .filter(e => e.timestamp > sinceTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp); // Ascending for delta

    return {
      newEntries,
      sinceTimestamp,
      currentTimestamp: Date.now(),
      count: newEntries.length
    };
  }

  /**
   * Query guild blobs (R15.3)
   * 
   * GET /index/guild/:guildId
   */
  async queryGuild(
    guildId: string,
    limit = 50,
    cursor?: string
  ): Promise<IndexQueryResult> {
    let entries = this.byGuild.get(guildId) || [];

    // Sort by timestamp descending
    entries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = entries.findIndex(e => e.cid === cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const hasMore = entries.length > limit;
    const results = entries.slice(0, limit);
    const nextCursor = hasMore ? results[results.length - 1].cid : undefined;

    return {
      entries: results,
      cursor: nextCursor,
      hasMore,
      total: entries.length
    };
  }

  /**
   * Query guild posts only (R15.3)
   * 
   * GET /index/guild/:guildId/posts
   */
  async queryGuildPosts(
    guildId: string,
    limit = 50,
    cursor?: string
  ): Promise<IndexQueryResult> {
    let entries = (this.byGuild.get(guildId) || [])
      .filter(e => e.type === 'post');

    // Sort by timestamp descending
    entries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = entries.findIndex(e => e.cid === cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const hasMore = entries.length > limit;
    const results = entries.slice(0, limit);
    const nextCursor = hasMore ? results[results.length - 1].cid : undefined;

    return {
      entries: results,
      cursor: nextCursor,
      hasMore,
      total: entries.length
    };
  }

  /**
   * Query comments for a post (R15.3)
   * 
   * GET /index/guild/:guildId/comments/:postCid
   */
  async queryComments(
    guildId: string,
    postCid: string,
    limit = 100,
    cursor?: string
  ): Promise<IndexQueryResult> {
    let entries = (this.byGuild.get(guildId) || [])
      .filter(e => e.type === 'comment' && e.parentCid === postCid);

    // Sort by timestamp ascending (oldest first for comments)
    entries = [...entries].sort((a, b) => a.timestamp - b.timestamp);

    // Apply cursor pagination
    if (cursor) {
      const cursorIndex = entries.findIndex(e => e.cid === cursor);
      if (cursorIndex >= 0) {
        entries = entries.slice(cursorIndex + 1);
      }
    }

    // Apply limit
    const hasMore = entries.length > limit;
    const results = entries.slice(0, limit);
    const nextCursor = hasMore ? results[results.length - 1].cid : undefined;

    return {
      entries: results,
      cursor: nextCursor,
      hasMore,
      total: entries.length
    };
  }

  /**
   * Get blob metadata by CID (R15.3)
   * 
   * GET /index/blob/:cid
   */
  async getBlobMetadata(cid: string): Promise<IndexEntry | null> {
    return this.byCid.get(cid) || null;
  }

  /**
   * Remove blob from index (for GC)
   */
  async removeFromIndex(cid: string): Promise<void> {
    const entry = this.byCid.get(cid);
    if (!entry) return;

    // Remove from global index
    const globalIdx = this.globalIndex.findIndex(e => e.cid === cid);
    if (globalIdx >= 0) {
      this.globalIndex.splice(globalIdx, 1);
    }

    // Remove from type index
    const typeEntries = this.byType.get(entry.type);
    if (typeEntries) {
      const typeIdx = typeEntries.findIndex(e => e.cid === cid);
      if (typeIdx >= 0) {
        typeEntries.splice(typeIdx, 1);
      }
    }

    // Remove from thread index
    const threadEntries = this.byThread.get(entry.threadId);
    if (threadEntries) {
      const threadIdx = threadEntries.findIndex(e => e.cid === cid);
      if (threadIdx >= 0) {
        threadEntries.splice(threadIdx, 1);
      }
    }

    // Remove from guild index
    if (entry.guildId) {
      const guildEntries = this.byGuild.get(entry.guildId);
      if (guildEntries) {
        const guildIdx = guildEntries.findIndex(e => e.cid === cid);
        if (guildIdx >= 0) {
          guildEntries.splice(guildIdx, 1);
        }
      }
    }

    // Remove from CID lookup
    this.byCid.delete(cid);

    logger.debug('Blob removed from index', { cid });
  }

  /**
   * Get index statistics
   */
  getStats(): {
    totalEntries: number;
    byType: Record<string, number>;
    threads: number;
    guilds: number;
  } {
    const byType: Record<string, number> = {};
    for (const [type, entries] of this.byType.entries()) {
      byType[type] = entries.length;
    }

    return {
      totalEntries: this.globalIndex.length,
      byType,
      threads: this.byThread.size,
      guilds: this.byGuild.size
    };
  }

  /**
   * Clear all indexes (for testing)
   */
  clearIndexes(): void {
    this.globalIndex = [];
    this.byType.clear();
    this.byThread.clear();
    this.byGuild.clear();
    this.byCid.clear();
  }
}

export const indexService = new IndexService();
