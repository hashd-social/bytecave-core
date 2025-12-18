/**
 * HASHD Vault - Type Definitions
 */

export interface BlobMetadata {
  cid: string;
  size: number;
  mimeType: string;
  createdAt: number;
  version: number; // Schema version, starting at 1
  pinned?: boolean; // Never delete if true (Requirement 9)
  integrityHash?: string; // HMAC of critical fields to detect tampering
  // Content type for policy enforcement (messages, posts, media, listings)
  contentType?: string;
  // Guild ID for guild-specific filtering
  guildId?: string;
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
  // Content policy metadata (passed from original store)
  contentType?: string;
  guildId?: string;
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
  peerId?: string;
  multiaddrs?: string[];
  publicKey?: string;
  ownerAddress?: string;
  lastReplication: number;
  metrics: {
    requestsLastHour: number;
    avgResponseTime: number;
    successRate: number;
  };
  integrity?: {
    checked: number;
    passed: number;
    failed: number;
    orphaned: number;
    metadataTampered: number;
    failedCids: string[];
  };
}

export interface Peer {
  url: string;
  nodeId?: string;
  publicKey?: string;
  priority: number;
  enabled: boolean;
  lastHealthCheck?: number;
  healthy?: boolean;
  latency?: number;
}

export interface PeerConfig {
  peers: Peer[];
  replicationFactor: number;
  replicationTimeout: number;
}

// Blocked content - CIDs this node operator chooses not to store/serve
export interface BlockedContent {
  version: number;
  updatedAt: number;
  cids: string[];
}

// Content types that nodes can choose to store
export type ContentType = 'messages' | 'posts' | 'media' | 'listings';

// Content filter configuration
export interface ContentFilterConfig {
  // Which content types to accept ('all' or array of types)
  types: 'all' | ContentType[];
  // Allowlist: only accept content for these guild/group IDs (token IDs)
  // 'all' = accept all guilds (default)
  allowedGuilds: 'all' | string[];
  // Blocklist: reject content for these guild/group IDs
  // Takes precedence over allowedGuilds
  blockedGuilds: string[];
}

