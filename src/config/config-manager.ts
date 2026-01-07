/**
 * Configuration Manager - Persistent config.json management
 * 
 * This module handles loading and saving configuration to a JSON file,
 * allowing runtime config updates that persist across restarts.
 */

import fs from 'fs';
import path from 'path';

export interface PersistedConfig {
  // Node Configuration
  nodeId?: string;
  port?: number;
  nodeUrl?: string;
  
  // Identity
  publicKey?: string;
  ownerAddress?: string;
  
  // P2P Configuration
  p2pBootstrapPeers: string[];
  p2pRelayPeers: string[];
  
  // Sharding
  shardCount?: number;
  nodeShards?: Array<{ start: number; end: number }>;
  
  // Garbage Collection
  gcEnabled?: boolean;
  gcRetentionMode?: 'size' | 'time' | 'hybrid';
  gcMaxStorageMB?: number;
  gcMaxBlobAgeDays?: number;
  gcMinFreeDiskMB?: number;
  gcReservedForPinnedMB?: number;
  gcIntervalMinutes?: number;
  // gcVerifyReplicas and gcVerifyProofs removed - always true for security
  
  // Storage Configuration
  maxStorageMB?: number;
  dataDir?: string;
  maxBlobSizeMB?: number;
  maxStorageGB?: number;
  
  // Replication Configuration
  replicationEnabled?: boolean;
  replicationTimeoutMs?: number;
  replicationFactor?: number;
  
  // Security
  enableBlockedContent?: boolean;
  allowedApps?: string[];
  requireAppRegistry?: boolean;
  
  // Performance
  cacheSizeMB?: number;
  compressionEnabled?: boolean;
  
  // Monitoring
  metricsEnabled?: boolean;
  logLevel?: string;
  
  // Last updated timestamp
  lastUpdated?: number;
}

export class ConfigManager {
  private configPath: string;
  private config: PersistedConfig;

  constructor(dataDir: string = './data') {
    // Store config.json in the data directory
    this.configPath = path.join(dataDir, 'config.json');
    this.config = this.loadConfigFile();
  }

  /**
   * Load configuration from config.json
   * Falls back to defaults if file doesn't exist
   */
  private loadConfigFile(): PersistedConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(data);
        console.log(`[ConfigManager] Loaded config from ${this.configPath}`);
        return config;
      }
    } catch (error) {
      console.warn(`[ConfigManager] Failed to load config from ${this.configPath}:`, error);
    }

    // Return empty config if file doesn't exist or failed to load
    console.log(`[ConfigManager] Using default config (no config.json found)`);
    return {
      p2pBootstrapPeers: [],
      p2pRelayPeers: []
    };
  }

  /**
   * Save configuration to config.json
   */
  saveConfig(): void {
    try {
      // Ensure data directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Update timestamp
      this.config.lastUpdated = Date.now();

      // Write config file
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf8'
      );
      console.log(`[ConfigManager] Saved config to ${this.configPath}`);
    } catch (error) {
      console.error(`[ConfigManager] Failed to save config to ${this.configPath}:`, error);
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): PersistedConfig {
    return { ...this.config };
  }

  /**
   * Update bootstrap peers
   */
  setBootstrapPeers(peers: string[]): void {
    this.config.p2pBootstrapPeers = peers;
    this.saveConfig();
  }

  /**
   * Add a discovered peer to bootstrap peers (if not already present)
   */
  addBootstrapPeer(peerMultiaddr: string): boolean {
    if (!this.config.p2pBootstrapPeers.includes(peerMultiaddr)) {
      this.config.p2pBootstrapPeers.push(peerMultiaddr);
      this.saveConfig();
      console.log(`[ConfigManager] Added bootstrap peer: ${peerMultiaddr}`);
      return true;
    }
    return false;
  }

  /**
   * Update relay peers
   */
  setRelayPeers(peers: string[]): void {
    this.config.p2pRelayPeers = peers;
    this.saveConfig();
  }

  /**
   * Update node configuration
   */
  updateNodeConfig(updates: Partial<PersistedConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  /**
   * Get bootstrap peers
   */
  getBootstrapPeers(): string[] {
    return [...this.config.p2pBootstrapPeers];
  }

  /**
   * Get relay peers
   */
  getRelayPeers(): string[] {
    return [...this.config.p2pRelayPeers];
  }
}

// Singleton instance
let configManagerInstance: ConfigManager | null = null;

/**
 * Get or create the ConfigManager singleton
 */
export function getConfigManager(dataDir?: string): ConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManager(dataDir);
  }
  return configManagerInstance;
}
