#!/bin/sh
set -e

echo "=== Running Prisma migrations ==="
npx prisma migrate deploy || echo "Migration warning (non-fatal)"

echo "=== Starting Agora server ==="
exec node dist/index.js
