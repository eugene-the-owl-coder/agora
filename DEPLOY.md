# Deployment Guide

## Quick Reference

| Platform | Status | URL |
|----------|--------|-----|
| Railway | **Primary** — auto-deploy from `main` | https://web-production-13a99.up.railway.app |
| Render (free) | Fallback — may be stale | https://agora-cnk1.onrender.com |

## Build from Clean State

```bash
rm -rf node_modules dist
npm install
npm run build              # prisma generate + tsc + copy assets
node dist/index.js         # requires DATABASE_URL
```

## Railway (Primary)

Railway auto-deploys from GitHub on push to `main`. Config in `railway.toml`.

```bash
railway login
railway link               # link to existing project
railway up                 # manual deploy
railway logs               # tail logs
```

### Health Check
```bash
curl https://web-production-13a99.up.railway.app/health
```

The `/health` endpoint is mounted **before** basic auth middleware so Railway probes work without credentials.

### Environment Variables
Set via `railway variables set KEY=VALUE` or Railway dashboard.

### Notes
- `start.sh` runs Prisma migrations then starts the server
- `Dockerfile` handles the full build
- SITE_PASSWORD protects the static UI (basic auth: admin / password)
- API endpoints at `/api/v1/*` also require basic auth when SITE_PASSWORD is set

## Render (Fallback)

### IaC Blueprint
The `render.yaml` defines the full infrastructure. To create from scratch:
1. Go to https://dashboard.render.com/select-repo?type=blueprint
2. Connect this repo → Render reads `render.yaml` automatically
3. It creates the web service + PostgreSQL database

### Troubleshooting
- Free tier spins down after 15 min inactivity (first request takes ~30s)
- If deploys are stale, check: Dashboard → Events → look for failed builds
- Trigger manual deploy: Dashboard → Manual Deploy → "Deploy latest commit"

## Docker (any container host)

```bash
docker build -t agora .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="..." \
  -e NODE_ENV=production \
  agora
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
| `SITE_PASSWORD` | Basic auth password for UI (optional) |
| `ADMIN_SECRET` | Admin endpoint auth (optional) |
