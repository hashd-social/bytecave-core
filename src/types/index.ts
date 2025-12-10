/**
 * HASHD Vault - Type Definitions
 */

export interface BlobMetadata {
  cid: string;
  size: number;
  mimeType: string;
  createdAt: number;
  version: number; // Schema version, starting at 1
  replication?: {
    fromPeer?: string;
    replicatedAt?: number;
    replicatedTo?: string[];
  };
  metrics?: {
    retrievalCount: number;
    lastAccessed: number;
    avgLatency: number;
  };
}

export interface StoreRequest {
  ciphertext: string;
  mimeType: string;
}

export interface StoreResponse {
  cid: string;
  replicationSuggested: string[];
  storedAt: number;
}

export interface BlobResponse {
  cid: string;
  ciphertext: string;
  mimeType: string;
  createdAt: number;
  size: number;
  version: number;
}

export interface ReplicateRequest {
  cid: string;
  ciphertext: string;
  mimeType: string;
  fromPeer: string;
}

export interface ReplicateResponse {
  success: boolean;
  cid: string;
  alreadyStored: boolean;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  storedBlobs: number;
  totalSize: number;
  latencyMs: number;
  version: string;
  peers: number;
  lastReplication: number;
  metrics: {
    requestsLastHour: number;
    avgResponseTime: number;
    successRate: number;
  };
}

export interface Peer {
  url: string;
  priority: number;
  enabled: boolean;
  lastHealthCheck?: number;
  healthy?: boolean;
}

export interface PeerConfig {
  peers: Peer[];
  replicationFactor: number;
  replicationTimeout: number;
}

export interface Banlist {
  version: number;
  updatedAt: number;
  cids: string[];
  tagIDs: string[];
  userIDs: string[];
  reason?: string;
  authority?: string;
}

export interface Config {
  nodeEnv: string;
  nodeId: string;
  port: number;
  nodeUrl: string;
  dataDir: string;
  maxBlobSizeMB: number;
  maxStorageGB: number;
  replicationEnabled: boolean;
  replicationTimeoutMs: number;
  replicationFactor: number;
  enableBanlist: boolean;
  banlistSyncUrl?: string;
  cacheSizeMB: number;
  compressionEnabled: boolean;
  metricsEnabled: boolean;
  logLevel: string;
  corsOrigin: string[];
}

export interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatency: number;
  requestsLastHour: number;
  bandwidthServed: number;
  replicationCount: number;
  replicationFailures: number;
  startTime: number;
}

// ============================================
// STORAGE PROOFS (Requirement 4)
// ============================================

export interface StorageProof {
  cid: string;              // Content identifier
  nodeId: string;           // Node identifier
  timestamp: number;        // Unix timestamp
  challenge: string;        // Challenge hash
  signature: string;        // Ed25519 signature
  publicKey: string;        // Node's public key
}

export interface ProofGenerateRequest {
  cid: string;
  challenge: string;
}

export interface ProofGenerateResponse {
  nodeId: string;
  proof: string;            // Signature
  publicKey: string;
  timestamp: number;
  challenge: string;
  cid: string;
}

export interface ProofVerificationResult {
  valid: boolean;
  nodeId?: string;
  timestamp?: number;
  error?: string;
}

// ============================================
// REPUTATION SYSTEM (Requirement 5)
// ============================================

export type ReputationEventType =
  | 'proof-success'
  | 'proof-failure'
  | 'blob-available'
  | 'blob-missing'
  | 'blob-corrupted'
  | 'uptime-ping'
  | 'replication-accepted'
  | 'replication-failed'
  | 'invalid-signature'
  | 'stale-proof'
  | 'slow-response'
  | 'no-response';

export interface ReputationEvent {
  type: ReputationEventType;
  timestamp: number;
  nodeId?: string;
  cid?: string;
  details?: any;
}

export interface ReputationScore {
  nodeId: string;
  score: number;              // 0-1000
  lastSeen: number;
  eventCount: number;
  lastUpdated: number;
}

export interface ReputationSnapshot {
  nodeId: string;
  score: number;
  timestamp: number;
  publicKey?: string;
}

export interface ReputationReport {
  nodeId: string;
  eventType: ReputationEventType;
  cid?: string;
  timestamp: number;
  reporter?: string;
}

export interface NodeReputationData {
  nodeId: string;
  score: number;
  events: ReputationEvent[];
  firstSeen: number;
  lastSeen: number;
}

export class VaultError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'VaultError.js';
  }
}

export class BlobNotFoundError extends VaultError {
  constructor(cid: string) {
    super(`Blob not found: ${cid}`, 'BLOB_NOT_FOUND', 404, { cid });
  }
}

export class BlobBannedError extends VaultError {
  constructor(cid: string) {
    super(`Blob is banned: ${cid}`, 'BLOB_BANNED', 403, { cid });
  }
}

export class CIDMismatchError extends VaultError {
  constructor(expected: string, actual: string) {
    super(
      `CID mismatch: expected ${expected}, got ${actual}`,
      'CID_MISMATCH',
      400,
      { expected, actual }
    );
  }
}

export class StorageFullError extends VaultError {
  constructor() {
    super('Storage capacity reached', 'STORAGE_FULL', 507);
  }
}

export class InvalidRequestError extends VaultError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_REQUEST', 400, details);
  }
}

export class PayloadTooLargeError extends VaultError {
  constructor(size: number, maxSize: number) {
    super(
      `Payload too large: ${size} bytes (max: ${maxSize} bytes)`,
      'PAYLOAD_TOO_LARGE',
      413,
      { size, maxSize }
    );
  }
}
