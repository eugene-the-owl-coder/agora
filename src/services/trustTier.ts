/**
 * Trust Tier Service — Progressive Access System
 *
 * Agents earn higher tiers through completed transactions with counterparty diversity.
 * Higher tiers unlock higher price caps, more listings, and lower collateral ratios.
 *
 * Tier Table:
 * | Tier | Name     | Cleared Tx | Max Price (USDC) | Max Listings | Collateral |
 * |------|----------|-----------|------------------|-------------|------------|
 * | 0    | new      | 0         | $25 (2500)       | 3           | 200%       |
 * | 1    | bronze   | 5         | $100 (10000)     | 10          | 150%       |
 * | 2    | silver   | 20        | $500 (50000)     | 25          | 100%       |
 * | 3    | gold     | 50        | $2,000 (200000)  | 50          | 100%       |
 * | 4    | platinum | 100 + ≥4.5★ | $10,000 (1000000)| unlimited  | 100%       |
 *
 * A "cleared transaction" requires:
 * - Order status = completed
 * - DIFFERENT counterparty (counterparty diversity)
 */

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────────────

export type TierName = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface TierInfo {
  tier: number;              // 0-4
  tierName: TierName;
  clearedTransactions: number;
  uniqueCounterparties: number;
  rating: number | null;
  maxPriceUsdc: number;      // USDC cents (e.g. 2500 = $25)
  maxActiveListings: number;
  collateralRatio: number;   // 2.0 = 200%, 1.0 = 100%
  nextTier: {
    transactionsNeeded: number;
    ratingNeeded: number | null;
  } | null;                  // null if at max tier
}

export interface PriceValidation {
  allowed: boolean;
  reason?: string;
}

export interface ListingValidation {
  allowed: boolean;
  current: number;
  max: number;
}

export interface OrderPriceValidation {
  allowed: boolean;
  reason?: string;
}

// ── Tier Configuration ─────────────────────────────────────────────────────

interface TierConfig {
  tier: number;
  name: TierName;
  requiredCleared: number;
  requiredRating: number | null;
  maxPriceUsdc: number;
  maxActiveListings: number;
  collateralRatio: number;
}

const TIER_TABLE: TierConfig[] = [
  { tier: 0, name: 'new',      requiredCleared: 0,   requiredRating: null, maxPriceUsdc: 2500,    maxActiveListings: 3,    collateralRatio: 2.0 },
  { tier: 1, name: 'bronze',   requiredCleared: 5,   requiredRating: null, maxPriceUsdc: 10000,   maxActiveListings: 10,   collateralRatio: 1.5 },
  { tier: 2, name: 'silver',   requiredCleared: 20,  requiredRating: null, maxPriceUsdc: 50000,   maxActiveListings: 25,   collateralRatio: 1.0 },
  { tier: 3, name: 'gold',     requiredCleared: 50,  requiredRating: null, maxPriceUsdc: 200000,  maxActiveListings: 50,   collateralRatio: 1.0 },
  { tier: 4, name: 'platinum', requiredCleared: 100,  requiredRating: 4.5,  maxPriceUsdc: 1000000, maxActiveListings: 9999, collateralRatio: 1.0 },
];

// ── Core: Compute Tier ─────────────────────────────────────────────────────

/**
 * Count unique counterparties across completed orders for an agent.
 * An agent can be buyer OR seller — we count the distinct OTHER party.
 */
async function countUniqueCounterparties(agentId: string): Promise<{
  uniqueCounterparties: number;
  clearedTransactions: number;
}> {
  // Get all completed orders where this agent is buyer or seller
  const completedOrders = await prisma.order.findMany({
    where: {
      status: 'completed',
      OR: [
        { buyerAgentId: agentId },
        { sellerAgentId: agentId },
      ],
    },
    select: {
      buyerAgentId: true,
      sellerAgentId: true,
    },
  });

  // Collect unique counterparty IDs
  const counterpartyIds = new Set<string>();
  for (const order of completedOrders) {
    if (order.buyerAgentId === agentId) {
      counterpartyIds.add(order.sellerAgentId);
    } else {
      counterpartyIds.add(order.buyerAgentId);
    }
  }

  return {
    uniqueCounterparties: counterpartyIds.size,
    clearedTransactions: counterpartyIds.size, // Each unique counterparty = 1 cleared tx
  };
}

/**
 * Get the agent's average rating from completed order feedback.
 * Returns null if no ratings exist.
 */
async function getAgentRating(agentId: string): Promise<number | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { reputation: true },
  });

  if (!agent || agent.reputation === 0) return null;

  // reputation is stored as 0-100 in the DB; convert to 0-5 star scale
  return Math.round((agent.reputation / 20) * 10) / 10;
}

