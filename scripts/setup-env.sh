#!/usr/bin/env bash
#
# setup-env.sh — Generate production secrets for Agora.
#
# Creates a .env.production file with secure random values.
# You still need to fill in DATABASE_URL, eBay keys, etc.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENV_FILE=".env.production"

if [ -f "$ENV_FILE" ]; then
  echo "⚠️  $ENV_FILE already exists."
  read -p "   Overwrite? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "🔐 Generating production secrets..."

# Generate cryptographically secure random values
JWT_SECRET=$(openssl rand -hex 32)
WALLET_KEY=$(openssl rand -hex 32)

cat > "$ENV_FILE" << EOF
# ═══════════════════════════════════════════════════
# AGORA — Production Environment Variables
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ═══════════════════════════════════════════════════

# Database (PostgreSQL)
# Railway: auto-set by PostgreSQL addon
# Neon: https://neon.tech → copy connection string
DATABASE_URL=postgresql://user:password@host:5432/agora?schema=public

# Server
PORT=3000
NODE_ENV=production

# Authentication
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRY=24h

# Wallet Encryption (AES-256-GCM — 32 bytes hex)
WALLET_ENCRYPTION_KEY=${WALLET_KEY}

# Solana
SOLANA_CLUSTER_URL=https://api.devnet.solana.com
SOLANA_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
SOLANA_CLUSTER=devnet
HELIUS_API_KEY=
PLATFORM_AUTHORITY_KEYPAIR=

# eBay Integration
EBAY_APP_ID=
EBAY_CERT_ID=
EBAY_DEV_ID=
EBAY_REDIRECT_URI=
EBAY_SANDBOX=true
EBAY_USDC_TO_USD_RATE=1.0

# Carrier Tracking
FEDEX_CLIENT_ID=
FEDEX_CLIENT_SECRET=
CANADA_POST_USERNAME=
CANADA_POST_PASSWORD=
TRACKING_POLL_INTERVAL_MS=1800000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Webhooks
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=3

# Railway
RAILWAY_PUBLIC_DOMAIN=
EOF

echo "✅ Created $ENV_FILE"
echo ""
echo "📝 Next steps:"
echo "   1. Set DATABASE_URL to your production PostgreSQL"
echo "   2. Set eBay API credentials (apply at developer.ebay.com)"
echo "   3. Set PLATFORM_AUTHORITY_KEYPAIR for on-chain escrow"
echo "   4. Load with: export \$(cat $ENV_FILE | grep -v '^#' | grep -v '^\$' | xargs)"
echo ""
echo "🔒 Keep this file secure. Never commit to git."
