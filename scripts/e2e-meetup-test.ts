/**
 * Agora E2E Test — Local Meetup Flow (MVP Validation)
 *
 * Proves the MVP works with ZERO insider knowledge:
 * Every value the agent needs comes from the API itself.
 *
 * Usage:
 *   npx tsx scripts/e2e-meetup-test.ts
 *   AGORA_BASE_URL=https://web-production-13a99.up.railway.app npx tsx scripts/e2e-meetup-test.ts
 */

// ─── Config ─────────────────────────────────────────────────────

const RAW_URL =
  process.env.AGORA_BASE_URL || 'http://localhost:3000';

// ─── Basic Auth Support ─────────────────────────────────────────

let ROOT_URL = RAW_URL;
let BASIC_AUTH_HEADER: string | undefined;

try {
  const parsed = new URL(RAW_URL);
  if (parsed.username) {
    BASIC_AUTH_HEADER = `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`;
    parsed.username = '';
    parsed.password = '';
    ROOT_URL = parsed.toString().replace(/\/+$/, '');

    const _originalFetch = globalThis.fetch;
    const targetOrigin = parsed.origin;
    globalThis.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url: string;
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.toString();
      else if (input instanceof Request) url = input.url;
      else url = String(input);

      if (url.startsWith(targetOrigin)) {
        const headers: Record<string, string> = {
          ...(init?.headers as Record<string, string> ?? {}),
        };
        if (!headers['Authorization'] && !headers['authorization']) {
          headers['Authorization'] = BASIC_AUTH_HEADER!;
        }
        return _originalFetch(input, { ...init, headers });
      }
      return _originalFetch(input, init);
    } as typeof fetch;

    console.log(`  🔐 Basic auth detected — injecting header for ${targetOrigin}`);
  }
} catch {
  // Not a valid URL with credentials — use as-is
}

const TS = Date.now();

// ─── Test Harness ───────────────────────────────────────────────

interface TestResult {
  step: number;
  name: string;
  status: '✅' | '❌' | '⏭️';
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runStep<T>(
  step: number,
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    results.push({ step, name, status: '✅', detail: 'passed', durationMs: ms });
    console.log(`  ✅ Step ${step}: ${name} (${ms}ms)`);
    return result;
  } catch (err: any) {
    const ms = Date.now() - start;
    const detail = err?.message || String(err);
    results.push({ step, name, status: '❌', detail, durationMs: ms });
    console.log(`  ❌ Step ${step}: ${name} — ${detail} (${ms}ms)`);
    return null;
  }
}

// ─── HTTP Helper ────────────────────────────────────────────────

