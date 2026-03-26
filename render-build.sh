#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing dependencies..."
npm install --include=dev

echo "==> Generating Prisma client..."
npx prisma generate

echo "==> Running database migrations..."
npx prisma migrate deploy

echo "==> Building TypeScript..."
rm -rf dist/
tsc

echo "==> Copying static assets..."
cp -r src/public dist/public
cp -r src/idl dist/idl

echo "==> Build complete!"
