/**
 * HASHD Vault - Configuration Management
 */

import dotenv from 'dotenv';
import { Config } from '../types/index.js';

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
  return value.toLowerCase() === 'true.js';
}

function getEnvArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }
  return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
}

export const config: Config = {
  nodeEnv: getEnv('NODE_ENV', 'development'),
  nodeId: getEnv('NODE_ID', `vault-${Date.now()}`),
  port: getEnvNumber('PORT', 3002),
  nodeUrl: getEnv('NODE_URL', 'http://localhost:3002'),
  dataDir: getEnv('DATA_DIR', './data'),
  maxBlobSizeMB: getEnvNumber('MAX_BLOB_SIZE_MB', 10),
  maxStorageGB: getEnvNumber('MAX_STORAGE_GB', 100),
  replicationEnabled: getEnvBoolean('REPLICATION_ENABLED', true),
  replicationTimeoutMs: getEnvNumber('REPLICATION_TIMEOUT_MS', 5000),
  replicationFactor: getEnvNumber('REPLICATION_FACTOR', 3),
  enableBanlist: getEnvBoolean('ENABLE_BANLIST', true),
  banlistSyncUrl: process.env.BANLIST_SYNC_URL,
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
}
