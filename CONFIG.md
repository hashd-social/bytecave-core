# ByteCave Core Configuration

## Configuration System

ByteCave Core uses a **hybrid configuration system**:

1. **Environment Variables** (`.env` file) - Used for initial defaults and overrides
2. **Persistent Config** (`data/config.json`) - Runtime settings that persist across restarts

### Priority Order

1. Environment variables (highest priority)
2. Persisted config.json
3. Built-in defaults (lowest priority)

## Persistent Configuration (config.json)

The `data/config.json` file is automatically created and updated at runtime. It stores:

### P2P Settings

- **`p2pBootstrapPeers`**: Array of peer multiaddrs for cross-network discovery
  - Automatically populated when peers connect
  - Used to reconnect to known peers on restart
  
- **`p2pRelayPeers`**: Array of relay peer multiaddrs
  - Configured manually or via environment variable
  - Used for NAT traversal and WebSocket connections

### Node Settings

- **`nodeId`**: Unique identifier for this node
- **`port`**: HTTP API port
- **`maxStorageMB`**: Maximum storage in megabytes
- **`dataDir`**: Data directory path (automatically includes nodeId subfolder)
  - Example: `DATA_DIR=./data` with `NODE_ID=bat-alpha` creates `./data/bat-alpha`
  - This allows multiple nodes to run from the same base directory
- **`contentTypes`**: Content type filter (e.g., "all", "messages,posts")

### Auto-Discovery

When a peer connects, the node automatically:
1. Saves the peer's multiaddr to `p2pBootstrapPeers`
2. Persists the config to `data/config.json`
3. Uses these peers for reconnection on next startup

This ensures the node builds a persistent peer list over time.

## Example config.json

```json
{
  "p2pBootstrapPeers": [
    "/ip4/192.168.1.100/tcp/4001/p2p/12D3KooWExample1",
    "/ip4/192.168.1.101/tcp/4001/p2p/12D3KooWExample2"
  ],
  "p2pRelayPeers": [
    "/ip4/127.0.0.1/tcp/4002/ws/p2p/12D3KooWDUsTtqKh7VcnydpAe5G8SwiMKYramFny6caML58zbg9Y"
  ],
  "nodeId": "vault-node-1",
  "port": 3004,
  "maxStorageMB": 5000,
  "contentTypes": "all",
  "lastUpdated": 1735308000000
}
```

## Environment Variables

See `.env` file for all available environment variables. Key P2P variables:

- `P2P_BOOTSTRAP_PEERS`: Comma-separated list of bootstrap peer multiaddrs
- `P2P_RELAY_PEERS`: Comma-separated list of relay peer multiaddrs
- `P2P_ENABLED`: Enable/disable P2P networking (default: true)
- `P2P_ENABLE_DHT`: Enable Kademlia DHT (default: true)
- `P2P_ENABLE_MDNS`: Enable local network discovery (default: true)

## For ByteCave Desktop

The desktop wrapper reads and writes to `data/config.json` via the ConfigManager API.

The "Bootstrap Peers" field in desktop settings displays and allows editing of the `p2pBootstrapPeers` array from config.json.

## Production Deployment

For production:

1. Set `P2P_RELAY_PEERS` to your public relay multiaddr
2. Optionally seed `P2P_BOOTSTRAP_PEERS` with known peers
3. Let the node auto-discover and save additional peers over time
4. Back up `data/config.json` to preserve peer list

## API

The ConfigManager can be used programmatically:

```typescript
import { getConfigManager } from './config/index.js';

const configManager = getConfigManager('./data');

// Get current config
const config = configManager.getConfig();

// Add a bootstrap peer
configManager.addBootstrapPeer('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooW...');

// Update relay peers
configManager.setRelayPeers(['/ip4/relay.example.com/tcp/4002/ws/p2p/12D3KooW...']);

// Update any config field
configManager.updateNodeConfig({
  maxStorageMB: 10000,
  contentTypes: 'messages,posts'
});
```
