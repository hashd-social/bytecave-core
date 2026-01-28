# ByteCave Core

Decentralized storage node for the ByteCave network. Provides encrypted blob storage with P2P replication, content-addressed sharding, and cryptographic proof generation.

## Features

- **P2P Storage** - Distributed blob storage with libp2p
- **WebRTC Support** - Direct browser-to-node P2P connections via WebRTC
- **Sharding** - Deterministic shard assignment via CID modulo for horizontal scaling
- **Encryption** - AES-256-GCM encryption for all stored data
- **Proof Generation** - Cryptographic proofs for storage verification
- **Replication** - Automatic data replication across network
- **NAT Traversal** - Circuit relay support for NAT'd nodes
- **HTTP API** - RESTful API for local/admin operations
- **P2P Protocols** - Health checks, blob retrieval, and storage via libp2p streams
- **Contract Integration** - Optional on-chain node registration with auto-register/deregister
- **Auto-Registration** - Automatic registration on startup when enabled
- **Auto-Deregistration** - Automatic deregistration when REGISTER_ON_CHAIN=false
- **File Size Limits** - 5MB maximum file size enforced across all storage and replication paths
- **Chunked Message Transmission** - Large messages automatically sent in 16KB chunks to prevent stream buffer overflow
- **Async Protocol Handlers** - All P2P protocol handlers properly await async operations for reliable error handling
- **Standardized Metadata** - Type-safe blob metadata with ContentType enum and ReplicationMetadata interface

## Cryptographic Keys & Security Model

ByteCave nodes use **two different cryptographic key pairs** for different purposes. Understanding the distinction is critical for proper node operation and registration.

### secp256k1 Key Pair (Contract Registration & P2P Identity)

**Purpose:** On-chain node registration, signature verification, and libp2p peer identity

- **Algorithm:** secp256k1 (same as Ethereum)
- **Public Key Format:** 64 bytes uncompressed (without 0x04 prefix) for contract registration
- **Private Key Derivation:** Deterministically derived from `OWNER_ADDRESS`:
  ```
  seed = SHA256("bytecave-p2p-identity" + ownerAddress.toLowerCase())
  privateKey = secp256k1.privateKeyFromSeed(seed)
  ```
- **Used For:**
  - Registering nodes in VaultNodeRegistry contract
  - On-chain signature verification via `ecrecover`
  - Proving node ownership cryptographically
  - Deriving libp2p peer ID

**Where to find it:**
- Health endpoint: `/health` → `secp256k1PublicKey` field (64 bytes uncompressed)
- Startup logs: Displayed as "🔑 secp256k1 Public Key (for contract registration)"
- Desktop app: Status tab → "secp256k1 Public Key"

**Security Properties:**
- **Deterministic:** Same owner address always produces the same key pair and peer ID
- **Provable Ownership:** Only the owner can generate valid signatures with the derived private key
- **Non-Transferable:** Cannot register someone else's node without their private key
- **Unique:** Each owner address produces a unique secp256k1 key pair

### Ed25519 Key Pair (Storage Proofs)

**Purpose:** Storage proof signing and verification

- **Algorithm:** Ed25519
- **Public Key Format:** 32 bytes raw Ed25519 public key
- **Generation:** Auto-generated on first startup, stored in `node-key.json`
- **Used For:**
  - Signing storage proofs for incentive claims
  - libp2p peer identity
  - P2P protocol authentication

**Where to find it:**
- Health endpoint: `/health` → `publicKey` field
- Startup logs: Referenced as "Ed25519 Public Key (for storage proofs)"
- Desktop app: Status tab → "Ed25519 Public Key"

**When to use it:**
- Automatically used by the node for storage proofs
- No manual intervention required

### Key Summary

| Key Type | Size | Purpose | Where to Use |
|----------|------|---------|-------------|
| **secp256k1** | 64 bytes uncompressed | Contract registration | Dashboard/Desktop registration |
| **Ed25519** | 32 bytes | Storage proofs | Auto-managed by node |

**Important:** When registering your node on-chain, always use the **secp256k1 public key** (64 bytes uncompressed), not the Ed25519 key.

## Node Registration Process

### Overview

Node registration is a cryptographic process that proves ownership of a node and prevents unauthorized registrations. The process uses deterministic key derivation and signature verification to ensure security.

### Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. KEY DERIVATION (Off-chain)                                   │
│    Owner Address → SHA256("bytecave-p2p-identity" + address)    │
│                 → secp256k1 Private Key                          │
│                 → secp256k1 Public Key (64 bytes uncompressed)   │
│                 → libp2p Peer ID                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. SIGNATURE GENERATION (Off-chain)                             │
│    Message: keccak256(ownerAddress)                             │
│    Prefix: "\x19Ethereum Signed Message:\n32" + messageHash     │
│    Signature: secp256k1.sign(prefixedMessage, privateKey)       │
│    Result: 65-byte signature (r, s, v)                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. ON-CHAIN VERIFICATION (Smart Contract)                       │
│    a) Recover signer: ecrecover(signature) → recoveredAddress   │
│    b) Derive expected: address(keccak256(publicKey))            │
│    c) Verify: recoveredAddress == expectedAddress               │
│    d) Check: One node per owner, unique peer ID                 │
└─────────────────────────────────────────────────────────────────┘
```

### Registration Steps

#### 1. Start Your Node

```bash
# Set your owner address in .env
OWNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# Start the node
yarn start
```

The node will:
- Derive secp256k1 private key from your owner address
- Generate the corresponding public key (64 bytes uncompressed)
- Create a deterministic libp2p peer ID
- Display the public key in startup logs

#### 2. Get Your Public Key

From startup logs:
```
🔑 secp256k1 Public Key (for contract registration):
   0xfbb30b1a58ccf3aeb82f1ce7773d81b2d909341fa20836c70dcd093479c30873...
   Length: 64 bytes (uncompressed, without 0x04 prefix)
```

Or via API:
```bash
curl http://localhost:5001/health | jq .secp256k1PublicKey
```

#### 3. Register On-Chain

**Option A: Automatic Registration**
```bash
# Set in .env
REGISTER_ON_CHAIN=true
PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
OWNER_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
VAULT_REGISTRY_ADDRESS=0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB
HASHD_TOKEN_ADDRESS=0x7a2088a1bFc9d81c55368AE168C2C02570cB814F
RPC_URL=http://127.0.0.1:8545

# Restart node - it will auto-register
yarn start
```

**Option B: Manual Registration (Desktop App)**
1. Open bytecave-desktop
2. Click "Register Node" button
3. The app will:
   - Fetch your secp256k1 public key from the node
   - Request a signature from the node (via `/sign-registration` endpoint)
   - Submit registration transaction to VaultNodeRegistry contract

**Option C: Manual Registration (Dashboard)**
1. Open the dashboard
2. Navigate to Vault tab
3. Click "Register Node"
4. Follow the same process as desktop app

#### 4. Verification

After registration, verify on-chain:
```bash
# Check if node is registered
curl http://localhost:5001/health | jq .registeredOnChain
# Should return: true

# Get on-chain node ID
curl http://localhost:5001/health | jq .onChainNodeId
```

### Security Guarantees

#### ✅ **Provable Ownership**
- Only the owner who controls the wallet can derive the correct secp256k1 private key
- Signature verification proves the registrant controls the private key
- **Attack Prevention:** Cannot register someone else's node without their wallet

#### ✅ **Non-Transferable**
- Keys are deterministically derived from owner address
- Same owner always produces same key pair and peer ID
- **Attack Prevention:** Cannot steal or transfer node identity

#### ✅ **Unique Registration**
- Contract enforces one node per owner address
- Contract prevents duplicate peer IDs
- **Attack Prevention:** Cannot register multiple nodes or duplicate peer IDs

#### ✅ **Cryptographic Verification**
- Signature verification uses Ethereum's `ecrecover`
- Address derivation uses standard Ethereum address computation
- **Attack Prevention:** Cannot forge signatures or bypass verification

### Signature Verification Details

The contract verifies signatures using this process:

```solidity
// 1. Hash the owner address
bytes32 messageHash = keccak256(abi.encodePacked(ownerAddress));

// 2. Add Ethereum signed message prefix
bytes32 ethSignedMessageHash = keccak256(
    abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
);

// 3. Recover signer from signature
address signer = ecrecover(ethSignedMessageHash, v, r, s);

// 4. Derive expected signer from public key
address expectedSigner = address(uint160(uint256(keccak256(publicKey))));

