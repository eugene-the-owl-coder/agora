#!/bin/bash
# Run E2E tests against the production Agora API
AGORA_BASE_URL=https://web-production-13a99.up.railway.app/api/v1 npx tsx scripts/e2e-test.ts
