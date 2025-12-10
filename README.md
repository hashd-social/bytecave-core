# HASHD Vault

Decentralized storage node for the HASHD protocol. Provides sovereign, encrypted storage with multi-node replication.

## Quick Start

### Installation

```bash
# Install dependencies
yarn install

# Copy environment file
cp .env.example .env

# Edit configuration
nano .env
```

### Development

```bash
# Run in development mode
yarn dev
```

### Production

```bash
# Build TypeScript
yarn build

# Start server
yarn start
```

## Configuration

Edit `.env` file:

```bash
# Server
PORT=3002
NODE_URL=http://localhost:3002

# Storage
DATA_DIR=./data
MAX_BLOB_SIZE_MB=10
MAX_STORAGE_GB=100

# Replication
REPLICATION_ENABLED=true
REPLICATION_FACTOR=3

# Security
ENABLE_BANLIST=true

# CORS
CORS_ORIGIN=http://localhost:3000
```

## API Endpoints

### POST /store
Store encrypted blob

```bash
curl -X POST http://localhost:3002/store \
  -H "Content-Type: application/json" \
  -d '{
    "ciphertext": "base64_encoded_data",
    "mimeType": "application/json"
  }'
```

### GET /blob/:cid
Retrieve blob

```bash
curl http://localhost:3002/blob/<cid>
```

### GET /health
Check node health

```bash
curl http://localhost:3002/health
```

## Documentation

See `/docs/Vault/` for complete documentation:

- [Overview](../docs/Vault/OVERVIEW.md)
- [API Specification](../docs/Vault/API_SPEC.md)
- [Architecture](../docs/Vault/ARCHITECTURE.md)
- [Integration Guide](../docs/Vault/INTEGRATION.md)
- [Node Setup Guide](../docs/Vault/NODE_SETUP.md)

## Features

- ✅ Content-addressed storage (SHA-256)
- ✅ Encrypted blob storage
- ✅ Multi-node replication
- ✅ Banlist enforcement
- ✅ Metrics tracking
- ✅ REST API
- ✅ TypeScript

## Project Structure

```
vault/
├── src/
│   ├── config/          # Configuration
│   ├── middleware/      # Express middleware
│   ├── routes/          # API routes
│   ├── services/        # Core services
│   ├── types/           # TypeScript types
│   ├── utils/           # Utilities
│   └── server.ts        # Main entry point
├── data/                # Storage (created on first run)
│   ├── blobs/          # Encrypted blobs
│   └── meta/           # Metadata
├── config/              # Configuration files
│   ├── peers.json      # Peer list
│   └── banlist.json    # Banned content
└── package.json
```

## Development

```bash
# Install dependencies
yarn install

# Run in dev mode (with hot reload)
yarn dev

# Build
yarn build

# Lint
yarn lint

# Format
yarn format
```

## Deployment

### Using PM2

```bash
yarn build
pm2 start dist/server.js --name hashd-vault
pm2 save
```

### Using Docker

```bash
docker build -t hashd-vault .
docker run -d -p 3002:3002 -v ./data:/data hashd-vault
```

## License

MIT