// 5. Verify they match
require(signer == expectedSigner, "Signature does not match public key");
```

This ensures:
- The signature was created by the private key corresponding to the public key
- The registrant controls the secp256k1 private key
- The registration is legitimate and authorized

### Troubleshooting

**"Signature does not match public key"**
- Ensure you're using the 64-byte uncompressed secp256k1 public key
- Verify the node is running and has derived keys from `OWNER_ADDRESS`
- Check that the signature is being generated by the correct node

**"Owner already has node"**
- Each owner address can only register one node
- Deregister the existing node first if you want to register a new one

**"Duplicate peer ID"**
- The peer ID is already registered by another node
- This should not happen with deterministic key derivation
- Verify your `OWNER_ADDRESS` is unique

**"Insufficient stake"**
- Ensure you have approved sufficient HASHD tokens
- Minimum stake is typically 1000 HASHD tokens
- Check token balance and allowance

## Quick Start

### Installation

```bash
# Install dependencies
yarn install

# Build
yarn build

# Run
yarn start
```

### Configuration

Create a `.env` file:

```bash
# Server Configuration
PORT=5001
DATA_DIR=./data

# P2P Configuration
P2P_ENABLED=true
P2P_LISTEN_ADDRESSES=/ip4/0.0.0.0/tcp/5011,/ip4/0.0.0.0/tcp/5012/ws
P2P_RELAY_PEERS=/dns4/relay.example.com/tcp/4001/p2p/12D3KooW...
P2P_BOOTSTRAP_PEERS=
P2P_ENABLE_RELAY=true
P2P_ENABLE_DHT=true
P2P_ENABLE_MDNS=false

# Storage Configuration
MAX_STORAGE_GB=100
SHARD_COUNT=1024
NODE_SHARDS=[{"start":0,"end":1023}]  # Range of shards this node is responsible for

# Contract Configuration (optional)
REGISTER_ON_CHAIN=false              # Set to true to auto-register on startup
PRIVATE_KEY=0x...                    # Required if REGISTER_ON_CHAIN=true
OWNER_ADDRESS=0x...                  # Your wallet address
VAULT_REGISTRY_ADDRESS=0x...         # Vault registry contract
HASHD_TOKEN_ADDRESS=0x...            # HASHD token contract
RPC_URL=http://127.0.0.1:8545        # Ethereum RPC endpoint
```

## Environment Variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5001` | HTTP API port |
| `DATA_DIR` | `./data` | Data storage directory |

### P2P Network

| Variable | Default | Description |
|----------|---------|-------------|
| `P2P_ENABLED` | `true` | Enable P2P networking |
| `P2P_LISTEN_ADDRESSES` | `/ip4/0.0.0.0/tcp/5011,/ip4/0.0.0.0/tcp/5012/ws` | Addresses to listen on |
| `P2P_RELAY_PEERS` | (empty) | Relay node multiaddrs (required) |
| `P2P_BOOTSTRAP_PEERS` | (empty) | Additional bootstrap peers |
| `P2P_ENABLE_RELAY` | `true` | Enable circuit relay transport |
| `P2P_ENABLE_DHT` | `true` | Enable DHT for peer discovery |
| `P2P_ENABLE_MDNS` | `false` | Enable mDNS for local discovery |

### Storage & Sharding

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_STORAGE_GB` | `100` | Maximum storage in GB |
| `SHARD_COUNT` | `1024` | Total shards in network (power of 2 recommended) |
| `NODE_SHARDS` | `[{"start":0,"end":1023}]` | Shard ranges this node accepts (default: all shards) |

### Blockchain

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTER_ON_CHAIN` | `false` | Auto-register/deregister on startup |
| `PRIVATE_KEY` | (optional) | Wallet private key for auto-registration |
| `OWNER_ADDRESS` | (optional) | Node owner wallet address |
| `VAULT_REGISTRY_ADDRESS` | (optional) | Vault registry contract |
| `HASHD_TOKEN_ADDRESS` | (optional) | HASHD token contract |
| `RPC_URL` | `http://127.0.0.1:8545` | Ethereum RPC endpoint |

## API Reference

### Store Blob

```bash
POST /store
Content-Type: application/octet-stream

# Response
{
  "cid": "bafybei...",
  "size": 1024,
  "encrypted": true
}
```

### Retrieve Blob

```bash
GET /retrieve/:cid

# Response
<blob data>
```

### Health Check

```bash
GET /health

# Response
{
  "status": "healthy",
  "uptime": 3600,
  "storedBlobs": 42,
  "totalSize": 1048576,
  "peerId": "12D3KooW...",
  "multiaddrs": ["/ip4/..."],
  "publicKey": "0x...",
  "peers": 5
}
```

