/**
 * Collateral Service — Mutual Staking Enforcement
 *
 * Both buyer and seller must stake collateral ≥ 100% of item value.
 * This makes fraud economically irrational — cheating costs more than the item is worth.
 * Collateral is returned on clean completion.
 *
 * Tier-based collateral ratios:
 *   Tier 0 (new/unknown):  200% from each party
 *   Tier 1 (some history): 150% from each party
 *   Tier 2 (established):  100% from each party
 *   Tier 3 (trusted):      100% from each party
 *   Tier 4 (verified):     100% from each party (75% reserved for future verified accounts)
 *
 * MINIMUM is always 100% — never below item price.
 */

import { prisma } from '../lib/prisma';
import { getBalances } from './wallet';
import { logger } from '../utils/logger';
import { getAgentTier as getTrustTier } from './trustTier';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CollateralRequirement {
  itemPriceUsdc: number;
  buyerCollateralUsdc: number;    // Always ≥ itemPrice (100%)
  sellerCollateralUsdc: number;   // Always ≥ itemPrice (100%)
  totalEscrowUsdc: number;        // itemPrice + buyerCollateral + sellerCollateral
  collateralRatio: number;        // 1.0 = 100%, 2.0 = 200%
  buyerTier: number;
  sellerTier: number;
}

export interface CollateralValidation {
  sufficient: boolean;
  available: number;
  required: number;
  shortfall: number;
}

export interface CollateralStatus {
  orderId: string;
  itemPriceUsdc: string;
  buyerCollateralUsdc: string;
  sellerCollateralUsdc: string;
  collateralRatio: number;
  totalLockedUsdc: string;
  status: 'pending' | 'locked' | 'released' | 'forfeited' | 'disputed';
}

// ── Tier → Collateral Ratio Mapping ────────────────────────────────────────

const TIER_COLLATERAL_RATIOS: Record<number, number> = {
  0: 2.0,   // 200% — new/unknown agents
  1: 1.5,   // 150% — some transaction history
  2: 1.0,   // 100% — established
  3: 1.0,   // 100% — trusted
  4: 1.0,   // 100% — verified (future: could drop to 75%)
};

/** Minimum collateral ratio — NEVER below 100% of item price */
const MIN_COLLATERAL_RATIO = 1.0;

// ── Tier Determination ─────────────────────────────────────────────────────

/**
 * Determine an agent's collateral tier based on their trust tier.
 * Delegates to the trust tier service for counterparty-diversity-based progression.
 * Higher tier = lower collateral requirement (but never below 100%).
 */
export async function getAgentTier(agentId: string): Promise<number> {
  try {
    const tierInfo = await getTrustTier(agentId);
    return tierInfo.tier;
  } catch (err) {
    logger.warn('Failed to compute trust tier, defaulting to tier 0', {
      agentId,
      error: (err as Error).message,
    });
    return 0;
  }
}

// ── Collateral Calculation ─────────────────────────────────────────────────

/**
 * Calculate collateral requirements for a transaction.
 *
 * @param itemPriceUsdc - Item price in USDC (raw bigint-compatible number, 6 decimals)
 * @param buyerTier - Buyer's collateral tier (0–4)
 * @param sellerTier - Seller's collateral tier (0–4)
 * @returns CollateralRequirement with all amounts
 */