async function api(
  method: string,
  url: string,
  opts: { apiKey?: string; body?: unknown } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.apiKey) {
    headers['X-API-Key'] = opts.apiKey;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${json.error?.message || json.message || text}`);
  }
  return json;
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      AGORA E2E — Local Meetup MVP Validation     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Root URL : ${ROOT_URL}`);
  console.log(`  Run ID   : ${TS}`);
  console.log('');

  // ── Shared state ──
  let apiBase: string | undefined;
  let categories: string[] | undefined;
  let buyerApiKey: string | undefined;
  let sellerApiKey: string | undefined;
  let buyerAgentId: string | undefined;
  let sellerAgentId: string | undefined;
  let listingId: string | undefined;
  let orderId: string | undefined;
  let meetupCode: string | undefined;

  // ────────────────────────────────────────────────────────────
  // Step 1: GET /health → discover API entry point
  // ────────────────────────────────────────────────────────────

  const health = await runStep(1, 'GET /health → discover links.api', async () => {
    const data = await api('GET', `${ROOT_URL}/health`);
    if (!data.links?.api) {
      throw new Error('Missing links.api in health response');
    }
    if (!data.hint) {
      throw new Error('Missing hint in health response');
    }
    console.log(`         → status: ${data.status}`);
    console.log(`         → links.api: ${data.links.api}`);
    console.log(`         → hint: ${data.hint}`);

    // Derive absolute API base from relative path
    apiBase = `${ROOT_URL}${data.links.api.replace(/\/info$/, '')}`;
    console.log(`         → resolved API base: ${apiBase}`);
    return data;
  });

  if (!health || !apiBase) {
    console.log('\n  ⛔ Cannot continue — health check failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 2: GET /api/v1/info → read discovery payload
  // ────────────────────────────────────────────────────────────

  const info = await runStep(2, 'GET /api/v1/info → read categories, fulfillment, auth, endpoints', async () => {
    const data = await api('GET', `${apiBase}/info`);

    // Validate critical discovery fields
    if (!data.categories || !Array.isArray(data.categories)) {
      throw new Error('Missing categories array in info response');
    }
    if (!data.conditions || !Array.isArray(data.conditions)) {
      throw new Error('Missing conditions array');
    }
    if (!data.fulfillmentTypes?.local_meetup) {
      throw new Error('Missing fulfillmentTypes.local_meetup');
    }
    if (!data.currency?.unit) {
      throw new Error('Missing currency.unit');
    }
    if (!data.authentication?.register) {
      throw new Error('Missing authentication.register');
    }
    if (!data.authentication?.header) {
      throw new Error('Missing authentication.header');
    }
    if (!data.orderLifecycle?.local_meetup) {
      throw new Error('Missing orderLifecycle.local_meetup');
    }
    if (!data.endpoints?.register) {
      throw new Error('Missing endpoints.register');
    }
    if (!data.endpoints?.handoff) {
      throw new Error('Missing endpoints.handoff');
    }
    if (!data.endpoints?.confirmOrder) {
      throw new Error('Missing endpoints.confirmOrder');
    }

    categories = data.categories;
    console.log(`         → categories: ${data.categories.join(', ')}`);
    console.log(`         → conditions: ${data.conditions.join(', ')}`);
    console.log(`         → fulfillment types: ${Object.keys(data.fulfillmentTypes).join(', ')}`);
    console.log(`         → currency: ${data.currency.unit} (${data.currency.example})`);
    console.log(`         → auth header: ${data.authentication.header}`);
    console.log(`         → endpoints count: ${Object.keys(data.endpoints).length}`);
    return data;
  });

  if (!info) {
    console.log('\n  ⛔ Cannot continue — info discovery failed.\n');
    printSummary();
    process.exit(1);
  }

  // Extract register path from discovery
  const registerPath = info.endpoints.register.path;

  // ────────────────────────────────────────────────────────────
  // Step 3: Register buyer + seller
  // ────────────────────────────────────────────────────────────

  const buyerReg = await runStep(3, 'Register buyer agent', async () => {
    const data = await api('POST', `${ROOT_URL}${registerPath}`, {
      body: {
        name: `meetup-buyer-${TS}`,
        email: `meetup-buyer-${TS}@e2e-test.agora`,
        createWallet: true,
      },
    });
    buyerApiKey = data.apiKey;
    buyerAgentId = data.agent.id;
    console.log(`         → buyer id: ${buyerAgentId}`);
    console.log(`         → API key prefix: ${buyerApiKey!.substring(0, 12)}...`);
    return data;
  });

  const sellerReg = await runStep(4, 'Register seller agent', async () => {
    const data = await api('POST', `${ROOT_URL}${registerPath}`, {
      body: {
        name: `meetup-seller-${TS}`,
        email: `meetup-seller-${TS}@e2e-test.agora`,
        createWallet: true,
      },
    });
    sellerApiKey = data.apiKey;
    sellerAgentId = data.agent.id;
    console.log(`         → seller id: ${sellerAgentId}`);
    console.log(`         → API key prefix: ${sellerApiKey!.substring(0, 12)}...`);
    return data;
  });

  if (!buyerReg || !sellerReg) {
    console.log('\n  ⛔ Cannot continue — registration failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 5: Seller creates listing using discovered category
  // ────────────────────────────────────────────────────────────

  const createListingEndpoint = info.endpoints.createListing;
  const category = categories![0]; // Use first discovered category

  const listing = await runStep(5, `Seller creates listing (category: ${category})`, async () => {
    const data = await api('POST', `${ROOT_URL}${createListingEndpoint.path}`, {
      apiKey: sellerApiKey,
      body: {
        title: `Meetup Test Item ${TS}`,
        description: 'A test item for the local meetup E2E flow.',
        priceUsdc: 1500,
        category,
        condition: info.conditions[0],
        quantity: 1,
      },
    });
    listingId = data.id;
    console.log(`         → listing id: ${listingId}`);
    console.log(`         → price: ${data.priceUsdc} ${info.currency.unit}`);
    return data;
  });

  if (!listing || !listingId) {
    console.log('\n  ⛔ Cannot continue — listing creation failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 6: Buyer searches for listing by category
  // ────────────────────────────────────────────────────────────

  await runStep(6, `Buyer searches listings by category=${category}`, async () => {
    const listEndpoint = info.endpoints.listListings;
    const data = await api('GET', `${ROOT_URL}${listEndpoint.path}?category=${category}`);
    const listings = data.data || data.listings || data;
    const found = Array.isArray(listings) && listings.some((l: any) => l.id === listingId);
    if (!found) {
      throw new Error(`Listing ${listingId} not found in category search results`);
    }
    console.log(`         → found listing in search results`);
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 7: Buyer places local meetup order
  // ────────────────────────────────────────────────────────────

  const buyerOrder = await runStep(7, 'Buyer places local meetup order', async () => {
    const data = await api('POST', `${ROOT_URL}${info.endpoints.createOrder.path}`, {
      apiKey: buyerApiKey,
      body: {
        listingId,
        fulfillmentType: 'local_meetup',
        meetupArea: 'Downtown SF - Union Square',
        meetupTime: new Date(Date.now() + 86400000).toISOString(),
      },
    });

    orderId = data.id;
    meetupCode = data.meetupCode;

    console.log(`         → order id: ${orderId}`);
    console.log(`         → status: ${data.status}`);
    console.log(`         → fulfillmentType: ${data.fulfillmentType}`);
    console.log(`         → meetupArea: ${data.meetupArea}`);
    console.log(`         → meetupStatus: ${data.meetupStatus}`);
    console.log(`         → meetupCode: ${meetupCode ? '✓ present' : '✗ MISSING'}`);

    if (!meetupCode) {
      throw new Error('Buyer order response is missing meetupCode');
    }
    return data;
  });

  if (!buyerOrder || !orderId || !meetupCode) {
    console.log('\n  ⛔ Cannot continue — order creation failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 8: Verify seller does NOT see meetupCode
  // ────────────────────────────────────────────────────────────

  await runStep(8, 'Verify seller order view does NOT have meetupCode', async () => {
    const data = await api('GET', `${ROOT_URL}${info.endpoints.getOrder.path.replace(':id', orderId!)}`, {
      apiKey: sellerApiKey,
    });
    if (data.meetupCode !== undefined && data.meetupCode !== null) {
      throw new Error(`Seller can see meetupCode "${data.meetupCode}" — security violation!`);
    }
    console.log(`         → seller sees meetupCode: ${data.meetupCode ?? 'undefined'} ✓`);
    console.log(`         → seller sees meetupArea: ${data.meetupArea}`);
    console.log(`         → seller sees meetupStatus: ${data.meetupStatus}`);
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 9: Seller calls handoff with meetupCode
  // ────────────────────────────────────────────────────────────

  await runStep(9, 'Seller calls /handoff with meetupCode', async () => {
    const handoffPath = info.endpoints.handoff.path.replace(':id', orderId!);
    const data = await api('POST', `${ROOT_URL}${handoffPath}`, {
      apiKey: sellerApiKey,
      body: { meetupCode },
    });
    console.log(`         → status: ${data.status}`);
    console.log(`         → meetupStatus: ${data.meetupStatus}`);
    if (data.meetupStatus !== 'seller_handed_over') {
      throw new Error(`Expected meetupStatus "seller_handed_over", got "${data.meetupStatus}"`);
    }
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 10: Buyer confirms receipt
  // ────────────────────────────────────────────────────────────

  await runStep(10, 'Buyer calls /confirm → order completes', async () => {
    const confirmPath = info.endpoints.confirmOrder.path.replace(':id', orderId!);
    const data = await api('POST', `${ROOT_URL}${confirmPath}`, {
      apiKey: buyerApiKey,
    });
    console.log(`         → status: ${data.status}`);
    console.log(`         → meetupStatus: ${data.meetupStatus}`);
    if (data.status !== 'completed') {
      throw new Error(`Expected status "completed", got "${data.status}"`);
    }
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 11: Final verification — order is completed
  // ────────────────────────────────────────────────────────────

  await runStep(11, 'Final verification: GET /orders/:id → status completed', async () => {
    const data = await api('GET', `${ROOT_URL}${info.endpoints.getOrder.path.replace(':id', orderId!)}`, {
      apiKey: buyerApiKey,
    });
    if (data.status !== 'completed') {
      throw new Error(`Final order status is "${data.status}", expected "completed"`);
    }
    console.log(`         → status: ${data.status} ✓`);
    console.log(`         → meetupStatus: ${data.meetupStatus}`);
    console.log(`         → fulfillmentType: ${data.fulfillmentType}`);
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────

  printSummary();
}

function printSummary(): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║                  TEST SUMMARY                   ║');
  console.log('╠══════════════════════════════════════════════════╣');

  const passed = results.filter((r) => r.status === '✅').length;
  const failed = results.filter((r) => r.status === '❌').length;
  const skipped = results.filter((r) => r.status === '⏭️').length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const r of results) {
    const stepStr = String(r.step).padEnd(4);
    const nameStr = r.name.slice(0, 55).padEnd(55);
    const timeStr = r.durationMs > 0 ? `${r.durationMs}ms` : '—';
    console.log(`║  ${r.status} ${stepStr} ${nameStr} ${timeStr.padStart(7)} ║`);
    if (r.status === '❌') {
      const detail = `       └─ ${r.detail}`.slice(0, 68);
      console.log(`║  ${detail.padEnd(68)} ║`);
    }
  }

  console.log('╠══════════════════════════════════════════════════╣');
  console.log(
    `║  ✅ ${String(passed).padEnd(3)} passed   ❌ ${String(failed).padEnd(3)} failed   ⏭️  ${String(skipped).padEnd(3)} skipped     ║`,
  );
  console.log(
    `║  Total time: ${`${totalMs}ms`.padEnd(37)}║`,
  );
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  if (failed > 0) {
    console.log('Failed steps:');
    for (const r of results.filter((r) => r.status === '❌')) {
      console.log(`  ${r.step}. ${r.name}`);
      console.log(`     ${r.detail}`);
    }
    console.log('');
    process.exit(1);
  }
}

// ─── Run ────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n  💀 Unhandled error:', err);
  printSummary();
  process.exit(2);
});
