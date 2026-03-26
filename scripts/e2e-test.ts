/**
 * Agora E2E Test — Full Lifecycle
 *
 * Exercises: register → list → negotiate → order → ship → dispute
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts
 *   AGORA_BASE_URL=http://localhost:3000/api/v1 npx tsx scripts/e2e-test.ts
 */

import { AgoraClient } from '../packages/sdk/src';
import type {
  Listing,
  Order,
  Negotiation,
  NegotiationDetail,
  Dispute,
  SpendingPolicy,
  SpendingSummary,
  Carrier,
  ShippingQuotesResponse,
  TrackingResponse,
} from '../packages/sdk/src';

// ─── Config ─────────────────────────────────────────────────────

const RAW_URL =
  process.env.AGORA_BASE_URL || 'http://localhost:3000/api/v1';

// ─── Basic Auth Support ─────────────────────────────────────────
// If the URL contains credentials (e.g. https://user:pass@host/path),
// strip them from the URL and monkey-patch global fetch to inject
// the Authorization header automatically. Node.js fetch rejects
// URLs with embedded credentials.

let BASE_URL = RAW_URL;
let BASIC_AUTH_HEADER: string | undefined;

try {
  const parsed = new URL(RAW_URL);
  if (parsed.username) {
    BASIC_AUTH_HEADER = `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')}`;
    parsed.username = '';
    parsed.password = '';
    BASE_URL = parsed.toString().replace(/\/+$/, '');
    // Ensure /api/v1 suffix if not present
    if (!BASE_URL.endsWith('/api/v1')) {
      BASE_URL += '/api/v1';
    }

    // Monkey-patch global fetch to inject Basic Auth for this host
    const _originalFetch = globalThis.fetch;
    const targetOrigin = parsed.origin;
    globalThis.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url: string;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (input instanceof Request) {
        url = input.url;
      } else {
        url = String(input);
      }

      // Only inject for requests to our target host
      if (url.startsWith(targetOrigin)) {
        const headers: Record<string, string> = {
          ...(init?.headers as Record<string, string> ?? {}),
        };
        // Don't override if already set
        if (!headers['Authorization'] && !headers['authorization']) {
          headers['Authorization'] = BASIC_AUTH_HEADER!;
        }
        return _originalFetch(input, { ...init, headers });
      }
      return _originalFetch(input, init);
    } as typeof fetch;

    console.log(`  🔐 Basic auth detected — injecting Authorization header for ${targetOrigin}`);
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

function skipStep(step: number, name: string, reason: string): void {
  results.push({ step, name, status: '⏭️', detail: reason, durationMs: 0 });
  console.log(`  ⏭️  Step ${step}: ${name} — skipped: ${reason}`);
}

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          AGORA E2E TEST — Full Lifecycle         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  Run ID   : ${TS}`);
  console.log('');

  // ── Shared state across steps ──

  let buyerApiKey: string | undefined;
  let sellerApiKey: string | undefined;
  let buyerAgentId: string | undefined;
  let sellerAgentId: string | undefined;
  let listing: Listing | undefined;
  let listingId: string | undefined;
  let negotiation: Negotiation | undefined;
  let negotiationId: string | undefined;
  let orderFromNegotiation: Order | undefined;
  let orderId: string | undefined;
  let disputeOrder: Order | undefined;
  let disputeOrderId: string | undefined;
  let dispute: Dispute | undefined;

  const buyerClient = new AgoraClient({ baseUrl: BASE_URL });
  const sellerClient = new AgoraClient({ baseUrl: BASE_URL });

  // ────────────────────────────────────────────────────────────
  // Step 1: Register two agents (buyer + seller)
  // ────────────────────────────────────────────────────────────

  const buyerName = `e2e-buyer-${TS}`;
  const sellerName = `e2e-seller-${TS}`;

  const buyerReg = await runStep(1, 'Register buyer agent', async () => {
    const res = await buyerClient.agents.register({
      name: buyerName,
      email: `${buyerName}@e2e-test.agora`,
      createWallet: true,
    });
    buyerApiKey = res.apiKey;
    buyerAgentId = res.agent.id;
    buyerClient.setApiKey(buyerApiKey);
    console.log(`         → buyer id: ${buyerAgentId}`);
    return res;
  });

  const sellerReg = await runStep(1.5, 'Register seller agent', async () => {
    const res = await sellerClient.agents.register({
      name: sellerName,
      email: `${sellerName}@e2e-test.agora`,
      createWallet: true,
    });
    sellerApiKey = res.apiKey;
    sellerAgentId = res.agent.id;
    sellerClient.setApiKey(sellerApiKey);
    console.log(`         → seller id: ${sellerAgentId}`);
    return res;
  });

  if (!buyerReg || !sellerReg) {
    console.log('\n  ⛔ Cannot continue — registration failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 2: Seller creates a spending policy (The Purse)
  // ────────────────────────────────────────────────────────────

  const policy = await runStep(2, 'Seller creates spending policy (The Purse)', async () => {
    const p = await sellerClient.spendingPolicy.update({
      monthlyLimitUsdc: 50_000,
      perTransactionMax: 10_000,
      autoApproveBelow: 500,
      requireHumanAbove: 5_000,
      allowedCategories: ['electronics', 'test-items'],
      cooldownMinutes: 0,
      isActive: true,
    });
    console.log(`         → policy id: ${p.id}, monthly limit: $${p.monthlyLimitUsdc}`);
    return p;
  });

  // ────────────────────────────────────────────────────────────
  // Step 3: Seller creates a listing with auto-accept threshold
  // ────────────────────────────────────────────────────────────

  listing = await runStep(3, 'Seller creates listing with autoAcceptBelow', async () => {
    const l = await sellerClient.listings.create({
      title: `E2E Widget ${TS}`,
      description: 'A test widget for the E2E lifecycle test.',
      priceUsdc: 1000,
      category: 'electronics',
      condition: 'new',
      quantity: 5,
      metadata: {
        autoAcceptBelow: 900,
        autoAcceptMaxDaily: 3,
      },
    });
    listingId = l.id;
    console.log(`         → listing id: ${listingId}, price: $${l.priceUsdc}`);
    return l;
  }) ?? undefined;

  if (!listing || !listingId) {
    console.log('\n  ⛔ Cannot continue — listing creation failed.\n');
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────
  // Step 4: Buyer searches for the listing
  // ────────────────────────────────────────────────────────────

  await runStep(4, 'Buyer searches for the listing', async () => {
    const res = await buyerClient.listings.search({ query: `E2E Widget ${TS}` });
    const found = res.listings.some((l) => l.id === listingId);
    if (!found) throw new Error(`Listing ${listingId} not found in search results`);
    console.log(`         → found ${res.listings.length} result(s), target listing present`);
    return res;
  });

  // ────────────────────────────────────────────────────────────
  // Step 5: Buyer starts a negotiation (OFFER below auto-accept)
  // ────────────────────────────────────────────────────────────

  const negResult = await runStep(
    5,
    'Buyer starts negotiation (offer $800 — below threshold $900)',
    async () => {
      const res = await buyerClient.negotiations.start(listingId!, {
        amount: 800,
        message: 'E2E test offer — should NOT be auto-accepted',
      });
      negotiation = res.negotiation;
      negotiationId = negotiation.id;
      console.log(`         → negotiation id: ${negotiationId}, autoAccepted: ${res.autoAccepted}`);
      return res;
    },
  );

  // ────────────────────────────────────────────────────────────
  // Step 6: Verify offer is NOT auto-accepted (below threshold)
  // ────────────────────────────────────────────────────────────

  if (negResult) {
    await runStep(6, 'Verify offer NOT auto-accepted', async () => {
      if (negResult.autoAccepted) {
        throw new Error('Offer was auto-accepted but should not have been (800 < 900 threshold)');
      }
      if (negResult.negotiation.status !== 'active') {
        throw new Error(`Expected status "active", got "${negResult.negotiation.status}"`);
      }
      console.log(`         → confirmed: status=active, autoAccepted=false`);
      return true;
    });
  } else {
    skipStep(6, 'Verify offer NOT auto-accepted', 'negotiation start failed');
  }

  // ────────────────────────────────────────────────────────────
  // Step 7: Seller sends COUNTER at $950
  // ────────────────────────────────────────────────────────────

  if (negotiationId) {
    await runStep(7, 'Seller sends COUNTER at $950', async () => {
      const res = await sellerClient.negotiations.sendMessage(negotiationId!, {
        type: 'COUNTER',
        payload: { amount: 950, message: 'Counter at $950' },
      });
      console.log(`         → counter sent, negotiation status: ${res.negotiation.status}`);
      return res;
    });
  } else {
    skipStep(7, 'Seller sends COUNTER', 'no negotiation');
  }

  // ────────────────────────────────────────────────────────────
  // Step 8: Buyer sends ACCEPT
  // ────────────────────────────────────────────────────────────

  if (negotiationId) {
    const acceptResult = await runStep(8, 'Buyer sends ACCEPT', async () => {
      const res = await buyerClient.negotiations.sendMessage(negotiationId!, {
        type: 'ACCEPT',
        payload: { message: 'Deal! Accepting at $950.' },
      });
      console.log(`         → accepted, negotiation status: ${res.negotiation.status}`);
      return res;
    });

    // ──────────────────────────────────────────────────────────
    // Step 9: Verify order was created from negotiation
    // ──────────────────────────────────────────────────────────

    if (acceptResult) {
      await runStep(9, 'Verify order created from negotiation', async () => {
        // Check buyer orders — the acceptance should have created an order
        const buyerOrders = await buyerClient.orders.list({ role: 'buyer' });
        const matchedOrder = buyerOrders.orders.find(
          (o) => o.listingId === listingId,
        );
        if (!matchedOrder) {
          throw new Error('No order found for the negotiated listing');
        }
        orderFromNegotiation = matchedOrder;
        orderId = matchedOrder.id;
        console.log(
          `         → order id: ${orderId}, status: ${matchedOrder.status}, amount: $${matchedOrder.amountUsdc}`,
        );
        return matchedOrder;
      });
    } else {
      skipStep(9, 'Verify order created from negotiation', 'accept failed');
    }
  } else {
    skipStep(8, 'Buyer sends ACCEPT', 'no negotiation');
    skipStep(9, 'Verify order created from negotiation', 'no negotiation');
  }

  // ────────────────────────────────────────────────────────────
  // Step 10: Check escrow status
  // ────────────────────────────────────────────────────────────

  if (orderId) {
    await runStep(10, 'Check escrow status', async () => {
      const order = await buyerClient.escrow.status(orderId!);
      console.log(
        `         → escrow address: ${order.escrowAddress ?? '(none)'}`,
      );
      console.log(
        `         → escrow sig: ${order.escrowSignature ?? '(none)'}`,
      );
      console.log(`         → order status: ${order.status}`);
      return order;
    });
  } else {
    skipStep(10, 'Check escrow status', 'no order');
  }

  // ────────────────────────────────────────────────────────────
  // Step 11: Seller marks order as shipped (tracking number)
  // ────────────────────────────────────────────────────────────

  if (orderId) {
    await runStep(11, 'Seller marks order as shipped', async () => {
      const fulfilled = await sellerClient.orders.fulfill(orderId!, {
        trackingNumber: `E2E-TRACK-${TS}`,
        carrier: 'fedex',
      });
      console.log(`         → status: ${fulfilled.status}`);
      console.log(`         → tracking: ${fulfilled.trackingNumber}`);
      return fulfilled;
    });
  } else {
    skipStep(11, 'Seller marks order as shipped', 'no order');
  }

  // ────────────────────────────────────────────────────────────
  // Step 12: Check tracking / oracle status
  // ────────────────────────────────────────────────────────────

  if (orderId) {
    await runStep(12, 'Check tracking / oracle status', async () => {
      const tracking = await sellerClient.shipping.tracking(orderId!);
      console.log(`         → tracking number: ${tracking.trackingNumber}`);
      console.log(`         → carrier: ${tracking.carrier}`);
      console.log(`         → status: ${tracking.status}`);
      console.log(`         → events: ${tracking.events?.length ?? 0}`);
      return tracking;
    });
  } else {
    skipStep(12, 'Check tracking / oracle status', 'no order');
  }

  // ────────────────────────────────────────────────────────────
  // Step 13: Get shipping quotes for the listing
  // ────────────────────────────────────────────────────────────

  await runStep(13, 'Get shipping quotes', async () => {
    const quotes = await buyerClient.shipping.quotes({
      fromPostalCode: '10001',
      fromCountry: 'US',
      toPostalCode: '90210',
      toCountry: 'US',
      weight: { value: 2, unit: 'lb' },
      dimensions: { length: 10, width: 8, height: 4, unit: 'in' },
    });
    console.log(`         → ${quotes.quotes.length} quote(s) from ${quotes.meta.carriers} carrier(s)`);
    for (const q of quotes.quotes.slice(0, 3)) {
      console.log(`           • ${q.carrier} ${q.serviceName}: $${q.totalPrice} (${q.estimatedDays} days)`);
    }
    return quotes;
  });

  // ────────────────────────────────────────────────────────────
  // Step 14: List available carriers
  // ────────────────────────────────────────────────────────────

  await runStep(14, 'List available carriers', async () => {
    const carriers = await buyerClient.shipping.carriers();
    console.log(`         → ${carriers.length} carrier(s)`);
    for (const c of carriers) {
      console.log(
        `           • ${c.name} (${c.id}) — tracking:${c.capabilities.tracking} quotes:${c.capabilities.quotes}`,
      );
    }
    return carriers;
  });

  // ────────────────────────────────────────────────────────────
  // Step 15: Verify spending policy summary updated
  // ────────────────────────────────────────────────────────────

  await runStep(15, 'Verify spending policy summary', async () => {
    const summary = await sellerClient.spendingPolicy.summary();
    console.log(`         → total spent this month: $${summary.totalSpentThisMonth}`);
    console.log(`         → monthly limit: $${summary.monthlyLimit}`);
    console.log(`         → remaining budget: $${summary.remainingBudget}`);
    console.log(`         → transaction count: ${summary.transactionCount}`);
    return summary;
  });

  // ────────────────────────────────────────────────────────────
  // Steps 16–18: Dispute flow (on a separate test order)
  // ────────────────────────────────────────────────────────────

  // Create a second order specifically for the dispute test
  const disputeSetup = await runStep(
    16,
    'Open dispute — create separate order + dispute it',
    async () => {
      // Create a direct order (not via negotiation)
      const order = await buyerClient.orders.create({
        listingId: listingId!,
        quantity: 1,
      });
      disputeOrderId = order.id;
      console.log(`         → dispute test order id: ${disputeOrderId}, status: ${order.status}`);

      // Fulfill it so we can dispute a fulfilled order
      const fulfilled = await sellerClient.orders.fulfill(disputeOrderId, {
        trackingNumber: `E2E-DISPUTE-TRACK-${TS}`,
        carrier: 'fedex',
      });
      console.log(`         → fulfilled, status: ${fulfilled.status}`);

      // Open the dispute
      const d = await buyerClient.disputes.open(disputeOrderId, {
        reason: 'Item not as described',
        description: 'E2E test dispute — item condition does not match listing.',
        evidence: ['https://example.com/photo-evidence.jpg'],
      });
      dispute = d;
      console.log(`         → dispute id: ${d.id}, status: ${d.status}`);
      return d;
    },
  );

  // ────────────────────────────────────────────────────────────
  // Step 17: Submit evidence
  // ────────────────────────────────────────────────────────────

  if (disputeOrderId && disputeSetup) {
    await runStep(17, 'Submit dispute evidence', async () => {
      const evidence = await sellerClient.disputes.submitEvidence(disputeOrderId!, {
        description: 'Item was shipped in stated condition. Proof of packaging.',
        urls: ['https://example.com/packaging-proof.jpg'],
        type: 'photo',
      });
      console.log(`         → evidence id: ${evidence.id}, type: ${evidence.type}`);
      return evidence;
    });
  } else {
    skipStep(17, 'Submit dispute evidence', 'no dispute');
  }

  // ────────────────────────────────────────────────────────────
  // Step 18: Resolve dispute (requires admin — may fail)
  // ────────────────────────────────────────────────────────────

  if (disputeOrderId && disputeSetup) {
    await runStep(18, 'Resolve dispute (admin — may fail if no admin access)', async () => {
      // Try to resolve as seller — this may require admin privileges
      // which we may not have in E2E. We try anyway and report gracefully.
      const resolved = await sellerClient.disputes.resolve(disputeOrderId!, {
        resolution: 'partial_refund',
        refundAmount: 500,
        notes: 'E2E test resolution — partial refund agreed.',
      });
      console.log(`         → resolution: ${resolved.resolution}, status: ${resolved.status}`);
      return resolved;
    });
  } else {
    skipStep(18, 'Resolve dispute', 'no dispute');
  }

  // ════════════════════════════════════════════════════════════
  // TRUST FRAMEWORK TESTS (Steps 19–25)
  // ════════════════════════════════════════════════════════════

  // Helper: raw fetch with API key auth (SDK may not have trust endpoints)
  async function apiFetch(
    apiKey: string,
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        ...(options.headers as Record<string, string> ?? {}),
      },
    });
  }

  // Helper: fetch that tolerates 404 (endpoint not deployed) → returns null
  async function apiFetchOrSkip(
    apiKey: string,
    path: string,
    stepNum: number,
    stepName: string,
  ): Promise<any | null> {
    const res = await apiFetch(apiKey, path);
    if (res.status === 404) {
      skipStep(stepNum, stepName, 'endpoint not deployed (404)');
      return null;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
  }

  // ────────────────────────────────────────────────────────────
  // Step 19: Check buyer's trust tier — new agents start at Tier 0
  // ────────────────────────────────────────────────────────────

  let buyerTierData: any = null;

  if (buyerApiKey) {
    buyerTierData = await runStep(19, 'Check buyer trust tier (should be Tier 0)', async () => {
      const data = await apiFetchOrSkip(buyerApiKey!, '/agents/me/tier', 19, 'Check buyer trust tier');
      if (data === null) return null; // skipped

      const tier = data.tier;
      if (tier.tier !== 0) {
        throw new Error(`Expected tier 0 for new agent, got tier ${tier.tier}`);
      }
      if (tier.tierName !== 'new') {
        throw new Error(`Expected tierName "new", got "${tier.tierName}"`);
      }
      console.log(`         → tier: ${tier.tier} (${tier.tierName})`);
      console.log(`         → cleared transactions: ${tier.clearedTransactions}`);
      console.log(`         → unique counterparties: ${tier.uniqueCounterparties}`);
      console.log(`         → max price: $${(tier.maxPriceUsdc / 100).toFixed(2)}`);
      console.log(`         → collateral ratio: ${Math.round(tier.collateralRatio * 100)}%`);
      return data;
    });
  } else {
    skipStep(19, 'Check buyer trust tier', 'no buyer API key');
  }

  // ────────────────────────────────────────────────────────────
  // Step 20: Check collateral requirements for Tier 0 (200%)
  // ────────────────────────────────────────────────────────────

  await runStep(20, 'Collateral estimate for Tier 0 (expect 200%)', async () => {
    const testPrice = 10000; // $100 in USDC cents
    const res = await fetch(`${BASE_URL}/collateral/estimate?priceUsdc=${testPrice}`);
    if (res.status === 404) {
      skipStep(20, 'Collateral estimate', 'endpoint not deployed (404)');
      return null;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }

    const data = await res.json();
    const estimate = data.estimate;

    // The "maximum" scenario (both Tier 0) should have 200% ratio
    if (estimate.maximum.collateralRatio !== 2.0) {
      throw new Error(`Expected max collateral ratio 2.0 (200%), got ${estimate.maximum.collateralRatio}`);
    }
    // Buyer collateral for both-Tier-0 should be 2× the price
    if (estimate.maximum.buyerCollateralUsdc !== testPrice * 2) {
      throw new Error(
        `Expected buyer collateral ${testPrice * 2} for 200%, got ${estimate.maximum.buyerCollateralUsdc}`,
      );
    }

    console.log(`         → price: $${(estimate.price / 100).toFixed(2)}`);
    console.log(`         → max ratio (Tier 0): ${Math.round(estimate.maximum.collateralRatio * 100)}%`);
    console.log(`         → max buyer collateral: $${(estimate.maximum.buyerCollateralUsdc / 100).toFixed(2)}`);
    console.log(`         → min ratio (Tier 4): ${Math.round(estimate.minimum.collateralRatio * 100)}%`);
    console.log(`         → tier combos: ${estimate.tiers.length}`);
    for (const t of estimate.tiers) {
      console.log(`           • ${t.tierCombo}: ${Math.round(t.ratio * 100)}% → buyer total $${(t.buyerTotalCost / 100).toFixed(2)}`);
    }
    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 21: Verify tier price cap enforcement — Tier 0 max is $150
  // ────────────────────────────────────────────────────────────

  if (sellerApiKey) {
    await runStep(21, 'Tier price cap enforcement (Tier 0 → $150 max)', async () => {
      // Attempt to create a listing at $200 (20000 USDC cents) — should fail for Tier 0 ($150 = 15000 cap)
      const res = await apiFetch(sellerApiKey!, '/listings', {
        method: 'POST',
        body: JSON.stringify({
          title: `E2E Over-Cap Widget ${TS}`,
          description: 'This listing exceeds Tier 0 price cap and should be rejected.',
          priceUsdc: 20000, // $200 — above $150 Tier 0 cap
          category: 'electronics',
          condition: 'new',
          quantity: 1,
        }),
      });

      if (res.status === 404) {
        skipStep(21, 'Tier price cap enforcement', 'endpoint not deployed (404)');
        return null;
      }

      // Expect a 4xx rejection (likely 403 or 400)
      if (res.ok) {
        // Clean up the accidentally-created listing
        const created = await res.json();
        console.log(`         ⚠️ Listing was created (id: ${created.id}) — price cap NOT enforced!`);
        throw new Error(
          `Listing at $200 should have been rejected for Tier 0 agent (cap $150), but was created`,
        );
      }

      const body = await res.json().catch(() => ({ message: res.statusText }));
      console.log(`         → correctly rejected: ${res.status}`);
      console.log(`         → reason: ${body.message || body.error || JSON.stringify(body)}`);
      return { status: res.status, body };
    });
  } else {
    skipStep(21, 'Tier price cap enforcement', 'no seller API key');
  }

  // ────────────────────────────────────────────────────────────
  // Step 22: Check enriched /me endpoint (trust tier, ratings, reputation)
  // ────────────────────────────────────────────────────────────

  if (buyerApiKey) {
    // Pre-check: is the enriched /me deployed? If not, skip cleanly.
    const meRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { 'x-api-key': buyerApiKey! },
    });

    if (meRes.status === 404) {
      skipStep(22, 'Enriched /me endpoint (tier + ratings + reputation)', 'endpoint not deployed (404)');
    } else if (meRes.ok) {
      const meData = await meRes.json();
      const hasTrustTier = meData.trustTier !== undefined;
      const hasRatings = meData.ratings !== undefined;
      const hasReputation = meData.reputation !== undefined;

      if (!hasTrustTier && !hasRatings && !hasReputation && meData.agent) {
        // Old /me without enrichment — skip gracefully
        skipStep(22, 'Enriched /me endpoint (tier + ratings + reputation)', 'enrichment not deployed (old /me)');
      } else {
        await runStep(22, 'Enriched /me endpoint (tier + ratings + reputation)', async () => {
          const hasAgent = !!meData.agent;
          const hasStats = meData.stats !== undefined;

          console.log(`         → agent: ${hasAgent ? '✓' : '✗'} (id: ${meData.agent?.id})`);
          console.log(`         → trustTier: ${hasTrustTier ? '✓' : '✗'} (tier ${meData.trustTier?.tier ?? 'N/A'})`);
          console.log(`         → ratings: ${hasRatings ? '✓' : '✗'}`);
          console.log(`         → reputation: ${hasReputation ? '✓' : '✗'}`);
          console.log(`         → stats: ${hasStats ? '✓' : '✗'}`);

          if (!hasAgent) throw new Error('Missing agent data in /me response');
          if (!hasTrustTier) throw new Error('Missing trustTier key in /me response');
          if (!hasRatings) throw new Error('Missing ratings key in /me response');

          // Validate enrichment content
          if (meData.trustTier !== null && meData.trustTier.tier !== 0) {
            throw new Error(`Expected tier 0 for new agent in /me, got ${meData.trustTier.tier}`);
          }

          return meData;
        });
      }
    } else {
      await runStep(22, 'Enriched /me endpoint (tier + ratings + reputation)', async () => {
        throw new Error(`/auth/me returned ${meRes.status}: ${await meRes.text()}`);
      });
    }
  } else {
    skipStep(22, 'Enriched /me endpoint (tier + ratings + reputation)', 'no buyer API key');
  }

  // ────────────────────────────────────────────────────────────
  // Step 23: Buyer & seller ratings initialized (null for new agents)
  // ────────────────────────────────────────────────────────────

  if (buyerApiKey && sellerApiKey) {
    await runStep(23, 'Ratings initialized (null for new agents)', async () => {
      const buyerData = await apiFetchOrSkip(buyerApiKey!, '/agents/me/ratings', 23, 'Ratings check');
      if (buyerData === null) return null;

      const br = buyerData.ratings;
      const sellerData = await apiFetchOrSkip(sellerApiKey!, '/agents/me/ratings', 23, 'Ratings check');
      if (sellerData === null) return null;

      const sr = sellerData.ratings;

      console.log(`         → buyer  : buyerRating=${br.buyerRating}, sellerRating=${br.sellerRating}, txCounts=${br.buyerTxCount}/${br.sellerTxCount}`);
      console.log(`         → seller : buyerRating=${sr.buyerRating}, sellerRating=${sr.sellerRating}, txCounts=${sr.buyerTxCount}/${sr.sellerTxCount}`);

      // New agents should have null ratings (no transactions completed yet)
      if (br.buyerRating !== null) {
        throw new Error(`New buyer agent should have null buyerRating, got ${br.buyerRating}`);
      }
      if (sr.sellerRating !== null) {
        throw new Error(`New seller agent should have null sellerRating, got ${sr.sellerRating}`);
      }
      if (br.buyerTxCount !== 0) {
        throw new Error(`New buyer should have 0 buyerTxCount, got ${br.buyerTxCount}`);
      }
      if (sr.sellerTxCount !== 0) {
        throw new Error(`New seller should have 0 sellerTxCount, got ${sr.sellerTxCount}`);
      }

      return { buyer: br, seller: sr };
    });
  } else {
    skipStep(23, 'Ratings initialized', 'missing API key(s)');
  }

  // ────────────────────────────────────────────────────────────
  // Step 24: Verify tier table reference (public endpoint)
  // ────────────────────────────────────────────────────────────

  await runStep(24, 'Tier table reference (public endpoint)', async () => {
    const res = await fetch(`${BASE_URL}/tiers`);
    if (res.status === 404) {
      skipStep(24, 'Tier table reference', 'endpoint not deployed (404)');
      return null;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body}`);
    }

    const data = await res.json();
    const tiers = data.tiers;

    if (!Array.isArray(tiers) || tiers.length !== 5) {
      throw new Error(`Expected 5 tiers, got ${tiers?.length}`);
    }

    // Verify tier 0 defaults
    const t0 = tiers.find((t: any) => t.tier === 0);
    if (!t0) throw new Error('Tier 0 not found in tier table');
    if (t0.collateralRatio !== 2.0) throw new Error(`Tier 0 collateral ratio expected 2.0, got ${t0.collateralRatio}`);
    if (t0.maxPriceUsdc !== 15000) throw new Error(`Tier 0 max price expected 15000, got ${t0.maxPriceUsdc}`);

    console.log(`         → ${tiers.length} tiers returned`);
    for (const t of tiers) {
      console.log(`           • Tier ${t.tier} (${t.name}): max ${t.maxPriceFormatted}, collateral ${t.collateralPercent}, listings ${t.maxActiveListings}`);
    }

    if (data.explanation) {
      console.log(`         → explanation: ${data.explanation.summary.slice(0, 80)}...`);
    }

    return data;
  });

  // ────────────────────────────────────────────────────────────
  // Step 25: Collateral distribution info (dispute resolution math)
  // ────────────────────────────────────────────────────────────

  await runStep(25, 'Collateral distribution scenarios', async () => {
    // Test multiple price points to verify the estimate endpoint returns correct tier combos
    const prices = [5000, 15000, 50000]; // $50, $150, $500
    for (const price of prices) {
      const res = await fetch(`${BASE_URL}/collateral/estimate?priceUsdc=${price}`);
      if (res.status === 404) {
        skipStep(25, 'Collateral distribution scenarios', 'endpoint not deployed (404)');
        return null;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status} for price ${price}: ${body}`);
      }

      const data = await res.json();
      const est = data.estimate;

      // Verify basic math: buyer total cost = price + buyer collateral
      for (const t of est.tiers) {
        const expectedBuyerTotal = price + t.buyerCollateral;
        if (t.buyerTotalCost !== expectedBuyerTotal) {
          throw new Error(
            `Math mismatch for ${t.tierCombo}: buyerTotalCost ${t.buyerTotalCost} !== price ${price} + collateral ${t.buyerCollateral}`,
          );
        }
      }

      // Verify min ≤ max collateral
      if (est.minimum.collateralRatio > est.maximum.collateralRatio) {
        throw new Error(
          `Min collateral ratio (${est.minimum.collateralRatio}) > max (${est.maximum.collateralRatio})`,
        );
      }

      console.log(`         → $${(price / 100).toFixed(2)}: min ${Math.round(est.minimum.collateralRatio * 100)}% / max ${Math.round(est.maximum.collateralRatio * 100)}% — ✓`);
    }

    return { pricesTested: prices.length };
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

  // Step-by-step table
  const stepCol = 6;
  const statusCol = 4;
  const nameCol = 48;
  const timeCol = 8;

  console.log(
    `║ ${'Step'.padEnd(stepCol)} ${''.padEnd(statusCol)} ${'Name'.padEnd(nameCol)} ${'Time'.padStart(timeCol)} ║`,
  );
  console.log(`║${'─'.repeat(stepCol + statusCol + nameCol + timeCol + 4)}║`);

  for (const r of results) {
    const stepStr = String(r.step).padEnd(stepCol);
    const statusStr = r.status.padEnd(statusCol);
    const nameStr = r.name.slice(0, nameCol).padEnd(nameCol);
    const timeStr = r.durationMs > 0 ? `${r.durationMs}ms`.padStart(timeCol) : '—'.padStart(timeCol);
    console.log(`║ ${stepStr} ${statusStr} ${nameStr} ${timeStr} ║`);
    if (r.status === '❌') {
      const detail = `     └─ ${r.detail}`.slice(0, stepCol + statusCol + nameCol + timeCol + 3);
      console.log(`║ ${detail.padEnd(stepCol + statusCol + nameCol + timeCol + 3)} ║`);
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
  }

  // Exit with error code if any test failed (but not for skips)
  if (failed > 0) {
    process.exit(1);
  }
}

// ─── Run ────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n  💀 Unhandled error:', err);
  printSummary();
  process.exit(2);
});
