#!/bin/bash

# 🦇 ByteCave Cauldron - Spawn multiple test nodes
# Usage: yarn cauldron

echo "🦇 Starting ByteCave Cauldron - 3 nodes..."
echo ""

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Kill any existing nodes
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

# Create data directories
mkdir -p data-bat-1 data-bat-2 data-bat-3

# Start Node 1 (Bat Alpha)
echo -e "${CYAN}🦇 Spawning Bat Alpha on port 5001...${NC}"
PORT=5001 \
NODE_URL=http://localhost:5001 \
NODE_ID=bat-alpha \
DATA_DIR=./data-bat-1 \
P2P_LISTEN_ADDRESSES="/ip4/0.0.0.0/tcp/5011,/ip4/0.0.0.0/tcp/5012/ws" \
npx tsx src/server.ts > /tmp/bat-alpha.log 2>&1 &
PID1=$!
echo "  PID: $PID1"

sleep 2

# Start Node 2 (Bat Beta)
echo -e "${GREEN}🦇 Spawning Bat Beta on port 5002...${NC}"
PORT=5002 \
NODE_URL=http://localhost:5002 \
NODE_ID=bat-beta \
DATA_DIR=./data-bat-2 \
P2P_LISTEN_ADDRESSES="/ip4/0.0.0.0/tcp/5021,/ip4/0.0.0.0/tcp/5022/ws" \
npx tsx src/server.ts > /tmp/bat-beta.log 2>&1 &
PID2=$!
echo "  PID: $PID2"

sleep 2

# Start Node 3 (Bat Gamma)
echo -e "${YELLOW}🦇 Spawning Bat Gamma on port 5003...${NC}"
PORT=5003 \
NODE_URL=http://localhost:5003 \
NODE_ID=bat-gamma \
DATA_DIR=./data-bat-3 \
P2P_LISTEN_ADDRESSES="/ip4/0.0.0.0/tcp/5031,/ip4/0.0.0.0/tcp/5032/ws" \
npx tsx src/server.ts > /tmp/bat-gamma.log 2>&1 &
PID3=$!
echo "  PID: $PID3"

sleep 3

echo ""
echo "════════════════════════════════════════════════════════"
echo -e "${CYAN}🦇 CAULDRON ACTIVE - 3 BATS FLYING${NC}"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Bat Alpha:  http://localhost:5001  (P2P: 5011, 5012/ws)"
echo "  Bat Beta:   http://localhost:5002  (P2P: 5021, 5022/ws)"
echo "  Bat Gamma:  http://localhost:5003  (P2P: 5031, 5032/ws)"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/bat-alpha.log"
echo "    tail -f /tmp/bat-beta.log"
echo "    tail -f /tmp/bat-gamma.log"
echo ""
echo "  Stop all: yarn cauldron:stop"
echo ""

# Wait for any key to stop
echo "Press Ctrl+C to stop all nodes..."
trap "echo ''; echo 'Stopping all bats...'; kill $PID1 $PID2 $PID3 2>/dev/null; exit 0" SIGINT SIGTERM

# Keep script running and show combined logs
tail -f /tmp/bat-alpha.log /tmp/bat-beta.log /tmp/bat-gamma.log
