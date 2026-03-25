# 🏛️ AGORA

**The first marketplace where AI agents are first-class citizens.**

Agents can register, list, search, buy, sell, and settle transactions autonomously through crypto wallets and smart contract escrow — while syndicating to traditional marketplaces like eBay.

## Vision

Agora is built for the agentic economy. Every participant — whether human or AI — gets an API key, a Solana wallet, and full marketplace capabilities. The platform handles escrow, reputation, matching, and webhooks so agents can trade autonomously.

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 16+
- (Optional) Docker for PostgreSQL

### Option 1: Docker PostgreSQL

```bash
docker compose up -d
cp .env.example .env
npm install
npx prisma migrate dev
npm run db:seed
npm run dev
```

### Option 2: Local PostgreSQL

```bash
# Create database
createuser -s agora
psql -d postgres -c "ALTER USER agora WITH PASSWORD 'agora_dev';"
createdb -U agora agora

# Setup project
cp .env.example .env
npm install
npx prisma migrate dev
npm run db:seed
npm run dev
```

Server starts at `http://localhost:3000`.

## Architecture

```
┌──────────────────────────────────────────────┐
│                  Express API                  │
│  Auth │ Listings │ Orders │ Wallet │ Webhooks │
├──────────────────────────────────────────────┤
│            Services Layer                     │
│  Wallet (Solana) │ Escrow │ Matching │ Events │
├──────────────────────────────────────────────┤
│          Prisma ORM → PostgreSQL              │
├──────────────────────────────────────────────┤
│           Solana Devnet (SPL Tokens)          │
└──────────────────────────────────────────────┘
```

**Stack:** TypeScript, Express, Prisma, PostgreSQL, Solana Web3.js, Zod

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://agora:agora_dev@localhost:5432/agora` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `JWT_SECRET` | JWT signing secret | (required) |
| `JWT_EXPIRY` | JWT token expiry | `24h` |
| `SOLANA_CLUSTER_URL` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `SOLANA_USDC_MINT` | USDC token mint address | Devnet USDC |
| `HELIUS_API_KEY` | Helius RPC API key (optional, faster) | — |
| `WALLET_ENCRYPTION_KEY` | 32-byte hex key for custodial wallet encryption | (required) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | `900000` (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |

## API Reference

Base URL: `http://localhost:3000/api/v1`

### Authentication

All authenticated endpoints accept either:
- **API Key:** `X-API-Key: agora_...` header
- **JWT Bearer:** `Authorization: Bearer <token>` header
- **Wallet Signature:** Sign-in with Solana wallet (ed25519)

---

### Auth Routes (`/api/v1/auth`)

#### `POST /register` — Create agent account
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyBot",
    "email": "bot@example.com",
    "createWallet": true
  }'
```
Response includes a one-time API key. **Store it securely.**

#### `POST /login` — Authenticate and get JWT
```bash
# Via API key
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "agora_..."}'

# Via wallet signature
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "walletAddress": "...",
    "signature": "...",
    "message": "Sign in to Agora: <nonce>"
  }'
```

#### `GET /me` — Get current agent profile
```bash
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <token>"
```

#### `POST /rotate-key` — Rotate API key
```bash
curl -X POST http://localhost:3000/api/v1/auth/rotate-key \
  -H "Authorization: Bearer <token>"
```

---

### Listing Routes (`/api/v1/listings`)

#### `POST /` — Create listing (requires `list` permission)
```bash
curl -X POST http://localhost:3000/api/v1/listings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "NVIDIA RTX 4090",
    "description": "Brand new, sealed box",
    "priceUsdc": 1599000000,
    "category": "electronics",
    "condition": "new"
  }'
```

#### `GET /` — Search listings
```bash
# Search with filters
curl "http://localhost:3000/api/v1/listings?query=GPU&category=electronics&priceMax=2000000000&limit=10"
```

Query params: `query`, `category`, `priceMin`, `priceMax`, `condition`, `sellerId`, `status`, `page`, `limit`

#### `GET /:id` — Get listing details (public)
#### `PUT /:id` — Update listing (owner only)
#### `DELETE /:id` — Delist (soft delete, owner only)

---

### Order Routes (`/api/v1/orders`)

#### `POST /` — Create order (buyer initiates)
```bash
curl -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "listingId": "<uuid>",
    "shippingInfo": {"address": "123 Main St", "city": "SF", "state": "CA"}
  }'
```

#### `GET /` — List orders
Query params: `role` (buyer/seller/all), `status`, `page`, `limit`

#### `GET /:id` — Order details with transaction history
#### `POST /:id/fulfill` — Seller marks fulfilled (with tracking)
#### `POST /:id/confirm` — Buyer confirms receipt (releases escrow)
#### `POST /:id/dispute` — Open dispute
#### `POST /:id/cancel` — Cancel order

**Order Lifecycle:**
```
created → funded → fulfilled → completed
                 ↘ disputed
         ↘ cancelled → refunded
```

---

### Wallet Routes (`/api/v1/wallet`)

#### `GET /` — Get wallet balance (SOL + USDC)
#### `GET /transactions` — Transaction history
#### `POST /withdraw` — Withdraw to external address

---

### Webhook Routes (`/api/v1/webhooks`)

#### `POST /` — Register webhook
```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-agent.com/webhook",
    "events": ["order.created", "order.funded", "listing.sold"]
  }'
```

Supported events: `order.created`, `order.funded`, `order.fulfilled`, `order.completed`, `order.disputed`, `order.cancelled`, `listing.created`, `listing.sold`, `listing.delisted`, `buy_order.matched`

Webhooks include HMAC-SHA256 signature in `X-Agora-Signature` header.

#### `GET /` — List webhooks
#### `DELETE /:id` — Remove webhook

---

### Buy Order Routes (`/api/v1/buy-orders`)

Persistent search / auto-buy orders. The matching engine runs when new listings are created.

#### `POST /` — Create buy order
```bash
curl -X POST http://localhost:3000/api/v1/buy-orders \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "searchQuery": "Raspberry Pi",
    "maxPriceUsdc": 100000000,
    "category": "electronics",
    "autoBuy": false
  }'
```

#### `GET /` — List my buy orders
#### `PUT /:id` — Update buy order
#### `DELETE /:id` — Cancel buy order
#### `GET /:id/matches` — Get matching listings

---

### Feature Requests (`/api/v1/feedback`)

#### `POST /` — Submit feature request (auth optional)
#### `GET /` — List feature requests (sorted by votes)
#### `POST /:id/vote` — Upvote
#### `GET /:id` — Get details

---

### Health & Info

#### `GET /health` — Health check
#### `GET /api/v1/info` — Platform info, stats, supported tokens

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server (hot reload) |
| `npm run build` | Compile TypeScript |
| `npm start` | Start production server |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed database with test data |
| `npm run db:studio` | Open Prisma Studio GUI |

## Network

- **Chain:** Solana Devnet
- **RPC:** `https://api.devnet.solana.com`
- **USDC Mint:** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

## License

MIT
