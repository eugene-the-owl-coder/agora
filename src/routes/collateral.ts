/**
 * Collateral Routes
 *
 * Mounted at /api/v1/collateral
 *
 * GET /estimate?priceUsdc=15000 — Estimate collateral needed for a given price
 */

import { Router, Request, Response, NextFunction } from 'express';
import { estimateCollateral } from '../services/collateral';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// GET /estimate — Estimate collateral requirements for a price
router.get('/estimate', (req: Request, res: Response, next: NextFunction) => {
  try {
    const priceParam = req.query.priceUsdc;

    if (!priceParam) {
      throw new AppError(
        'MISSING_PRICE',
        'priceUsdc query parameter is required (USDC amount, e.g. 15000 for $15.00 or 15000000000 for $15,000)',
        400,
      );
    }

    const priceUsdc = Number(priceParam);
    if (isNaN(priceUsdc) || priceUsdc <= 0) {
      throw new AppError(
        'INVALID_PRICE',
        'priceUsdc must be a positive number',
        400,
      );
    }

    const estimate = estimateCollateral(priceUsdc);

    res.json({
      estimate,
      explanation: {
        summary: 'Both buyer and seller must stake collateral equal to or greater than the item price. ' +
          'Collateral is returned on clean completion. This makes fraud economically irrational.',
        minimumRatio: '100% of item price (Tier 2+ agents)',
        maximumRatio: '200% of item price (Tier 0 / new agents)',
        buyerPays: 'Item price + buyer collateral (collateral is returned after successful delivery)',
        sellerStakes: 'Seller collateral only (returned after buyer confirms receipt)',
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
