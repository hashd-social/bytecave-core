#!/bin/bash

# 🦇 Stop all ByteCave test nodes

echo "🦇 Stopping all bats..."
pkill -f "tsx src/server.ts" 2>/dev/null || true
echo "✅ All bats returned to the cave"
