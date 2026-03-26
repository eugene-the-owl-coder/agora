import { describe, it, expect } from 'vitest';
import { calculateCollateral, estimateCollateral, calculateDisputeDistribution } from '../collateral';

describe('calculateCollateral', () => {
  const PRICE = 1_000_000; // 1 USDC in minor units (6 decimals)

  describe('tier-based collateral ratios', () => {
    it('Tier 0 (both new) → 200% collateral', () => {
      const result = calculateCollateral(PRICE, 0, 0);
      expect(result.collateralRatio).toBe(2.0);
      expect(result.buyerCollateralUsdc).toBe(2_000_000);
      expect(result.sellerCollateralUsdc).toBe(2_000_000);
    });

    it('Tier 1 (both some history) → 150% collateral', () => {
      const result = calculateCollateral(PRICE, 1, 1);
      expect(result.collateralRatio).toBe(1.5);
      expect(result.buyerCollateralUsdc).toBe(1_500_000);
      expect(result.sellerCollateralUsdc).toBe(1_500_000);
    });

    it('Tier 2 (both established) → 100% collateral', () => {
      const result = calculateCollateral(PRICE, 2, 2);
      expect(result.collateralRatio).toBe(1.0);
      expect(result.buyerCollateralUsdc).toBe(1_000_000);
      expect(result.sellerCollateralUsdc).toBe(1_000_000);
    });

    it('Tier 3 (both trusted) → 100% collateral', () => {
      const result = calculateCollateral(PRICE, 3, 3);
      expect(result.collateralRatio).toBe(1.0);
      expect(result.buyerCollateralUsdc).toBe(1_000_000);
      expect(result.sellerCollateralUsdc).toBe(1_000_000);
    });

    it('Tier 4 (both verified) → 100% collateral', () => {
      const result = calculateCollateral(PRICE, 4, 4);
      expect(result.collateralRatio).toBe(1.0);
      expect(result.buyerCollateralUsdc).toBe(1_000_000);
      expect(result.sellerCollateralUsdc).toBe(1_000_000);
    });
  });

  describe('asymmetric tiers use the higher ratio', () => {
    it('Tier 0 buyer + Tier 2 seller → 200% (uses higher)', () => {
      const result = calculateCollateral(PRICE, 0, 2);
      expect(result.collateralRatio).toBe(2.0);
      expect(result.buyerCollateralUsdc).toBe(2_000_000);
      expect(result.sellerCollateralUsdc).toBe(2_000_000);
    });

    it('Tier 1 buyer + Tier 0 seller → 200% (uses higher)', () => {
      const result = calculateCollateral(PRICE, 1, 0);
      expect(result.collateralRatio).toBe(2.0);
    });

    it('Tier 2 buyer + Tier 1 seller → 150% (uses higher)', () => {
      const result = calculateCollateral(PRICE, 2, 1);
      expect(result.collateralRatio).toBe(1.5);
    });
  });

  describe('collateral is never below 100%', () => {
    it('best-case tiers still require 100%', () => {
      const result = calculateCollateral(PRICE, 4, 4);
      expect(result.collateralRatio).toBeGreaterThanOrEqual(1.0);
      expect(result.buyerCollateralUsdc).toBeGreaterThanOrEqual(PRICE);
      expect(result.sellerCollateralUsdc).toBeGreaterThanOrEqual(PRICE);
    });
  });

  describe('unknown tier defaults to Tier 0 (200%)', () => {
    it('unknown tier number → 200%', () => {
      const result = calculateCollateral(PRICE, 99, 99);
      expect(result.collateralRatio).toBe(2.0);
    });
  });

  describe('total escrow calculation', () => {
    it('totalEscrow = price + buyerCollateral + sellerCollateral', () => {
      const result = calculateCollateral(PRICE, 2, 2);
      expect(result.totalEscrowUsdc).toBe(PRICE + result.buyerCollateralUsdc + result.sellerCollateralUsdc);
      // 1M + 1M + 1M = 3M
      expect(result.totalEscrowUsdc).toBe(3_000_000);
    });

    it('Tier 0 totalEscrow = price + 2*200%', () => {
      const result = calculateCollateral(PRICE, 0, 0);
      // 1M + 2M + 2M = 5M
      expect(result.totalEscrowUsdc).toBe(5_000_000);
    });
  });

  describe('preserves tier info in result', () => {
    it('returns buyerTier and sellerTier', () => {
      const result = calculateCollateral(PRICE, 1, 3);
      expect(result.buyerTier).toBe(1);
      expect(result.sellerTier).toBe(3);
    });
  });

  describe('Math.ceil rounding', () => {
    it('rounds up fractional collateral', () => {
      // 333_333 * 1.5 = 499_999.5 → ceil → 500_000
      const result = calculateCollateral(333_333, 1, 1);
      expect(result.buyerCollateralUsdc).toBe(500_000);
      expect(result.sellerCollateralUsdc).toBe(500_000);
    });
  });
});

