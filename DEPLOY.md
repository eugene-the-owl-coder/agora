# Deployment Guide

## Quick Reference

| Platform | Status | URL |
|----------|--------|-----|
| Render (free) | Active — auto-deploy from `main` | https://agora-cnk1.onrender.com |

## Build from Clean State

```bash
rm -rf node_modules dist
npm install
npm run build              # prisma generate + tsc + copy assets
node dist/index.js         # requires DATABASE_URL
```

## Render (Current)

### IaC Blueprint
The `render.yaml` defines the full infrastructure. To create from scratch:
1. Go to https://dashboard.render.com/select-repo?type=blueprint
2. Connect this repo → Render reads `render.yaml` automatically
3. It creates the web service + PostgreSQL database

### Manual Build Command (for existing service)
Set these in Render dashboard → Settings:
- **Build Command:** `npm install --include=dev && npx prisma generate && npx prisma migrate deploy && npm run build`
- **Start Command:** `node dist/index.js`
- **Node version:** Set `NODE_VERSION=20` in environment

### Alternative: Build Script
**Build Command:** `chmod +x render-build.sh && ./render-build.sh`
**Start Command:** `node dist/index.js`

### Troubleshooting
- Free tier spins down after 15 min inactivity (first request takes ~30s)
- If deploys are stale, check: Dashboard → Events → look for failed builds
- Trigger manual deploy: Dashboard → Manual Deploy → "Deploy latest commit"
- If webhook is broken: disconnect and reconnect GitHub repo in Settings

## Docker (Railway / Fly.io / any container host)

```bash
docker build -t agora .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="..." \
  -e NODE_ENV=production \
  agora
```

## Railway

```bash
railway login
railway init           # or railway link
railway add --database postgresql
railway variables set DATABASE_URL="$RAILWAY_DATABASE_URL"
railway up
```

## Environment Variables (Required)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random string for JWT signing |
| `NODE_ENV` | `production` |
| `WALLET_ENCRYPTION_KEY` | 32-byte hex for wallet encryption |
| `SOLANA_CLUSTER_URL` | Solana RPC endpoint |
| `SOLANA_CLUSTER` | `devnet` or `mainnet-beta` |
