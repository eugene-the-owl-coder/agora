#!/bin/bash
# Retry devnet airdrop + auto-deploy escrow when funded
# Runs as cron every 30 min until deploy succeeds
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
ADDR=$(solana address)
HELIUS_KEY=$(security find-generic-password -s "Solana Trading Bot" -a "helius-api-key" -w 2>/dev/null)
AGORA_DIR="$HOME/projects/agora"
DEPLOY_MARKER="$AGORA_DIR/.escrow-deployed"

echo "[$(date)] Airdrop + Deploy check for $ADDR"

# If already deployed, skip everything
if [ -f "$DEPLOY_MARKER" ]; then
  echo "Escrow already deployed! Nothing to do."
  exit 0
fi

BALANCE=$(solana balance 2>/dev/null | awk '{print $1}')
echo "Current balance: $BALANCE SOL"

# If balance >= 3 SOL, try deploying
if [ "$(echo "$BALANCE >= 3" | bc -l 2>/dev/null)" = "1" ]; then
  echo "Sufficient balance! Attempting escrow deploy..."
  cd "$AGORA_DIR"
  anchor deploy --provider.cluster devnet 2>&1
  if [ $? -eq 0 ]; then
    echo "DEPLOYED" > "$DEPLOY_MARKER"
    echo "✅ Escrow deployed to devnet!"
    solana balance
    exit 0
  else
    echo "Deploy failed. Will retry."
  fi
fi

# Try airdrop from multiple sources
echo "Trying public devnet RPC (2 SOL)..."
solana airdrop 2 2>&1

sleep 2

echo "Trying public devnet RPC (1 SOL)..."
solana airdrop 1 2>&1

sleep 2

echo "Trying Helius devnet (1 SOL)..."
curl -s -X POST "https://devnet.helius-rpc.com/?api-key=$HELIUS_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$ADDR\",1000000000]}" 2>&1

# Check new balance
NEW_BALANCE=$(solana balance 2>/dev/null | awk '{print $1}')
echo ""
echo "Balance after attempts: $NEW_BALANCE SOL"

# If we now have enough, try deploy immediately
if [ "$(echo "$NEW_BALANCE >= 3" | bc -l 2>/dev/null)" = "1" ]; then
  echo "Got enough SOL! Deploying..."
  cd "$AGORA_DIR"
  anchor deploy --provider.cluster devnet 2>&1
  if [ $? -eq 0 ]; then
    echo "DEPLOYED" > "$DEPLOY_MARKER"
    echo "✅ Escrow deployed to devnet!"
  fi
fi

solana balance