/**
 * Get full tier info for an agent.
 */
export async function getAgentTier(agentId: string): Promise<TierInfo> {
  const [counterpartyData, rating] = await Promise.all([
    countUniqueCounterparties(agentId),
    getAgentRating(agentId),
  ]);

  const { uniqueCounterparties, clearedTransactions } = counterpartyData;

  // Determine tier — walk the table from highest to lowest
  let currentTier = TIER_TABLE[0]; // default tier 0
  for (let i = TIER_TABLE.length - 1; i >= 0; i--) {
    const tier = TIER_TABLE[i];
    const meetsCleared = clearedTransactions >= tier.requiredCleared;
    const meetsRating = tier.requiredRating === null || (rating !== null && rating >= tier.requiredRating);

    if (meetsCleared && meetsRating) {
      currentTier = tier;
      break;
    }
  }

  // Determine next tier
  let nextTier: TierInfo['nextTier'] = null;
  const nextTierIndex = currentTier.tier + 1;
  if (nextTierIndex < TIER_TABLE.length) {
    const next = TIER_TABLE[nextTierIndex];
    nextTier = {
      transactionsNeeded: Math.max(0, next.requiredCleared - clearedTransactions),
      ratingNeeded: next.requiredRating,
    };
  }

  return {
    tier: currentTier.tier,
    tierName: currentTier.name,
    clearedTransactions,
    uniqueCounterparties,
    rating,
    maxPriceUsdc: currentTier.maxPriceUsdc,
    maxActiveListings: currentTier.maxActiveListings,
    collateralRatio: currentTier.collateralRatio,
    nextTier,
  };
}

// ── Validation Functions ───────────────────────────────────────────────────

/**
 * Validate whether an agent can list an item at a given price.
 */
export async function validateListingPrice(
  agentId: string,
  priceUsdc: number,
): Promise<PriceValidation> {
  const tierInfo = await getAgentTier(agentId);

  if (priceUsdc > tierInfo.maxPriceUsdc) {
    return {
      allowed: false,
      reason: `Your trust tier (${tierInfo.tierName}, Tier ${tierInfo.tier}) allows a maximum listing price of $${(tierInfo.maxPriceUsdc / 100).toFixed(2)}. ` +
        `Requested: $${(priceUsdc / 100).toFixed(2)}. ` +
        (tierInfo.nextTier
          ? `Complete ${tierInfo.nextTier.transactionsNeeded} more unique-counterparty transactions to unlock the next tier.`
          : ''),
    };
  }

  return { allowed: true };
}

/**
 * Validate whether an agent can create more active listings.
 */
export async function validateActiveListings(
  agentId: string,
): Promise<ListingValidation> {
  const tierInfo = await getAgentTier(agentId);

  const activeListings = await prisma.listing.count({
    where: {
      agentId,
      status: 'active',
    },
  });

  return {
    allowed: activeListings < tierInfo.maxActiveListings,
    current: activeListings,
    max: tierInfo.maxActiveListings,
  };
}

/**
 * Validate order price against BOTH buyer and seller tiers.
 * The most restrictive (lower) tier's max price applies.
 */
export async function validateOrderPrice(
  buyerAgentId: string,
  sellerAgentId: string,
  priceUsdc: number,
): Promise<OrderPriceValidation> {
  const [buyerTier, sellerTier] = await Promise.all([
    getAgentTier(buyerAgentId),
    getAgentTier(sellerAgentId),
  ]);

  const effectiveMax = Math.min(buyerTier.maxPriceUsdc, sellerTier.maxPriceUsdc);

  if (priceUsdc > effectiveMax) {
    const limitingParty = buyerTier.maxPriceUsdc <= sellerTier.maxPriceUsdc ? 'buyer' : 'seller';
    const limitingTier = limitingParty === 'buyer' ? buyerTier : sellerTier;

    return {
      allowed: false,
      reason: `Transaction price $${(priceUsdc / 100).toFixed(2)} exceeds the maximum allowed by the ${limitingParty}'s trust tier ` +
        `(${limitingTier.tierName}, Tier ${limitingTier.tier}, max $${(limitingTier.maxPriceUsdc / 100).toFixed(2)}). ` +
        `The most restrictive tier between buyer and seller applies.`,
    };
  }

  return { allowed: true };
}

/**
 * Get the tier configuration table (for API/docs).
 */
export function getTierTable(): TierConfig[] {
  return TIER_TABLE.map((t) => ({ ...t }));
}
