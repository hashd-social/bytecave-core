/**
 * HASHD Vault - Content Type Filter Middleware
 * 
 * Allows node operators to choose what content types to store:
 * - messages: Direct messages between users
 * - posts: Guild posts and comments
 * - media: Images, profile pictures, group images
 * - listings: Marketplace listings (future)
 * 
 * Also supports guild-specific filtering via ALLOWED_GUILDS
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ContentType } from '../types/index.js';

/**
 * Map authorization types from frontend to our content types
 * Frontend sends: 'message', 'group_post', 'comment', etc.
 * We normalize to: 'messages', 'posts', 'media', 'listings'
 */
export function normalizeContentType(authType: string | undefined): ContentType | null {
  if (!authType) return null;
  
  const typeMap: Record<string, ContentType> = {
    // Messages
    'message': 'messages',
    'direct_message': 'messages',
    
    // Posts (guild content)
    'group_post': 'posts',
    'post': 'posts',
    'comment': 'posts',
    'reply': 'posts',
    
    // Media
    'media': 'media',
    'image': 'media',
    'profile_image': 'media',
    'group_image': 'media',
    'attachment': 'media',
    
    // Listings (marketplace)
    'listing': 'listings',
    'marketplace': 'listings',
  };
  
  return typeMap[authType.toLowerCase()] || null;
}

/**
 * Extract guild ID from authorization object
 * Guild ID is typically the tokenId of the group
 */
export function extractGuildId(authorization: any): string | null {
  if (!authorization) return null;
  
  // Try common field names for guild/group ID
  return authorization.guildId 
    || authorization.groupId 
    || authorization.tokenId
    || authorization.guild_id
    || authorization.group_id
    || null;
}

/**
 * Validate that content matches this node's filter configuration
 * 
 * Checks:
 * 1. Content type is in allowed types (or 'all')
 * 2. Guild ID is in allowed guilds (if configured)
 */
export function validateContentFilter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const { contentFilter } = config;
    const authorization = req.body?.authorization;
    
    // If accepting all types and no guild filter, pass through
    if (contentFilter.types === 'all' && !contentFilter.allowedGuilds?.length) {
      next();
      return;
    }
    
    // Get content type from authorization
    const rawType = authorization?.type;
    const contentType = normalizeContentType(rawType);
    
    // Check content type filter
    if (contentFilter.types !== 'all') {
      if (!contentType) {
        logger.warn('Content rejected: unknown type', { rawType });
        res.status(403).json({
          error: 'CONTENT_TYPE_REJECTED',
          message: `Unknown content type: ${rawType}`,
          acceptedTypes: contentFilter.types,
          timestamp: Date.now()
        });
        return;
      }
      
      if (!contentFilter.types.includes(contentType)) {
        logger.info('Content rejected: type not accepted', { 
          contentType, 
          rawType,
          acceptedTypes: contentFilter.types 
        });
        res.status(403).json({
          error: 'CONTENT_TYPE_REJECTED',
          message: `This node does not accept "${contentType}" content`,
          acceptedTypes: contentFilter.types,
          timestamp: Date.now()
        });
        return;
      }
    }
    
    // Get guild ID for guild-based filtering
    const guildId = extractGuildId(authorization);
    
    // Check blocked guilds first (takes precedence)
    if (guildId && contentFilter.blockedGuilds.length > 0) {
      if (contentFilter.blockedGuilds.includes(guildId)) {
        logger.info('Content rejected: guild is blocked', { 
          guildId, 
          blockedGuilds: contentFilter.blockedGuilds 
        });
        res.status(403).json({
          error: 'GUILD_BLOCKED',
          message: `This node does not accept content for guild ${guildId}`,
          timestamp: Date.now()
        });
        return;
      }
    }
    
    // Check allowed guilds (if not 'all')
    if (contentFilter.allowedGuilds !== 'all') {
      // Messages don't have guild IDs - allow them if 'messages' is in types
      if (!guildId && contentType === 'messages') {
        next();
        return;
      }
      
      if (!guildId) {
        logger.warn('Content rejected: no guild ID and guild filter active', { rawType });
        res.status(403).json({
          error: 'GUILD_REQUIRED',
          message: 'This node requires guild-specific content',
          allowedGuilds: contentFilter.allowedGuilds,
          timestamp: Date.now()
        });
        return;
      }
      
      if (!contentFilter.allowedGuilds.includes(guildId)) {
        logger.info('Content rejected: guild not in allowlist', { 
          guildId, 
          allowedGuilds: contentFilter.allowedGuilds 
        });
        res.status(403).json({
          error: 'GUILD_NOT_ALLOWED',
          message: `This node does not store content for guild ${guildId}`,
          allowedGuilds: contentFilter.allowedGuilds,
          timestamp: Date.now()
        });
        return;
      }
    }
    
    // All checks passed
    next();
  } catch (error: any) {
    logger.error('Content filter error', error);
    res.status(500).json({
      error: 'CONTENT_FILTER_FAILED',
      message: error.message,
      timestamp: Date.now()
    });
  }
}
