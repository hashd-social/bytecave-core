/**
 * HASHD Vault - Configuration Management
 */

import dotenv from 'dotenv';
import { Config, ContentType, ContentFilterConfig } from '../types/index.js';

dotenv.config();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for ${key}: ${value}`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

function getEnvArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
}

/**
 * Load guild filter configuration from config/guilds.json
 */
function loadGuildConfig(): { allowedGuilds: 'all' | string[]; blockedGuilds: string[] } {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../../config/guilds.json');
    const data = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(data);
    
    // Validate and normalize allowedGuilds
    let allowedGuilds: 'all' | string[];
    if (config.allowedGuilds === 'all' || !config.allowedGuilds) {
      allowedGuilds = 'all';
    } else if (Array.isArray(config.allowedGuilds)) {
      allowedGuilds = config.allowedGuilds.map((g: any) => String(g));
      if (allowedGuilds.length === 0) {
        allowedGuilds = 'all';
      }
    } else {
      allowedGuilds = 'all';
    }
    
    // Validate and normalize blockedGuilds
    const blockedGuilds = Array.isArray(config.blockedGuilds) 
      ? config.blockedGuilds.map((g: any) => String(g))
      : [];
    
    return { allowedGuilds, blockedGuilds };
  } catch (error) {
    console.warn('⚠️ Could not load config/guilds.json, using defaults (all guilds allowed)');
    return { allowedGuilds: 'all', blockedGuilds: [] };
  }
}

/**
 * Parse content filter configuration
 * 
 * CONTENT_TYPES (env): Comma-separated list of content types to accept
 *   - 'all' = accept everything (default)
 *   - 'messages,posts,media,listings' = accept specific types
 * 
 * Guild filtering is loaded from config/guilds.json:
 *   - allowedGuilds: 'all' or array of guild IDs
 *   - blockedGuilds: array of guild IDs to block (takes precedence)
 */
function parseContentFilter(): ContentFilterConfig {
  const typesEnv = process.env.CONTENT_TYPES?.toLowerCase().trim();
  
  // Parse content types from env
  let types: 'all' | ContentType[];
  if (!typesEnv || typesEnv === 'all') {
    types = 'all';
  } else {
    const validTypes: ContentType[] = ['messages', 'posts', 'media', 'listings'];
    const parsed = typesEnv.split(',').map(t => t.trim()) as ContentType[];
    types = parsed.filter(t => validTypes.includes(t));
    if (types.length === 0) {
      console.warn('⚠️ No valid CONTENT_TYPES specified, defaulting to "all"');
      types = 'all';
    }
  }
  
  // Load guild config from JSON file
  const { allowedGuilds, blockedGuilds } = loadGuildConfig();
  
  return { types, allowedGuilds, blockedGuilds };
}

export const config: Config = {
  // Node identification
  nodeEnv: process.env.NODE_ENV || 'development',
  nodeId: process.env.NODE_ID || 'vault-node-1',
  port: parseInt(process.env.PORT || '3004'),
  nodeUrl: process.env.NODE_URL || 'http://localhost:3004',

  // Sharding configuration (Requirement 7)
  shardCount: parseInt(process.env.SHARD_COUNT || '1024'),
  // Default: responsible for all shards (single-node mode) - use range format
  nodeShards: process.env.NODE_SHARDS 
    ? JSON.parse(process.env.NODE_SHARDS)
    : [{ start: 0, end: 1023 }],

  // Content type filtering
  contentFilter: parseContentFilter(),

  // Garbage collection configuration (Requirement 8)
  gcEnabled: getEnvBoolean('GC_ENABLED', true),
  gcRetentionMode: (process.env.GC_RETENTION_MODE || 'hybrid') as 'size' | 'time' | 'hybrid',
  gcMaxStorageMB: getEnvNumber('GC_MAX_STORAGE_MB', 5000),
  gcMaxBlobAgeDays: getEnvNumber('GC_MAX_BLOB_AGE_DAYS', 30),
  gcMinFreeDiskMB: getEnvNumber('GC_MIN_FREE_DISK_MB', 1000),
  gcReservedForPinnedMB: getEnvNumber('GC_RESERVED_FOR_PINNED_MB', 1000),
  gcIntervalMinutes: getEnvNumber('GC_INTERVAL_MINUTES', 10),
  // SECURITY: Default to true to prevent data loss from tampered replication state
  gcVerifyReplicas: getEnvBoolean('GC_VERIFY_REPLICAS', true),
  gcVerifyProofs: getEnvBoolean('GC_VERIFY_PROOFS', false),

  dataDir: getEnv('DATA_DIR', './data'),
  maxBlobSizeMB: getEnvNumber('MAX_BLOB_SIZE_MB', 10),
  maxStorageGB: getEnvNumber('MAX_STORAGE_GB', 100),
  replicationEnabled: getEnvBoolean('REPLICATION_ENABLED', true),
  replicationTimeoutMs: getEnvNumber('REPLICATION_TIMEOUT_MS', 5000),
  replicationFactor: getEnvNumber('REPLICATION_FACTOR', 3),
  enableBlockedContent: getEnvBoolean('ENABLE_BLOCKED_CONTENT', true),
  cacheSizeMB: getEnvNumber('CACHE_SIZE_MB', 50),
  compressionEnabled: getEnvBoolean('COMPRESSION_ENABLED', false),
  metricsEnabled: getEnvBoolean('METRICS_ENABLED', true),
  logLevel: getEnv('LOG_LEVEL', 'info'),
  corsOrigin: getEnvArray('CORS_ORIGIN', ['http://localhost:3000'])
};

export function validateConfig(): void {
  if (config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }

  if (config.maxBlobSizeMB < 1) {
    throw new Error('MAX_BLOB_SIZE_MB must be at least 1');
  }

  if (config.maxStorageGB < 1) {
    throw new Error('MAX_STORAGE_GB must be at least 1');
  }

  if (config.replicationFactor < 1) {
    throw new Error('REPLICATION_FACTOR must be at least 1');
  }

  if (config.replicationTimeoutMs < 100) {
    throw new Error('REPLICATION_TIMEOUT_MS must be at least 100');
  }

  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(config.logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}`);
  }

  // CRITICAL SECURITY CHECK: Prevent dev node from accessing production data
  validateDataDirectorySafety();
}

