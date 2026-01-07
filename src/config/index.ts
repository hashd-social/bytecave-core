/**
 * HASHD Vault - Configuration Management
 */

import dotenv from 'dotenv';
import { Config } from '../types/index.js';
import { getConfigManager } from './config-manager.js';

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

// Content filtering removed - nodes now accept all content in their shard range
// Content type is stored as metadata for application-level filtering

// Initialize ConfigManager and load persisted config
// First get the base data directory and nodeId
const baseDataDir = process.env.DATA_DIR || './data';
const nodeId = process.env.NODE_ID || 'vault-node-1';

// Create data directory path with nodeId subfolder: e.g., ./data/vault-node-1
// Check if baseDataDir already ends with nodeId to avoid double-nesting
const dataDir = baseDataDir.endsWith(nodeId) 
  ? baseDataDir 
  : `${baseDataDir}/${nodeId}`;

const configManager = getConfigManager(dataDir);
const persistedConfig = configManager.getConfig();

// Helper function: config.json takes precedence over env vars
// If a value exists in config.json, use it. Otherwise, use env var or default.
function getConfigValue<T>(persistedValue: T | undefined, envValue: T): T {
  return persistedValue !== undefined ? persistedValue : envValue;
}

export const config: Config = {
  // Node identification
  nodeEnv: process.env.NODE_ENV || 'development',
  nodeId: getConfigValue(persistedConfig.nodeId, nodeId),
  port: getConfigValue(persistedConfig.port, getEnvNumber('PORT', 3004)),
  nodeUrl: getConfigValue(persistedConfig.nodeUrl, getEnv('NODE_URL', 'http://localhost:3004')),
  
  // Node identity for P2P and registration
  publicKey: getConfigValue(persistedConfig.publicKey, process.env.PUBLIC_KEY || ''),
  ownerAddress: getConfigValue(persistedConfig.ownerAddress, process.env.OWNER_ADDRESS || ''),

  // P2P Configuration - config.json takes precedence
  p2pEnabled: getEnvBoolean('P2P_ENABLED', true),
  p2pListenAddresses: getEnvArray('P2P_LISTEN_ADDRESSES', ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws']),
  p2pBootstrapPeers: persistedConfig.p2pBootstrapPeers.length > 0 
    ? persistedConfig.p2pBootstrapPeers 
    : getEnvArray('P2P_BOOTSTRAP_PEERS', []),
  p2pRelayPeers: persistedConfig.p2pRelayPeers.length > 0
    ? persistedConfig.p2pRelayPeers
    : getEnvArray('P2P_RELAY_PEERS', []),
  p2pEnableDHT: getEnvBoolean('P2P_ENABLE_DHT', true),
  p2pEnableMDNS: getEnvBoolean('P2P_ENABLE_MDNS', true),
  p2pEnableRelay: getEnvBoolean('P2P_ENABLE_RELAY', true),

  // Sharding configuration - config.json takes precedence
  shardCount: getConfigValue(persistedConfig.shardCount, getEnvNumber('SHARD_COUNT', 1024)),
  nodeShards: getConfigValue(
    persistedConfig.nodeShards,
    process.env.NODE_SHARDS ? JSON.parse(process.env.NODE_SHARDS) : [{ start: 0, end: 1023 }]
  ),

  // Garbage collection - config.json takes precedence
  gcEnabled: getConfigValue(persistedConfig.gcEnabled, getEnvBoolean('GC_ENABLED', true)),
  gcRetentionMode: getConfigValue(persistedConfig.gcRetentionMode, (process.env.GC_RETENTION_MODE || 'hybrid') as 'size' | 'time' | 'hybrid'),
  gcMaxStorageMB: getConfigValue(persistedConfig.gcMaxStorageMB, getEnvNumber('GC_MAX_STORAGE_MB', 5000)),
  gcMaxBlobAgeDays: getConfigValue(persistedConfig.gcMaxBlobAgeDays, getEnvNumber('GC_MAX_BLOB_AGE_DAYS', 30)),
  gcMinFreeDiskMB: getConfigValue(persistedConfig.gcMinFreeDiskMB, getEnvNumber('GC_MIN_FREE_DISK_MB', 1000)),
  gcReservedForPinnedMB: getConfigValue(persistedConfig.gcReservedForPinnedMB, getEnvNumber('GC_RESERVED_FOR_PINNED_MB', 1000)),
  gcIntervalMinutes: getConfigValue(persistedConfig.gcIntervalMinutes, getEnvNumber('GC_INTERVAL_MINUTES', 10)),
  gcVerifyReplicas: true, // Always verify replicas before deletion (security requirement)
  gcVerifyProofs: true, // Always verify storage proofs (security requirement)

  // Storage configuration - config.json takes precedence
  dataDir: dataDir,
  maxBlobSizeMB: getConfigValue(persistedConfig.maxBlobSizeMB, getEnvNumber('MAX_BLOB_SIZE_MB', 10)),
  maxStorageGB: getConfigValue(persistedConfig.maxStorageGB, getEnvNumber('MAX_STORAGE_GB', 100)),
  
  // Replication - config.json takes precedence
  replicationEnabled: getConfigValue(persistedConfig.replicationEnabled, getEnvBoolean('REPLICATION_ENABLED', true)),
  replicationTimeoutMs: getConfigValue(persistedConfig.replicationTimeoutMs, getEnvNumber('REPLICATION_TIMEOUT_MS', 5000)),
  replicationFactor: getConfigValue(persistedConfig.replicationFactor, getEnvNumber('REPLICATION_FACTOR', 3)),
  
  // Security - config.json takes precedence
  enableBlockedContent: getConfigValue(persistedConfig.enableBlockedContent, getEnvBoolean('ENABLE_BLOCKED_CONTENT', true)),
  allowedApps: getConfigValue(persistedConfig.allowedApps, getEnvArray('ALLOWED_APPS', ['hashd'])),
  requireAppRegistry: getConfigValue(persistedConfig.requireAppRegistry, getEnvBoolean('REQUIRE_APP_REGISTRY', true)),
  
  // Performance - config.json takes precedence
  cacheSizeMB: getConfigValue(persistedConfig.cacheSizeMB, getEnvNumber('CACHE_SIZE_MB', 50)),
  compressionEnabled: getConfigValue(persistedConfig.compressionEnabled, getEnvBoolean('COMPRESSION_ENABLED', false)),
  
  // Monitoring - config.json takes precedence
  metricsEnabled: getConfigValue(persistedConfig.metricsEnabled, getEnvBoolean('METRICS_ENABLED', true)),
  logLevel: getConfigValue(persistedConfig.logLevel, getEnv('LOG_LEVEL', 'info')),
  
  corsOrigin: getEnvArray('CORS_ORIGIN', ['http://localhost:3000'])
};

// Write complete config to config.json on startup
// This ensures config.json is always a complete mirror of the running config
// On first startup, this copies all env defaults to config.json
// On subsequent startups, config.json values take precedence
configManager.updateNodeConfig({
  // Node Configuration
  nodeId: config.nodeId,
  port: config.port,
  nodeUrl: config.nodeUrl,
  
  // Identity
  publicKey: config.publicKey,
  ownerAddress: config.ownerAddress,
  
  // P2P Configuration
  p2pBootstrapPeers: config.p2pBootstrapPeers,
  p2pRelayPeers: config.p2pRelayPeers,
  
  // Sharding
  shardCount: config.shardCount,
  nodeShards: config.nodeShards as Array<{ start: number; end: number }>,
  
  // Garbage Collection
  gcEnabled: config.gcEnabled,
  gcRetentionMode: config.gcRetentionMode,
  gcMaxStorageMB: config.gcMaxStorageMB,
  gcMaxBlobAgeDays: config.gcMaxBlobAgeDays,
  gcMinFreeDiskMB: config.gcMinFreeDiskMB,
  gcReservedForPinnedMB: config.gcReservedForPinnedMB,
  gcIntervalMinutes: config.gcIntervalMinutes,
  // Verification is always enabled for security - not saved to config
  // gcVerifyReplicas and gcVerifyProofs are hardcoded to true
  
  // Storage Configuration
  maxStorageMB: config.gcMaxStorageMB,
  dataDir: config.dataDir,
  maxBlobSizeMB: config.maxBlobSizeMB,
  maxStorageGB: config.maxStorageGB,
  
  // Replication Configuration
  replicationEnabled: config.replicationEnabled,
  replicationTimeoutMs: config.replicationTimeoutMs,
  replicationFactor: config.replicationFactor,
  
  // Security
  enableBlockedContent: config.enableBlockedContent,
  allowedApps: config.allowedApps,
  requireAppRegistry: config.requireAppRegistry,
  
  // Performance
  cacheSizeMB: config.cacheSizeMB,
  compressionEnabled: config.compressionEnabled,
  
  // Monitoring
  metricsEnabled: config.metricsEnabled,
  logLevel: config.logLevel
});

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

// Export ConfigManager for runtime config updates
export { configManager, getConfigManager };
