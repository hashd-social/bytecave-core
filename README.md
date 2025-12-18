# ByteCave Core

Decentralized storage node for the ByteCave network. Provides encrypted blob storage with P2P replication, sharding, and cryptographic proof generation.

## Features

- **P2P Storage** - Distributed blob storage with libp2p
- **Sharding** - Configurable shard assignment for horizontal scaling
- **Encryption** - AES-256-GCM encryption for all stored data
- **Proof Generation** - Cryptographic proofs for storage verification
- **Replication** - Automatic data replication across network
- **NAT Traversal** - Circuit relay support for NAT'd nodes
- **HTTP API** - RESTful API for storage operations
- **Contract Integration** - On-chain node registration

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
MAX_STORAGE_MB=10240
SHARD_COUNT=1024
NODE_SHARDS=[{"start":0,"end":1023}]

# Contract Configuration
OWNER_ADDRESS=0x...
VAULT_REGISTRY_ADDRESS=0x...
RPC_URL=https://...
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
| `MAX_STORAGE_MB` | `10240` | Maximum storage in MB |
| `SHARD_COUNT` | `1024` | Total shards in network |
| `NODE_SHARDS` | `[{"start":0,"end":1023}]` | Shard ranges for this node |

### Blockchain

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNER_ADDRESS` | (required) | Node owner wallet address |
| `VAULT_REGISTRY_ADDRESS` | (required) | Vault registry contract |
| `RPC_URL` | (required) | Ethereum RPC endpoint |

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
  "shards": [{"start": 0, "end": 1023}]
}
```

## P2P Architecture

### Discovery Flow

```
Node → Connects to Relay
     → Announces on Gossipsub
     → Discovers peers via DHT
     → Establishes P2P connections
     → Replicates data
```

### Protocols

- **Circuit Relay v2** - NAT traversal
- **Kad-DHT** - Peer discovery and routing
- **Gossipsub** - Peer announcements
- **Custom Protocols**:
  - `/bytecave/store/1.0.0` - Store requests
  - `/bytecave/retrieve/1.0.0` - Retrieve requests
  - `/bytecave/replicate/1.0.0` - Replication
  - `/bytecave/health/1.0.0` - Health checks

### Sharding

Nodes are assigned shard ranges to distribute storage:

```json
{
  "shardCount": 1024,
  "nodeShards": [
    {"start": 0, "end": 255},
    {"start": 512, "end": 767}
  ]
}
```

CIDs are hashed to determine shard assignment:
```
shard = hash(cid) % shardCount
```

Nodes only store blobs in their assigned shards.

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

- [ ] Configure relay peers
- [ ] Set owner address and contract addresses
- [ ] Configure shard assignment
- [ ] Set max storage limit
- [ ] Open firewall ports (5001, 5011, 5012)
- [ ] Configure reverse proxy with SSL (optional)
- [ ] Set up monitoring and alerts
- [ ] Backup private keys and data directory

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

## Security

- All data encrypted with AES-256-GCM
- Private keys stored securely in data directory
- P2P connections use Noise protocol encryption
- Proof generation uses Ed25519 signatures
- No data stored in plaintext

## Data Directory Structure

```
data/
├── blobs/           # Encrypted blob storage
│   └── <cid>/
│       ├── data     # Encrypted data
│       └── meta.json # Metadata
├── keys/            # Cryptographic keys
│   ├── private.key  # Node private key
│   └── public.key   # Node public key
└── p2p/             # P2P data
    └── peer-id.json # Persistent peer identity
```

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

- Increase `MAX_STORAGE_MB` for more capacity
- Use SSD for better I/O performance
- Adjust shard ranges to balance load

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

## Related Packages

- **bytecave-relay** - Relay node for NAT traversal
- **bytecave-browser** - Browser client library
- **bytecave-desktop** - Desktop application

## Support

For issues and questions, please open an issue on GitHub.