export function calculateCollateral(
  itemPriceUsdc: number,
  buyerTier: number,
  sellerTier: number,
): CollateralRequirement {
  // Use the HIGHER ratio of the two parties (more conservative)
  const buyerRatio = TIER_COLLATERAL_RATIOS[buyerTier] ?? TIER_COLLATERAL_RATIOS[0];
  const sellerRatio = TIER_COLLATERAL_RATIOS[sellerTier] ?? TIER_COLLATERAL_RATIOS[0];
  const effectiveRatio = Math.max(buyerRatio, sellerRatio, MIN_COLLATERAL_RATIO);

  const buyerCollateralUsdc = Math.ceil(itemPriceUsdc * effectiveRatio);
  const sellerCollateralUsdc = Math.ceil(itemPriceUsdc * effectiveRatio);

  // Total in escrow: item price + buyer collateral + seller collateral
  const totalEscrowUsdc = itemPriceUsdc + buyerCollateralUsdc + sellerCollateralUsdc;

  return {
    itemPriceUsdc,
    buyerCollateralUsdc,
    sellerCollateralUsdc,
    totalEscrowUsdc,
    collateralRatio: effectiveRatio,
    buyerTier,
    sellerTier,
  };
}

// ── Collateral Validation ──────────────────────────────────────────────────

/**
 * Validate whether an agent has sufficient USDC for the required collateral.
 *
 * @param agentId - Agent ID to check
 * @param requiredUsdc - Required USDC amount (raw, 6 decimals)
 * @returns Validation result with available/required/shortfall
 */
export async function validateCollateral(
  agentId: string,
  requiredUsdc: number,
): Promise<CollateralValidation> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { walletAddress: true },
  });

  if (!agent?.walletAddress) {
    return {
      sufficient: false,
      available: 0,
      required: requiredUsdc,
      shortfall: requiredUsdc,
    };
  }

  try {
    const balances = await getBalances(agent.walletAddress);
    const availableUsdc = Number(balances.usdcRaw);

    return {
      sufficient: availableUsdc >= requiredUsdc,
      available: availableUsdc,
      required: requiredUsdc,
      shortfall: Math.max(0, requiredUsdc - availableUsdc),
    };
  } catch (err) {
    logger.warn('Failed to check wallet balance for collateral validation', {
      agentId,
      error: (err as Error).message,
    });

    // If we can't check balance, assume insufficient (fail-safe)
    return {
      sufficient: false,
      available: 0,
      required: requiredUsdc,
      shortfall: requiredUsdc,
    };
  }
}

// ── Collateral Status ──────────────────────────────────────────────────────

/**
 * Get collateral status for an order.
 */
export async function getCollateralStatus(orderId: string): Promise<CollateralStatus | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      amountUsdc: true,
      buyerCollateralUsdc: true,
      sellerCollateralUsdc: true,
      collateralRatio: true,
      status: true,
    },
  });

  if (!order) return null;

  const itemPrice = Number(order.amountUsdc);
  const buyerCollateral = Number(order.buyerCollateralUsdc ?? 0);
  const sellerCollateral = Number(order.sellerCollateralUsdc ?? 0);
  const totalLocked = itemPrice + buyerCollateral + sellerCollateral;

  // Derive collateral status from order status
  let collateralStatus: CollateralStatus['status'];
  switch (order.status) {
    case 'completed':
    case 'refunded':
    case 'cancelled':
      collateralStatus = 'released';
      break;
    case 'disputed':
      collateralStatus = 'disputed';
      break;
    case 'created':
    case 'pending_approval':
      collateralStatus = 'pending';
      break;
    default:
      collateralStatus = 'locked';
  }

  return {
    orderId: order.id,
    itemPriceUsdc: itemPrice.toString(),
    buyerCollateralUsdc: buyerCollateral.toString(),
    sellerCollateralUsdc: sellerCollateral.toString(),
    collateralRatio: order.collateralRatio ?? 1.0,
    totalLockedUsdc: totalLocked.toString(),
    status: collateralStatus,
  };
}

// ── Collateral Estimation ──────────────────────────────────────────────────

/**
 * Estimate collateral requirements for a given price.
 * Returns estimates for all tier combinations.
 */
