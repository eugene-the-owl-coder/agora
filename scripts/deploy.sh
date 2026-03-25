#!/usr/bin/env bash
#
# deploy.sh — Build, migrate, and start Agora in production mode.
#
# Usage:
#   ./scripts/deploy.sh            # full deploy (build + migrate + start)
#   ./scripts/deploy.sh --build    # build only
#   ./scripts/deploy.sh --migrate  # migrate only
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "🏛️  AGORA — Production Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check required env vars
if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set"
  exit 1
fi

if [ -z "${JWT_SECRET:-}" ]; then
  echo "❌ JWT_SECRET is not set"
  exit 1
fi

if [ -z "${WALLET_ENCRYPTION_KEY:-}" ]; then
  echo "❌ WALLET_ENCRYPTION_KEY is not set"
  exit 1
fi

MODE="${1:-full}"

# ─── Step 1: Install dependencies ────────────────────────────────

echo ""
echo "📦 Installing dependencies..."
npm ci --production=false 2>&1 | tail -3

# ─── Step 2: Build TypeScript ────────────────────────────────────

if [ "$MODE" = "full" ] || [ "$MODE" = "--build" ]; then
  echo ""
  echo "🔨 Building TypeScript..."
  npm run build
  echo "✅ Build complete → dist/"
fi

# ─── Step 3: Copy static files ──────────────────────────────────

echo ""
echo "📄 Copying static files..."
if [ -d "src/public" ]; then
  mkdir -p dist/public
  cp -r src/public/* dist/public/
  echo "✅ Static files copied to dist/public/"
fi

# ─── Step 4: Run database migrations ────────────────────────────

if [ "$MODE" = "full" ] || [ "$MODE" = "--migrate" ]; then
  echo ""
  echo "🗃️  Running database migrations..."
  npx prisma migrate deploy
  echo "✅ Migrations complete"
fi

# ─── Step 5: Generate Prisma client ─────────────────────────────

echo ""
echo "⚙️  Generating Prisma client..."
npx prisma generate

# ─── Step 6: Start server ───────────────────────────────────────

if [ "$MODE" = "full" ]; then
  echo ""
  echo "🚀 Starting Agora..."
  echo "   NODE_ENV=production"
  echo "   PORT=${PORT:-3000}"
  echo ""
  NODE_ENV=production node dist/index.js
fi

echo ""
echo "✅ Deployment complete"