/**
 * Validate data directory safety to prevent dev nodes from accessing production data
 * 
 * SECURITY: Prevents scenarios like:
 * - Dev node (NODE_ENV=development) pointing to production DATA_DIR
 * - Accidental force purge of production data
 * - Cross-environment data corruption
 */
function validateDataDirectorySafety(): void {
  const dataDir = config.dataDir;
  const nodeEnv = config.nodeEnv;

  // Check for production data directory markers
  const productionMarkers = [
    '/production/',
    '/prod/',
    'production-data',
    'prod-data',
    '/var/vault/production',
    '/opt/vault/production'
  ];

  const isDevelopment = nodeEnv === 'development' || nodeEnv === 'test';
  const hasProductionMarker = productionMarkers.some(marker => 
    dataDir.toLowerCase().includes(marker.toLowerCase())
  );

  // CRITICAL: Dev/test nodes cannot use production data directories
  if (isDevelopment && hasProductionMarker) {
    throw new Error(
      `⛔ SECURITY VIOLATION: Development/test node cannot access production data directory!\n` +
      `NODE_ENV: ${nodeEnv}\n` +
      `DATA_DIR: ${dataDir}\n` +
      `This prevents accidental force purge of production data.\n` +
      `Use a separate data directory for development.`
    );
  }

  // Warn if production node uses dev-like data directory
  if (nodeEnv === 'production') {
    const devMarkers = ['./data', '/tmp/', 'test-data', 'dev-data'];
    const hasDevMarker = devMarkers.some(marker => 
      dataDir.toLowerCase().includes(marker.toLowerCase())
    );

    if (hasDevMarker) {
      console.warn(
        `⚠️ WARNING: Production node using development-like data directory!\n` +
        `DATA_DIR: ${dataDir}\n` +
        `Consider using a production path like /var/vault/data or /opt/vault/data`
      );
    }
  }
}
