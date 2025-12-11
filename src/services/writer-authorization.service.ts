/**
 * HASHD Vault - Writer Authorization Service
 * 
 * Implements Requirement 12: Unified Writer Authorization
 * - Deterministic key verification (R12.1)
 * - Message chain validation (R12.2)
 * - Allow/block list enforcement (R12.3)
 * - Guild posting authorization (R12.4)
 * - Feed assembly with validation (R12.6)
 * - Rejection rules (R12.7)
 */

import { logger } from '../utils/logger.js';
import { verifySignature } from '../utils/crypto.js';
import {
  FeedEvent,
  ValidatedFeedEvent,
  AuthorizationResult,
  WriterContext,
  GuildPostingRules,
  MessageState
} from '../types/index.js';

export class WriterAuthorizationService {
  // Cache for allowlists and blocklists
  private allowlists: Map<string, Set<string>> = new Map();
  private blocklists: Map<string, Set<string>> = new Map();
  private readonly TIMESTAMP_SKEW_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Verify writer signature (R12.1)
   * 
   * All writes must be signed with deterministic mailbox keys
   */
  verifyWriterSignature(event: FeedEvent): boolean {
    try {
      // Construct message that was signed
      const message = JSON.stringify({
        feedId: event.feedId,
        cid: event.cid,
        parentCid: event.parentCid,
        timestamp: event.timestamp,
        authorKey: event.authorKey
      });

      // Verify signature with writer's public key
      return verifySignature(message, event.signature, event.authorKey);
    } catch (error) {
      logger.error('Signature verification failed', error);
      return false;
    }
  }

  /**
   * Validate message chain continuity (R12.2)
   * 
   * Ensures cryptographic continuity in message threads
   */
  validateMessageChain(
    event: FeedEvent,
    existingEvents: FeedEvent[]
  ): AuthorizationResult {
    // Root messages don't need parent validation
    if (event.parentCid === null) {
      return { authorized: true };
    }

    // Find parent message
    const parent = existingEvents.find(e => e.cid === event.parentCid);

    if (!parent) {
      return {
        authorized: false,
        reason: `Parent message ${event.parentCid} not found`,
        rejectionType: 'chain'
      };
    }

    // Verify parent signature is valid
    if (!this.verifyWriterSignature(parent)) {
      return {
        authorized: false,
        reason: 'Parent message has invalid signature',
        rejectionType: 'chain'
      };
    }

    // Chain is valid
    return { authorized: true };
  }

  /**
   * Check DM allowlist enforcement (R12.3)
   * 
   * Uses existing contract-layer allow/block lists
   */
  checkDMAuthorization(
    writerMailbox: string,
    _dmChannelId: string,
    allowlist: string[],
    blocklist: string[]
  ): AuthorizationResult {
    // Check blocklist first
    if (blocklist.includes(writerMailbox)) {
      return {
        authorized: false,
        reason: 'Writer is blocked in this DM channel',
        rejectionType: 'blocklist'
      };
    }

    // Check allowlist
    if (!allowlist.includes(writerMailbox)) {
      return {
        authorized: false,
        reason: 'Writer is not in DM channel allowlist',
        rejectionType: 'blocklist'
      };
    }

    return { authorized: true };
  }

  /**
   * Check guild posting authorization (R12.4)
   * 
   * Client-side enforcement of tier-based posting rules
   */
  checkGuildPostingAuthorization(
    walletAddress: string,
    _writerPubKey: string,
    rules: GuildPostingRules,
    guildBanlist: string[]
  ): AuthorizationResult {
    // Check guild banlist
    if (guildBanlist.includes(walletAddress)) {
      return {
        authorized: false,
        reason: 'Wallet is banned from this guild',
        rejectionType: 'blocklist'
      };
    }

    // Check tier-specific rules
    switch (rules.tier) {
      case 'public':
        // Everyone can post (unless banned)
        return { authorized: true };

      case 'members':
        if (!rules.memberList) {
          return {
            authorized: false,
            reason: 'Member list not provided',
            rejectionType: 'tier'
          };
        }
        if (!rules.memberList.includes(walletAddress)) {
          return {
            authorized: false,
            reason: 'Wallet is not a guild member',
            rejectionType: 'tier'
          };
        }
        return { authorized: true };

      case 'token_gated':
        // In real implementation, would check token balance on-chain
        // For now, assume client has already verified
        return { authorized: true };

      case 'prime_key':
        if (!rules.primeKeyHolders) {
          return {
            authorized: false,
            reason: 'Prime key holders list not provided',
            rejectionType: 'tier'
          };
        }
        if (!rules.primeKeyHolders.includes(walletAddress)) {
          return {
            authorized: false,
            reason: 'Wallet is not a prime key holder',
            rejectionType: 'tier'
          };
        }
        return { authorized: true };

      default:
        return {
          authorized: false,
          reason: 'Unknown tier type',
          rejectionType: 'tier'
        };
    }
  }

