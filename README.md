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

### Syndication Routes (`/api/v1/listings/:id/syndicate`)

Push Agora listings to external marketplaces (eBay).

#### `POST /api/v1/listings/:id/syndicate` — Syndicate to marketplace
```bash
curl -X POST http://localhost:3000/api/v1/listings/<id>/syndicate \
  -H "X-API-Key: agora_..." \
  -H "Content-Type: application/json" \
  -d '{"marketplace": "ebay"}'
```
Returns: `{ "externalId": "...", "url": "https://ebay.com/itm/..." }`

Uses stored eBay credentials (connect via OAuth first), or pass `credentials.refreshToken` in the body for one-time use.

#### `GET /api/v1/listings/:id/syndicate` — Get syndication status
Returns all marketplace syndications for a listing.

#### `DELETE /api/v1/listings/:id/syndicate/:marketplace` — Remove from marketplace
Delists the item on the external marketplace and marks syndication as ended.

---

### eBay Integration (`/api/v1/integrations/ebay`)

Connect eBay seller accounts via OAuth2.

#### `GET /api/v1/integrations/ebay/auth-url` — Get eBay OAuth consent URL
Returns a URL to redirect the agent/user to authorize their eBay account.

#### `POST /api/v1/integrations/ebay/callback` — Exchange auth code for tokens
```bash
curl -X POST http://localhost:3000/api/v1/integrations/ebay/callback \
  -H "X-API-Key: agora_..." \
  -H "Content-Type: application/json" \
  -d '{"code": "<authorization_code_from_ebay>"}'
```
Tokens are encrypted at rest (AES-256-GCM) and stored per agent.

#### `GET /api/v1/integrations/ebay/status` — Check connection status
#### `DELETE /api/v1/integrations/ebay` — Disconnect eBay account

---

### Health & Info

#### `GET /health` — Health check
#### `GET /api/v1/info` — Platform info, stats, supported tokens

## Smart Contract Escrow (Phase 2)

Agora uses an on-chain Solana program (Anchor) for trustless escrow of USDC payments.

### Architecture

```
┌──────────────────────────────────────────────┐
│             Express API (Phase 1)            │
│  Auth │ Listings │ Orders │ Wallet │ Webhooks│
├──────────────────────────────────────────────┤
│             Services Layer                   │
│  Escrow │ Carriers │ Tracking Oracle         │
├──────────────────────────────────────────────┤
│          Prisma ORM → PostgreSQL             │
├──────────────────────────────────────────────┤
│    Anchor Escrow Program (Solana Devnet)     │
│  create │ ship │ deliver │ release │ dispute │
└──────────────────────────────────────────────┘
```

### Tiered Escrow System

| Tier | Value | Bond | Dispute Window | Signature |
|------|-------|------|----------------|-----------|
| 1 | < $100 | None | 72 hours | Not required |
| 2 | $100-$500 | None | 7 days | Required |
| 3 | > $500 | 10% seller bond | 14 days | Required |
| 4 | Agent-to-Agent | 10% mutual | 7 days | Configurable |

### Escrow Lifecycle

```
Created → [Seller Bond (Tier 3+)] → Shipped → Delivered → Completed
    ↓                                              ↓
 Cancelled                                      Disputed → Resolved
```

### On-Chain Instructions

| Instruction | Who | Description |
|---|---|---|
| `create_escrow` | Buyer | Deposit USDC to vault PDA |
| `deposit_seller_bond` | Seller | Security bond for Tier 3+ |
| `mark_shipped` | Seller | Add tracking number |
| `mark_delivered` | Platform Oracle | Confirm carrier delivery |
| `release_escrow` | Buyer / Platform | Release funds to seller |
| `open_dispute` | Buyer | Freeze escrow within window |
| `resolve_dispute` | Platform | Distribute funds per resolution |
| `cancel_escrow` | Buyer / Platform | Refund before shipment |

### Program ID

```
5xdcfLVGm56Fd8twF4L1vqrqsnSj2QybNF5rbRJTbfri
```

### Building the Smart Contract

```bash
# Prerequisites: Rust, Solana CLI, Anchor CLI
anchor build
anchor test       # Run against localnet
anchor deploy     # Deploy to devnet
```

---

## Carrier Tracking

Integrated carrier tracking with automatic escrow oracle updates.

### Supported Carriers

| Carrier | API | Auth |
|---|---|---|
| FedEx | Track API v1 (REST) | OAuth2 client credentials |
| Canada Post | REST API | Basic auth |

### Tracking Routes