export interface Config {
  nodeEnv: string;
  nodeId: string;
  port: number;
  nodeUrl: string;
  // Node identity for P2P and registration
  publicKey: string;
  ownerAddress: string;
  // P2P Configuration
  p2pEnabled: boolean;
  p2pListenAddresses: string[];
  p2pBootstrapPeers: string[];
  p2pRelayPeers: string[];
  p2pEnableDHT: boolean;
  p2pEnableMDNS: boolean;
  p2pEnableRelay: boolean;
  shardCount: number;
  nodeShards: number[] | ShardRange[];
  // Content type filtering
  contentFilter: ContentFilterConfig;
  gcEnabled: boolean;
  gcRetentionMode: RetentionMode;
  gcMaxStorageMB: number;
  gcMaxBlobAgeDays: number;
  gcMinFreeDiskMB: number;
  gcReservedForPinnedMB: number;
  gcIntervalMinutes: number;
  gcVerifyReplicas: boolean;
  gcVerifyProofs: boolean;
  dataDir: string;
  maxBlobSizeMB: number;
  maxStorageGB: number;
  replicationEnabled: boolean;
  replicationTimeoutMs: number;
  replicationFactor: number;
  enableBlockedContent: boolean;
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

// ============================================
// REPLICATION FACTOR (Requirement 6)
// ============================================

export interface ReplicationTarget {
  nodeId: string;
  url: string;
  publicKey?: string;
  score?: number;
}

export interface ReplicationState {
  cid: string;
  replicationFactor: number;
  targetNodes: string[];        // Node IDs that should store this blob
  confirmedNodes: string[];     // Nodes that confirmed storage
  failedNodes: string[];        // Nodes that failed to store
  lastUpdated: number;
  complete: boolean;
  integrityHash?: string;       // HMAC to detect tampering
  lastVerified?: number;        // Last time replicas were verified with peers
}

export interface ReplicationStatus {
  cid: string;
  expectedReplicas: number;
  actualReplicas: number;
  nodes: Array<{
    nodeId: string;
    url: string;
    status: 'confirmed' | 'pending' | 'failed';
    lastProof?: number;
  }>;
  complete: boolean;
}

export interface NodeSelectionResult {
  selected: ReplicationTarget[];
  excluded: Array<{ nodeId: string; reason: string }>;
}

// ============================================
// STORAGE SHARDING (Requirement 7)
// ============================================

export interface ShardRange {
  start: number;
  end: number;
}

export interface NodeShardInfo {
  nodeId: string;
  shards: number[] | ShardRange[];  // Explicit list or ranges
  shardCount: number;                // Total shards in network
}

export interface ShardAssignment {
  shardKey: number;
  eligibleNodes: string[];
  shardCount: number;
}

// ============================================
// GARBAGE COLLECTION (Requirement 8)
// ============================================

export type RetentionMode = 'size' | 'time' | 'hybrid';

export interface GCConfig {
  enabled: boolean;
  retentionMode: RetentionMode;
  maxStorageMB: number;
  maxBlobAgeDays: number;
  minFreeDiskMB: number;
  reservedForPinnedMB: number;
  gcIntervalMinutes: number;
}


export interface GCCandidate {
  cid: string;
  size: number;
  age: number;
  lastAccessed: number;
  pinned: boolean;
  priority: number;
}

/**
 * Requirement 10: Encrypted Multi-Writer Feeds
 */

// Feed types (R10.1)
export type FeedType = 'dm' | 'post' | 'listing' | 'activity';

// Feed event types (R10.2)
export type FeedEventType = 'message' | 'comment' | 'post' | 'edit' | 'reaction' | 'delete';

// Feed entry metadata (R10.2)
export interface FeedEvent {
  feedId: string;
  cid: string;
  parentCid: string | null; // null for root entries
  authorKey: string;
  timestamp: number;
  signature: string; // Ed25519 signature over feedId, cid, parentCid, timestamp, authorKey
  eventType?: FeedEventType; // Optional hint for clients
}

// Encrypted payload structure (R10.2)
export interface FeedPayload {
  type: FeedEventType;
  content: string;
  attachments?: string[]; // Array of CIDs
  metadata?: Record<string, any>; // Optional metadata
}

// Feed metadata
export interface FeedMetadata {
  feedId: string;
  feedType: FeedType;
  rootCid: string | null; // First entry CID
  writers: string[]; // Authorized writer public keys
  createdAt: number;
  lastUpdatedAt: number;
  entryCount: number;
}

// Feed entry with full data
export interface FeedEntryWithBlob {
  event: FeedEvent;
  ciphertext: Buffer;
}

// Feed discovery response (R10.8)
export interface FeedDiscoveryResponse {
  feedId: string;
  metadata: FeedMetadata;
  events: FeedEvent[];
  cursor?: string;
  hasMore: boolean;
}

// Feed validation result (R10.6)
export interface FeedValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// Fork resolution result (R10.7)
export interface ForkResolutionResult {
  winningChain: FeedEvent[];
  discardedChains: FeedEvent[][];
  reason: string;
}

/**
 * Requirement 11: Node Discovery & Selection Protocol
 */

// Node registry data (R11.1a)
export interface NodeRegistryEntry {
  nodeId: string;
  publicKey: string;
  endpoint: string;
  metadataHash: string;
  active: boolean;
  registeredAt: number;
}

// Node self-reported metadata (R11.1b)
export interface NodeMetadata {
  nodeId: string;
  version: string;
  minVersion: string; // Minimum required version from contract
  versionCompliant: boolean; // True if version >= minVersion
  versionBehind: boolean; // True if version < minVersion
  features: string[];
  // Content type filtering
  contentTypes: 'all' | ContentType[]; // What content types this node accepts
  allowedGuilds: 'all' | string[]; // 'all' or specific guild IDs
  blockedGuilds: string[]; // Guild IDs that are blocked
  storageCapacity: number;
  storageUsed: number;
  loadFactor: number; // 0-1
  shardParticipation: number[]; // Array of shard IDs
  localScore: number;
  uptime: number;
  timestamp: number;
}

// Cached node observations (R11.1c)
export interface NodeObservations {
  nodeId: string;
  successRate: number; // 0-1
  avgLatency: number; // milliseconds
  replicationSuccess: number; // 0-1
  proofFreshness: number; // timestamp of last valid proof
  rateLimited: boolean;
  lastSeen: number;
  requestCount: number;
  failureCount: number;
  cachedAt: number;
}

// Node score components (R11.2)
export interface NodeScore {
  nodeId: string;
  totalScore: number; // 0-100
  proofFreshnessScore: number; // 40%
  responseLatencyScore: number; // 20%
  reliabilityScore: number; // 20%
  capacityScore: number; // 10%
  shardRelevanceScore: number; // 10%
  lastUpdated: number;
}

// Node misbehavior tracking (R11.6)
export interface NodeMisbehavior {
  nodeId: string;
  invalidProofCount: number;
  cidMismatchCount: number;
  corruptBlobCount: number;
  timeoutCount: number;
  lastMisbehavior: number;
  banUntil: number | null; // null if not banned
  permanentBan: boolean;
}

// Upload result (R11.3)
export interface UploadResult {
  cid: string;
  successfulNodes: string[];
  failedNodes: string[];
  success: boolean;
  warnings: string[];
}

// Download result (R11.4)
export interface DownloadResult {
  cid: string;
  ciphertext: Buffer;
  sourceNode: string;
  latency: number;
  verified: boolean;
}

// Feed sync result (R11.5)
export interface FeedSyncResult {
  feedId: string;
  events: FeedEvent[];
  sourceNodes: string[];
  missingBlobs: string[];
  errors: string[];
}

/**
 * Requirement 12: Writer Authorization
 */

// Writer authorization context (R12.1)
export interface WriterContext {
  writerPubKey: string;        // P-256 public key
  walletAddress: string;       // Associated wallet
  mailboxId: string;           // Deterministic mailbox ID
}

// Guild tier types (R12.4)
export type GuildTier = 'public' | 'members' | 'token_gated' | 'prime_key';

// Guild posting rules (R12.4)
export interface GuildPostingRules {
  tier: GuildTier;
  memberList?: string[];       // For 'members' tier
  tokenAddress?: string;       // For 'token_gated' tier
  minBalance?: string;         // For 'token_gated' tier
  primeKeyHolders?: string[];  // For 'prime_key' tier
}

// Authorization check result (R12.7)
export interface AuthorizationResult {
  authorized: boolean;
  reason?: string;
  rejectionType?: 'signature' | 'blocklist' | 'tier' | 'chain' | 'timestamp';
}

// Message state (R12.2)
export type MessageState = 'valid' | 'missing' | 'invalid' | 'censored';

// Validated feed event (R12.6)
export interface ValidatedFeedEvent extends FeedEvent {
  state: MessageState;
  validationErrors: string[];
  writerContext?: WriterContext;
}

/**
 * Requirement 13: Vault Node Reputation System (extends Requirement 4/5)
 */

// Reputation class (R13.4)
export type ReputationClass = 'gold' | 'silver' | 'bronze' | 'blacklisted';

// Local node reputation (R13.1, R13.3) - extends existing
export interface LocalNodeReputation extends NodeReputationData {
  class: ReputationClass;
  decayedScore: number;
}

// Global reputation entry (R13.8)
export interface GlobalReputationEntry {
  nodeId: string;
  score: number;
  lastVerified: number;
  flags: string[];
}

// Global reputation manifest (R13.8)
export interface GlobalReputationManifest {
  version: string;
  timestamp: number;
  entries: GlobalReputationEntry[];
  signature: string;
}

// Node health check result (R13.6)
export interface NodeHealthCheck {
  nodeId: string;
  online: boolean;
  latency: number;
  proofCapable: boolean;
  blobIntegrity: boolean;
  timestamp: number;
}

// Reputation export (R13.10)
export interface ReputationExport {
  version: string;
  exportedAt: number;
  reputations: LocalNodeReputation[];
  encrypted: boolean;
}

/**
 * Requirement 14: Lightweight Consensus & Anti-Censorship
 */

// Consensus scope (R14.1)
export type ConsensusType = 'availability' | 'integrity' | 'replica_agreement';

// Blob permanence level (R14.9)
export type BlobPermanence = 'ephemeral' | 'persistent' | 'archival';

// Replica fetch result (R14.2, R14.3)
export interface ReplicaFetchResult {
  nodeId: string;
  cid: string;
  ciphertext: Buffer | null;
  hash: string | null;
  latency: number;
  success: boolean;
  error?: string;
}

// Consensus result (R14.3)
export interface ConsensusResult {
  cid: string;
  consensus: boolean;
  matchingReplicas: number;
  totalReplicas: number;
  acceptedHash: string | null;
  ciphertext: Buffer | null;
  disputedNodes: string[];
  censoringNodes: string[];
}

// Dispute record (R14.6)
export interface DisputeRecord {
  cid: string;
  timestamp: number;
  conflictingHashes: Map<string, string[]>; // hash -> nodeIds
  resolution: 'pending' | 'resolved' | 'unresolvable';
}

// Censorship detection (R14.4, R14.10)
export interface CensorshipEvent {
  cid: string;
  nodeId: string;
  timestamp: number;
  type: 'refusal' | 'timeout' | 'invalid_response';
  context: string;
}

// Audit log entry (R14.10)
export interface AuditLogEntry {
  timestamp: number;
  type: 'node_failure' | 'dispute' | 'censorship_suspicion' | 'consensus_failure';
  cid?: string;
  nodeId?: string;
  details: Record<string, any>;
}

// Blob metadata with permanence (R14.9)
export interface BlobMetadataWithPermanence extends BlobMetadata {
  permanence: BlobPermanence;
  replicationTarget: number;
  archivalNodes?: string[];
}

/**
 * Requirement 15: Blob Indexing & Query Layer
 */

// Blob type for indexing (R15.2)
export type IndexableBlobType = 'message' | 'post' | 'comment' | 'attachment';

// Standardized blob metadata tags (R15.2)
export interface IndexableBlobMetadata {
  type: IndexableBlobType;
  threadId: string;        // keccak256(publicThreadIdentifier) - privacy-preserving
  guildId?: string;        // Optional guild contract ID
  parentCid?: string;      // Reference to parent blob
  timestamp: number;
  size: number;
  mediaType?: string;      // MIME type
}

// Index entry (R15.1)
export interface IndexEntry {
  cid: string;
  type: IndexableBlobType;
  timestamp: number;
  threadId: string;
  guildId?: string;
  parentCid?: string;
  size: number;
  mediaType?: string;
  indexed: number;         // When it was indexed
}

// Index query result (R15.3)
export interface IndexQueryResult {
  entries: IndexEntry[];
  cursor?: string;         // For pagination
  hasMore: boolean;
  total?: number;
}

// Delta sync result (R15.4)
export interface DeltaSyncResult {
  newEntries: IndexEntry[];
  sinceTimestamp: number;
  currentTimestamp: number;
  count: number;
}

export interface GCResult {
  checked: number;
  deleted: number;
  skippedPinned: number;
  skippedInsufficientReplicas: number;
  skippedShardMismatch: number;
  freedBytes: number;
  deletedCids: string[];
}

export interface GCStatus {
  enabled: boolean;
  retentionMode: RetentionMode;
  maxStorageMB: number;
  usedStorageMB: number;
  lastRun: number;
  deletedCount: number;
  skippedPinned: number;
  skippedInsufficientReplicas: number;
  nextRun: number;
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

export class UnauthorizedError extends VaultError {
  constructor(message: string, details?: any) {
    super(message, 'UNAUTHORIZED', 401, details);
  }
}

export class ForbiddenError extends VaultError {
  constructor(message: string, details?: any) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

// ============================================
// STORAGE AUTHORIZATION (Direct Storage Spec)
// ============================================

export type AuthorizationType = 
  | 'group_post' 
  | 'group_comment' 
  | 'message' 
  | 'token_distribution';

export interface StorageAuthorization {
  type: AuthorizationType;
  sender: string;              // Ethereum address
  signature: string;           // EIP-191 signature
  timestamp: number;           // Unix timestamp (ms)
  nonce: string;               // Random nonce for replay protection
  contentHash: string;         // keccak256(ciphertext)
  
  // Type-specific context
  groupPostsAddress?: string;  // For group_post, group_comment
  postId?: number;             // For group_comment
  threadId?: string;           // For message (bytes32 hex)
  participants?: string[];     // For message (sorted addresses)
  tokenAddress?: string;       // For token_distribution
}

export interface AuthorizedStoreRequest {
  ciphertext: string;          // Base64 encoded
  mimeType: string;
  authorization: StorageAuthorization;
}

export interface AuthorizedStoreResponse {
  success: boolean;
  cid: string;
  timestamp: number;
  replicationStatus: {
    target: number;
    confirmed: number;
  };
}

export interface AuthorizationVerificationResult {
  authorized: boolean;
  sender?: string;
  error?: string;
  details?: any;
}
