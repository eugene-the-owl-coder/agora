#!/bin/bash
# Run E2E tests against the production Agora API
AGORA_BASE_URL=https://agora-cnk1.onrender.com/api/v1 npx tsx scripts/e2e-test.ts