describe('estimateCollateral', () => {
  it('returns estimates for all tier combinations', () => {
    const result = estimateCollateral(1_000_000);
    expect(result.price).toBe(1_000_000);
    expect(result.tiers).toHaveLength(4);
    expect(result.minimum).toBeDefined();
    expect(result.maximum).toBeDefined();
  });

  it('minimum is best case (Tier 4+4)', () => {
    const result = estimateCollateral(1_000_000);
    expect(result.minimum.collateralRatio).toBe(1.0);
  });

  it('maximum is worst case (Tier 0+0)', () => {
    const result = estimateCollateral(1_000_000);
    expect(result.maximum.collateralRatio).toBe(2.0);
  });

  it('includes buyerTotalCost in tier entries', () => {
    const result = estimateCollateral(1_000_000);
    const tier0 = result.tiers[0]; // Both new
    expect(tier0.buyerTotalCost).toBe(1_000_000 + tier0.buyerCollateral);
  });
});

describe('calculateDisputeDistribution', () => {
  const BUYER_COLLATERAL = 1_000_000;
  const SELLER_COLLATERAL = 1_000_000;
  const ITEM_PRICE = 1_000_000;

  it('full_refund: buyer gets collateral + price + 50% seller collateral', () => {
    const result = calculateDisputeDistribution('full_refund', BUYER_COLLATERAL, SELLER_COLLATERAL, ITEM_PRICE);
    expect(result.buyerReceives).toBe(1_000_000 + 1_000_000 + 500_000); // 2.5M
    expect(result.sellerReceives).toBe(500_000); // loses half collateral
    expect(result.platformReceives).toBe(0);
  });

  it('release_to_seller: seller gets collateral + price + 50% buyer collateral', () => {
    const result = calculateDisputeDistribution('release_to_seller', BUYER_COLLATERAL, SELLER_COLLATERAL, ITEM_PRICE);
    expect(result.sellerReceives).toBe(1_000_000 + 1_000_000 + 500_000);
    expect(result.buyerReceives).toBe(500_000);
    expect(result.platformReceives).toBe(0);
  });

  it('partial_refund: both get collateral back + 50% of price', () => {
    const result = calculateDisputeDistribution('partial_refund', BUYER_COLLATERAL, SELLER_COLLATERAL, ITEM_PRICE);
    expect(result.buyerReceives).toBe(1_000_000 + 500_000);
    expect(result.sellerReceives).toBe(1_000_000 + 500_000);
    expect(result.platformReceives).toBe(0);
  });

  it('split: even split of total pool', () => {
    const result = calculateDisputeDistribution('split', BUYER_COLLATERAL, SELLER_COLLATERAL, ITEM_PRICE);
    const totalPool = BUYER_COLLATERAL + SELLER_COLLATERAL + ITEM_PRICE;
    expect(result.buyerReceives + result.sellerReceives + result.platformReceives).toBe(totalPool);
    expect(result.buyerReceives).toBe(Math.floor(totalPool * 0.5));
    expect(result.sellerReceives).toBe(Math.floor(totalPool * 0.5));
  });

  it('unknown resolution: refund buyer, return collateral to both', () => {
    const result = calculateDisputeDistribution('unknown', BUYER_COLLATERAL, SELLER_COLLATERAL, ITEM_PRICE);
    expect(result.buyerReceives).toBe(BUYER_COLLATERAL + ITEM_PRICE);
    expect(result.sellerReceives).toBe(SELLER_COLLATERAL);
    expect(result.platformReceives).toBe(0);
  });
});