### Node Info

```bash
GET /info

# Response
{
  "nodeId": "node-1",
  "peerId": "12D3KooW...",
  "publicKey": "0x...",
  "ownerAddress": "0x...",
  "multiaddrs": ["/ip4/..."],
  "shards": [{"start": 0, "end": 1023}],
  "shardCount": 1024
}
```

## P2P Architecture

### Discovery Flow

```
Node → Connects to Relay
     → Announces on FloodSub
     → Discovers peers via DHT
     → Establishes P2P connections
     → Replicates data
```

### Protocols

**Transports:**
- **TCP** - Node-to-node direct connections (only when both nodes have public IPs)
- **WebSockets** - Node-to-relay connections (primary transport for NAT'd nodes)
- **WebRTC** - Browser-to-node P2P connections
- **Circuit Relay v2** - NAT traversal for all peers (browsers and NAT'd nodes)

**Discovery:**
- **Kad-DHT** - Peer discovery and routing
- **FloodSub** - Peer announcements and broadcast messages
- **mDNS** - Local network discovery (optional)

**Custom Protocols:**
- `/bytecave/store/1.0.0` - Store requests from browsers
- `/bytecave/blob/1.0.0` - Blob retrieval
- `/bytecave/replicate/1.0.0` - Node-to-node replication
- `/bytecave/health/1.0.0` - Health checks (P2P, no HTTP required)
- `/bytecave/info/1.0.0` - Node info for registration

### Replication Architecture

ByteCave uses **bidirectional replication** with both push and pull mechanisms to ensure data redundancy across the network.

#### Push Replication (Existing nodes → New nodes)

When a new peer connects, existing nodes automatically push under-replicated blobs:

**Trigger:** `peer:connect` event  
**Delay:** 1 second (allows peer to fully establish connection)  
**Process:**
1. Existing node detects new peer connection
2. Checks all locally-stored blobs for replication status
3. Queries network to count existing replicas
4. Pushes blobs that are below replication factor to new peer

**Implementation:**
```typescript
p2pService.on('peer:connect', async (peerId: string) => {
  setTimeout(async () => {
    // Check if our blobs are under-replicated
    await replicationService.checkReplicationHealth();
  }, 1000);
});
```

#### Pull Replication (New nodes ← Existing nodes)

When a node connects to the network, it actively pulls missing blobs from peers:

**Trigger:** `peer:connect` event + periodic refresh (60 seconds)  
**Delay:** 1 second (same as push for bidirectional sync)  
**Process:**
1. New node connects to network
2. Queries each peer for their blob list via `/bytecave/have-list/1.0.0`
3. Compares peer blob lists with local storage
4. Pulls missing blobs via `/bytecave/blob/1.0.0`

**Implementation:**
```typescript
p2pService.on('peer:connect', async (peerId: string) => {
  setTimeout(async () => {
    // Pull missing blobs from all peers
    await replicationService.pullMissingBlobs();
  }, 1000);
});
```

#### Replication Timing

| Event | Push Delay | Pull Delay | Total Sync Time |
|-------|-----------|-----------|-----------------|
| **Peer Connection** | 1s | 1s | ~2-6s |
| **Node Startup** | 5s | 5s | ~5-10s |
| **Periodic Health Check** | - | - | Every 10 minutes |
| **Peer List Refresh** | - | 60s | Every 60 seconds |

**Result:** New nodes receive replications within **~6 seconds** of connecting, combining both push and pull mechanisms for fast, reliable synchronization.

#### Replication Factor

The target number of replicas is fetched from the on-chain VaultNodeRegistry contract:

```typescript
const replicationFactor = await vaultRegistry.getReplicationFactor();
// Default: 3 replicas per blob
```

Nodes continuously monitor replication health and re-replicate blobs that fall below the target factor.

### Sharding

Blobs are distributed across nodes using deterministic shard assignment:

**Shard Calculation:**
```javascript
// CID is converted to numeric value and modulo is applied
shardKey = numericValue(cid) % SHARD_COUNT
```

**Node Responsibility:**
Nodes declare which shard ranges they accept:
```json
{
  "shardCount": 1024,
  "nodeShards": [
    {"start": 0, "end": 255},    // Accept shards 0-255
    {"start": 512, "end": 767}   // Accept shards 512-767
  ]
}
```

**Default Behavior:**
- Single node: `[{"start": 0, "end": 1023}]` (accepts all shards)
- Multi-node: Each node accepts a subset of shards for load distribution

**Storage Decision:**
When a blob is stored, the node:
1. Calculates the shard key from the CID
2. Checks if the shard key falls within its assigned ranges
3. Accepts or rejects the blob based on shard responsibility

This ensures deterministic, content-addressed distribution without coordination.

## Deployment

### Docker

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production

COPY . .
RUN yarn build

ENV PORT=5001
ENV DATA_DIR=/data

EXPOSE 5001 5011 5012

CMD ["node", "dist/server.js"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  bytecave-node:
    build: .
    ports:
      - "5001:5001"
      - "5011:5011"
      - "5012:5012"
    volumes:
      - node-data:/data
    environment:
      - P2P_RELAY_PEERS=/dns4/relay.example.com/tcp/4001/p2p/12D3KooW...
      - OWNER_ADDRESS=0x...
      - VAULT_REGISTRY_ADDRESS=0x...
      - RPC_URL=https://...
    restart: unless-stopped

volumes:
  node-data:
```

### Production Checklist

- [ ] Configure relay peers for NAT traversal
- [ ] Set owner address and contract addresses
- [ ] Configure shard assignment (coordinate with other nodes)
- [ ] Set max storage limit based on available disk space
- [ ] Open firewall ports (5001 for HTTP, 5011-5012 for P2P)
- [ ] Configure reverse proxy with SSL (recommended for HTTP API)
- [ ] Set up monitoring and alerts
- [ ] Backup node private key and peer ID
- [ ] Test P2P connectivity and peer discovery

## Monitoring

### Metrics

```bash
# Get node health
curl http://localhost:5001/health

# Get node info
curl http://localhost:5001/info

# Check P2P peers
curl http://localhost:5001/health | jq '.peers'
```

### Logs

```bash
# View logs
tail -f logs/bytecave.log

# P2P connection logs
grep "Peer connected" logs/bytecave.log
```

## File Size Limits

ByteCave enforces a **5MB maximum file size** across all storage and replication operations to ensure network stability and prevent resource exhaustion.

### Enforcement Points

The 5MB limit is enforced at multiple layers for security:

1. **Browser Client** - Files over 5MB are rejected before upload attempt
2. **P2P Store Handler** - Nodes reject incoming store requests over 5MB
3. **Replication Handler** - Nodes reject replication requests over 5MB (prevents malicious nodes from bypassing limits)
4. **Web UI** - Upload interface validates file size before submission

### Why 5MB?

- **Network Stability** - Prevents large file transfers from overwhelming P2P streams
- **Timeout Management** - Files up to 5MB complete within reasonable timeouts (30s + 10s/MB = ~80s max)
- **Memory Efficiency** - Base64 encoding requires ~1.33x file size in memory
- **Fair Resource Usage** - Ensures equitable storage across the network

### Error Messages

When a file exceeds 5MB, you'll see:
```
File size (X.XX MB) exceeds maximum allowed size of 5MB
```

### Technical Details

**Timeout Calculation:**
```javascript
timeout = 30 seconds + (fileSize in MB × 10 seconds)
// Example: 5MB file = 30s + 50s = 80 second timeout
```

**Chunked Message Transmission:**
- All messages sent in 16KB chunks to prevent stream buffer overflow
- Both sender and receiver support chunked transmission
- Sender: `writeMessage()` splits data into 16KB chunks
- Receiver: `readMessage()` reassembles chunks using length-prefixed framing
- Handles messages of any size reliably (tested up to 5MB)

**Protocol Handler Architecture:**
- All P2P protocol handlers are async and properly awaited
- Errors are caught and handled gracefully
- Prevents silent failures in replication and storage operations
- Ensures reliable message transmission across the network

**Validation:**
- File size checked before base64 encoding
- Ciphertext size validated after encoding
- Replication requests validated to prevent bypass

## Security

- All data encrypted with AES-256-GCM
- Private keys stored securely in data directory with 0o600 permissions (owner read/write only)
- P2P connections use Noise protocol encryption
- Proof generation uses Ed25519 signatures
- No data stored in plaintext
- **File size limits enforced at multiple layers** to prevent malicious nodes from bypassing restrictions

### Key Management

The node uses **two separate Ed25519 key pairs** for different purposes:

1. **Node Signing Key** (`node-key.json`) - **CRITICAL**
   - Used for storage proofs and on-chain registration
   - Derives the on-chain `nodeId = keccak256(publicKey)`
   - **Loss = loss of node identity and staked tokens**
   - **Compromise = attacker can forge proofs and steal stake**
   - ⚠️ **MUST be backed up securely**

2. **P2P Identity Key** (`p2p-identity.json`) - **Important**
   - Used only for libp2p peer authentication
   - Determines the `peerId` for P2P network
   - **Loss = new peerId on restart (peers need to rediscover)**
   - **Compromise = attacker can impersonate node in P2P network**
   - Should be backed up for consistency

**Security Best Practices:**
- Keep `data/` directory permissions restricted (700)
- Backup both key files to secure offline storage
- Never share private keys
- Use encrypted backups for production deployments
- Consider hardware security modules (HSM) for high-value nodes

## Data Directory Structure

```
data/
├── blobs/              # Encrypted blob storage
│   └── <cid>.enc       # Encrypted blob data
├── meta/               # Blob metadata
│   └── <cid>.json      # Metadata (size, timestamp, integrity hash)
├── proofs/             # Storage proofs
│   └── <cid>.json      # Cryptographic proof of storage
├── feeds/              # Feed data (if enabled)
├── config/             # Node configuration
│   ├── config.json     # Node settings (can be regenerated)
│   └── blocked-content.json  # Content policy
├── node-key.json       # ⚠️ CRITICAL: Node signing key (BACKUP!)
└── p2p-identity.json   # P2P peer identity (backup recommended)
```

## Blob Metadata

ByteCave uses standardized metadata for blob storage and replication operations.

### ReplicationMetadata Interface

Standardized metadata used internally during replication operations:

```typescript
interface ReplicationMetadata {
  appId: string;              // Application identifier (e.g., 'hashd')
  shouldVerifyOnChain: boolean; // Requires on-chain CID verification
  sender: string;             // Wallet address that stored the blob
  timestamp: number;          // Unix timestamp when stored
}
```

**Note:** When storing blobs via the storage service, all these fields are optional.

### Content Type

ByteCave uses standard **MIME types** (e.g., `text/plain`, `image/jpeg`, `application/json`) for blob classification. The `mimeType` field in `BlobMetadata` stores this information.

### Removed Fields

The following legacy fields have been removed:

- ❌ `guildId` - Removed from replication metadata (kept only in `IndexableBlobMetadata` for guild-specific indexing)
- ❌ `metadata: Record<string, any>` - Generic catch-all removed; use explicit fields instead
- ❌ `contentType: ContentType` - Removed custom enum; use standard `mimeType` field instead

### Usage Example

```typescript
// Storing a blob with metadata
await storageService.storeBlob(cid, ciphertext, 'text/plain', {
  appId: 'hashd',
  shouldVerifyOnChain: true,
  sender: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  timestamp: Date.now()
});

// Replicating with metadata
await replicationService.replicateToAll(cid, ciphertext, 'application/json', {
  appId: 'hashd',
  shouldVerifyOnChain: true,
  sender: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  timestamp: Date.now()
});
```

## On-Chain Content Verification

ByteCave integrates with the ContentRegistry smart contract to provide on-chain verification of content CIDs. This ensures that content stored on ByteCave nodes can be verified as authentic and authorized.

### ContentRegistry Architecture

**Two-Contract Pattern:**
- **ContentRegistryStorage** - Eternal storage (never upgraded)
- **ContentRegistry** - Logic contract (upgradeable)

**Purpose:**
- Universal registry for all content CIDs across applications
- Used by nodes to verify content during replication
- Application contracts (Messages, Posts, Comments) register CIDs atomically
- Keeps storage layer agnostic and generic

### Configuration

Add ContentRegistry address to your node configuration:

```typescript
await contractIntegration.initialize({
  rpcUrl: 'http://localhost:8545',
  registryAddress: '0x...', // VaultNodeRegistry
  incentivesAddress: '0x...', // Optional
  contentRegistryAddress: '0x...' // ContentRegistry
});
```

### CID Verification During Replication

When `shouldVerifyOnChain` is `true`, nodes verify CIDs before accepting replication:

```typescript
// In replication service
if (metadata.shouldVerifyOnChain) {
  const isRegistered = await contractIntegration.isContentRegistered(cid);
  if (!isRegistered) {
    // Reject replication - CID not registered on-chain
    return false;
  }
}
```

### Content Registration Flow

**Application contracts register CIDs atomically:**

1. **Messages** - Thread CIDs registered when messages are posted
2. **Posts** - Post CIDs registered when posts are created
3. **Comments** - Comment CIDs registered when comments are added

**Atomic Pattern:**
```solidity
// In MessageContract.sol
function recordMessage(..., bytes32 threadCID) external {
  // Step 1: Register CID (reverts if fails)
  contentRegistry.registerContent(threadCID, msg.sender, appId);
  
  // Step 2: Store message metadata (only if Step 1 succeeded)
  messageStorage.createMessage(...);
}
```

**Result:** Either both succeed or both fail - no orphaned CIDs or unverified content.

### Security Model

**On-Chain Verified Content** (`shouldVerifyOnChain: true`):
- ✅ Secure - CID must be registered on-chain
- ✅ Decentralized - No central authority needed
- ✅ Tamper-proof - Blockchain immutability
- 📝 Use for: Messages, Posts, Comments, Listings

**Unverified Content** (`shouldVerifyOnChain: false`):
- ⚠️ Trust-based - No on-chain verification
- ⚠️ Vulnerable to spoofing without additional checks
- 📝 Use for: Media files, test content, public data

## Development

```bash
# Install dependencies
yarn install

# Run in development mode
yarn dev

# Run tests
yarn test

# Build
yarn build

# Lint
yarn lint
```

## Testing

```bash
# Run all tests
yarn test

# Run integration tests
yarn test:integration

# Run with coverage
yarn test:coverage
```

## Troubleshooting

### Node Can't Connect to Relay

1. Verify relay peer multiaddr is correct
2. Check relay is running and accessible
3. Verify firewall allows outbound connections
4. Check logs for connection errors

### No Peers Discovered

1. Ensure relay peers are configured
2. Verify DHT is enabled
3. Check other nodes are using same relay
4. Wait a few minutes for DHT to propagate

### Storage Errors

1. Check disk space available
2. Verify data directory permissions
3. Check max storage limit not exceeded
4. Review logs for specific errors

## Performance Tuning

### Storage

- Increase `MAX_STORAGE_GB` for more capacity
- Use SSD for better I/O performance
- Coordinate shard ranges with other nodes to balance load
- Monitor disk usage and adjust GC settings accordingly

### P2P

- Increase connection limits for more peers
- Use multiple relay nodes for redundancy
- Enable mDNS for local network discovery

### API

- Use reverse proxy with caching
- Enable compression for large responses
- Rate limit requests to prevent abuse

## License

MIT

## Contract Integration

### Auto-Registration

When `REGISTER_ON_CHAIN=true`, the node will automatically:
- Register itself on-chain on startup
- Stake 1000 HASHD tokens
- Use the configured wallet's private key

**Requirements:**
- `PRIVATE_KEY` - Wallet private key
- `VAULT_REGISTRY_ADDRESS` - Registry contract address
- `HASHD_TOKEN_ADDRESS` - HASHD token address
- `RPC_URL` - Ethereum RPC endpoint
- Sufficient HASHD balance (1000+ HASHD)

### Auto-Deregistration

When `REGISTER_ON_CHAIN=false` and node is already registered:
- Node will automatically deregister on startup
- Staked HASHD tokens are returned to wallet
- **All stored blobs and metadata are automatically deleted**
- Node continues running without on-chain registration

**Use case:** Testing or running nodes without blockchain integration

### Deregistration Cleanup

**Important:** Only registered nodes can store blobs. When a node is deregistered, all data is automatically cleaned up.

**Automatic cleanup triggers:**
1. **On deregistration** - When node is deregistered while running
2. **On startup** - If node has blobs but is not registered on-chain
3. **Health checks** - Periodic verification ensures unregistered nodes don't retain data

**What gets deleted:**
- All blob files (`~/.bytecave/*/blobs/*.enc`)
- All metadata files (`~/.bytecave/*/meta/*.json`)
- All proof files (`~/.bytecave/*/proofs/*`)

**Why:** Unregistered nodes cannot participate in the storage network. Cleanup ensures:
- No orphaned data on unregistered nodes
- Storage integrity across the network
- Proper resource management

**Note:** The node continues running after cleanup but with empty storage. Re-register to resume storing blobs.

## Related Packages

- **bytecave-relay** - Relay node for NAT traversal
- **bytecave-browser** - Browser client library
- **bytecave-desktop** - Desktop application

## Support

For issues and questions, please open an issue on GitHub.
