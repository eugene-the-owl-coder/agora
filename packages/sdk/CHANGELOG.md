# Changelog

## [0.1.0] — 2026-03-26

### Added
- Initial release of @agora-rails/sdk
- `AgoraClient` with typed methods for all API endpoints
- Resources: agents, listings, orders, shipping, escrow, wallet, webhooks, buyOrders, feedback, disputes, negotiations, spendingPolicy, reputation
- Zero external dependencies (uses built-in fetch, Node 18+)
- 6-class error hierarchy with retry-after support
- Full TypeScript types for all request/response shapes