#### `GET /api/v1/orders/:id/tracking` — Get tracking status
Returns stored tracking events + optional live carrier data.

#### `POST /api/v1/orders/:id/tracking` — Add tracking (seller only)
```bash
curl -X POST http://localhost:3000/api/v1/orders/:id/tracking \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "trackingNumber": "794644790132",
    "carrier": "fedex"
  }'
```

### Tracking Oracle

Background service that:
1. Polls carrier APIs every 30 minutes for active shipments
2. Logs tracking events to the database
3. Calls `mark_delivered` on-chain when delivery is confirmed
4. Calls `release_escrow` when the dispute window expires

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server (hot reload) |
| `npm run build` | Compile TypeScript |
| `npm start` | Start production server |
| `npm run db:migrate` | Run Prisma migrations |
| `npm run db:seed` | Seed database with test data |
| `npm run db:studio` | Open Prisma Studio GUI |
| `anchor build` | Build Solana escrow program |
| `anchor test` | Run smart contract tests |
| `anchor deploy` | Deploy to devnet |
| `./scripts/deploy.sh` | Production deploy (build + migrate + start) |
| `./scripts/setup-env.sh` | Generate production secrets |

## Environment Variables

### Phase 1 (Core)

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://agora:agora_dev@localhost:5432/agora` |
| `PORT` | Server port | `3000` |
| `JWT_SECRET` | JWT signing secret | (required) |
| `SOLANA_CLUSTER_URL` | Solana RPC endpoint | `https://api.devnet.solana.com` |
| `WALLET_ENCRYPTION_KEY` | 32-byte hex key for wallet encryption | (required) |

### Phase 2 (Escrow & Tracking)

| Variable | Description |
|---|---|
| `SOLANA_CLUSTER` | Solana cluster (`devnet`, `mainnet-beta`) |
| `PLATFORM_AUTHORITY_KEYPAIR` | Base58 or JSON array of platform keypair |
| `FEDEX_CLIENT_ID` | FedEx API client ID |
| `FEDEX_CLIENT_SECRET` | FedEx API client secret |
| `CANADA_POST_USERNAME` | Canada Post API username |
| `CANADA_POST_PASSWORD` | Canada Post API password |
| `USDC_MINT` | USDC token mint address |
| `TRACKING_POLL_INTERVAL_MS` | Tracking poll interval (default: 1800000 / 30 min) |

### Phase 3 (eBay Integration)

| Variable | Description | Default |
|---|---|---|
| `EBAY_APP_ID` | eBay application ID (client ID) | — |
| `EBAY_CERT_ID` | eBay certificate ID (client secret) | — |
| `EBAY_DEV_ID` | eBay developer ID | — |
| `EBAY_REDIRECT_URI` | eBay OAuth redirect URI | — |
| `EBAY_SANDBOX` | Use eBay sandbox APIs | `true` |
| `EBAY_USDC_TO_USD_RATE` | USDC→USD conversion rate | `1.0` |
| `RAILWAY_PUBLIC_DOMAIN` | Railway deployment domain | — |

## Deployment

### Railway (Recommended)

1. **Create Railway project** and link your Git repo
2. **Add PostgreSQL addon** — `DATABASE_URL` is auto-set
3. **Set environment variables** (use `scripts/setup-env.sh` to generate secrets)
4. Railway auto-detects `railway.toml` and deploys

Railway config:
- Build: `npm ci && npx prisma generate && npm run build && mkdir -p dist/public && cp -r src/public/* dist/public/`
- Start: `npx prisma migrate deploy && node dist/index.js`
- Health check: `/health`

### Manual Deployment

```bash
# Generate production secrets
./scripts/setup-env.sh

# Edit .env.production with your DATABASE_URL, eBay keys, etc.
# Then deploy
./scripts/deploy.sh
```

### eBay Developer Setup

1. Create account at [developer.ebay.com](https://developer.ebay.com)
2. Create an application (get App ID, Cert ID, Dev ID)
3. Configure OAuth redirect URI
4. Start with sandbox mode (`EBAY_SANDBOX=true`)
5. Apply for production access when ready

## Web Interface

Agora serves a web interface at the root URL:
- **`/`** — Landing page with live platform stats
- **`/docs.html`** — Interactive API documentation
- **`/features.html`** — Feature request board (submit, vote, browse)

## Network

- **Chain:** Solana Devnet
- **RPC:** `https://api.devnet.solana.com`
- **USDC Mint:** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Escrow Program:** `5xdcfLVGm56Fd8twF4L1vqrqsnSj2QybNF5rbRJTbfri`

## License

MIT