export function estimateCollateral(priceUsdc: number): {
  price: number;
  tiers: Array<{
    tierCombo: string;
    ratio: number;
    buyerCollateral: number;
    sellerCollateral: number;
    totalEscrow: number;
    buyerTotalCost: number; // price + buyer collateral
  }>;
  minimum: CollateralRequirement;
  maximum: CollateralRequirement;
} {
  const tierCombos = [
    { label: 'Both new (Tier 0)', buyer: 0, seller: 0 },
    { label: 'New buyer + Tier 1 seller', buyer: 0, seller: 1 },
    { label: 'Both Tier 1', buyer: 1, seller: 1 },
    { label: 'Both established (Tier 2+)', buyer: 2, seller: 2 },
  ];

  const tiers = tierCombos.map((combo) => {
    const req = calculateCollateral(priceUsdc, combo.buyer, combo.seller);
    return {
      tierCombo: combo.label,
      ratio: req.collateralRatio,
      buyerCollateral: req.buyerCollateralUsdc,
      sellerCollateral: req.sellerCollateralUsdc,
      totalEscrow: req.totalEscrowUsdc,
      buyerTotalCost: priceUsdc + req.buyerCollateralUsdc,
    };
  });

  const minimum = calculateCollateral(priceUsdc, 4, 4); // Best case
  const maximum = calculateCollateral(priceUsdc, 0, 0); // Worst case

  return { price: priceUsdc, tiers, minimum, maximum };
}

// ── Dispute Collateral Distribution ────────────────────────────────────────

/**
 * Calculate collateral distribution for dispute resolution.
 *
 * @param resolution - 'full_refund' | 'release_to_seller' | 'partial_refund' | 'split'
 * @param buyerCollateral - Buyer's staked collateral
 * @param sellerCollateral - Seller's staked collateral
 * @param itemPrice - Original item price
 * @returns Distribution amounts for buyer and seller
 */
export function calculateDisputeDistribution(
  resolution: string,
  buyerCollateral: number,
  sellerCollateral: number,
  itemPrice: number,
): {
  buyerReceives: number;
  sellerReceives: number;
  platformReceives: number;
  description: string;
} {
  switch (resolution) {
    case 'full_refund':
      // Buyer wins: gets their collateral back + item price refund + 50% of seller's collateral
      return {
        buyerReceives: buyerCollateral + itemPrice + Math.floor(sellerCollateral * 0.5),
        sellerReceives: Math.floor(sellerCollateral * 0.5), // Seller loses half their collateral
        platformReceives: 0,
        description: 'Full refund to buyer. Buyer collateral returned. Seller forfeits 50% of collateral to buyer.',
      };

    case 'release_to_seller':
      // Seller wins: gets their collateral back + item price + 50% of buyer's collateral
      return {
        buyerReceives: Math.floor(buyerCollateral * 0.5), // Buyer loses half their collateral
        sellerReceives: sellerCollateral + itemPrice + Math.floor(buyerCollateral * 0.5),
        platformReceives: 0,
        description: 'Funds released to seller. Seller collateral returned. Buyer forfeits 50% of collateral to seller.',
      };

    case 'partial_refund':
      // Both get their collateral back, item price split
      return {
        buyerReceives: buyerCollateral + Math.floor(itemPrice * 0.5),
        sellerReceives: sellerCollateral + Math.floor(itemPrice * 0.5),
        platformReceives: 0,
        description: 'Partial refund. Both parties receive their collateral back. Item price split 50/50.',
      };

    case 'split':
      // Even split of everything
      const totalPool = buyerCollateral + sellerCollateral + itemPrice;
      return {
        buyerReceives: Math.floor(totalPool * 0.5),
        sellerReceives: Math.floor(totalPool * 0.5),
        platformReceives: totalPool - Math.floor(totalPool * 0.5) * 2, // Rounding remainder
        description: 'Even split of all funds including collateral.',
      };

    default:
      // Default: return all collateral, refund buyer
      return {
        buyerReceives: buyerCollateral + itemPrice,
        sellerReceives: sellerCollateral,
        platformReceives: 0,
        description: 'Default resolution. Collateral returned to both parties. Item price refunded to buyer.',
      };
  }
}