  /**
   * Validate timestamp (R12.7)
   * 
   * Reject events with timestamps outside acceptable skew
   */
  validateTimestamp(timestamp: number): AuthorizationResult {
    const now = Date.now();
    const diff = Math.abs(now - timestamp);

    if (diff > this.TIMESTAMP_SKEW_MS) {
      return {
        authorized: false,
        reason: `Timestamp skew too large: ${diff}ms`,
        rejectionType: 'timestamp'
      };
    }

    return { authorized: true };
  }

  /**
   * Comprehensive event validation (R12.7)
   * 
   * Applies all rejection rules
   */
  validateEvent(
    event: FeedEvent,
    context: {
      existingEvents?: FeedEvent[];
      dmAllowlist?: string[];
      dmBlocklist?: string[];
      guildRules?: GuildPostingRules;
      guildBanlist?: string[];
      writerContext?: WriterContext;
    }
  ): ValidatedFeedEvent {
    const validationErrors: string[] = [];
    let state: MessageState = 'valid';

    // 1. Verify signature (R12.1)
    if (!this.verifyWriterSignature(event)) {
      validationErrors.push('Invalid signature');
      state = 'invalid';
    }

    // 2. Validate timestamp (R12.7)
    const timestampResult = this.validateTimestamp(event.timestamp);
    if (!timestampResult.authorized) {
      validationErrors.push(timestampResult.reason || 'Invalid timestamp');
      state = 'invalid';
    }

    // 3. Validate message chain (R12.2)
    if (context.existingEvents) {
      const chainResult = this.validateMessageChain(event, context.existingEvents);
      if (!chainResult.authorized) {
        validationErrors.push(chainResult.reason || 'Invalid chain');
        state = 'invalid';
      }
    }

    // 4. Check DM authorization (R12.3)
    if (context.dmAllowlist && context.dmBlocklist && context.writerContext) {
      const dmResult = this.checkDMAuthorization(
        context.writerContext.mailboxId,
        event.feedId,
        context.dmAllowlist,
        context.dmBlocklist
      );
      if (!dmResult.authorized) {
        validationErrors.push(dmResult.reason || 'DM authorization failed');
        state = 'censored';
      }
    }

    // 5. Check guild authorization (R12.4)
    if (context.guildRules && context.guildBanlist && context.writerContext) {
      const guildResult = this.checkGuildPostingAuthorization(
        context.writerContext.walletAddress,
        context.writerContext.writerPubKey,
        context.guildRules,
        context.guildBanlist
      );
      if (!guildResult.authorized) {
        validationErrors.push(guildResult.reason || 'Guild authorization failed');
        state = 'censored';
      }
    }

    return {
      ...event,
      state,
      validationErrors,
      writerContext: context.writerContext
    };
  }

  /**
   * Assemble and validate feed (R12.6)
   * 
   * Reconstructs DMs and Guild threads with full validation
   */
  assembleFeed(
    events: FeedEvent[],
    context: {
      dmAllowlist?: string[];
      dmBlocklist?: string[];
      guildRules?: GuildPostingRules;
      guildBanlist?: string[];
      writerContexts?: Map<string, WriterContext>;
    }
  ): ValidatedFeedEvent[] {
    const validatedEvents: ValidatedFeedEvent[] = [];

    // Sort by timestamp
    const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);

    // Validate each event
    for (const event of sortedEvents) {
      const writerContext = context.writerContexts?.get(event.authorKey);

      const validated = this.validateEvent(event, {
        existingEvents: validatedEvents,
        dmAllowlist: context.dmAllowlist,
        dmBlocklist: context.dmBlocklist,
        guildRules: context.guildRules,
        guildBanlist: context.guildBanlist,
        writerContext
      });

      validatedEvents.push(validated);
    }

    // Filter out censored events
    return validatedEvents.filter(e => e.state !== 'censored');
  }

  /**
   * Check if event should be rejected (R12.7)
   * 
   * Returns true if event fails any validation rule
   */
  shouldRejectEvent(validated: ValidatedFeedEvent): boolean {
    return validated.state === 'invalid' || validated.state === 'censored';
  }

  /**
   * Set allowlist for a channel
   */
  setAllowlist(channelId: string, allowlist: string[]): void {
    this.allowlists.set(channelId, new Set(allowlist));
  }

  /**
   * Set blocklist for a channel
   */
  setBlocklist(channelId: string, blocklist: string[]): void {
    this.blocklists.set(channelId, new Set(blocklist));
  }

  /**
   * Get allowlist for a channel
   */
  getAllowlist(channelId: string): string[] {
    return Array.from(this.allowlists.get(channelId) || []);
  }

  /**
   * Get blocklist for a channel
   */
  getBlocklist(channelId: string): string[] {
    return Array.from(this.blocklists.get(channelId) || []);
  }

  /**
   * Clear all cached lists
   */
  clearCache(): void {
    this.allowlists.clear();
    this.blocklists.clear();
  }
}

export const writerAuthorizationService = new WriterAuthorizationService();
