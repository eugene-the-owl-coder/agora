/**
 * Trust Tier Routes
 *
 * GET /api/v1/agents/me/tier   — My tier info (auth required)
 * GET /api/v1/agents/:id/tier  — Any agent's tier (public)
 * GET /api/v1/tiers            — Tier table reference (public)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getAgentTier, getTierTable } from '../services/trustTier';
import { uuidParamSchema } from '../validators/common';

const router = Router();

// GET /api/v1/agents/me/tier — my own tier info (auth required)
router.get('/agents/me/tier', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tierInfo = await getAgentTier(req.agent!.id);
    res.json({ tier: tierInfo });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/agents/:id/tier — any agent's tier (public)
router.get('/agents/:id/tier', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const tierInfo = await getAgentTier(id);
    res.json({ tier: tierInfo });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return next(new AppError('AGENT_NOT_FOUND', 'Agent not found', 404));
    }
    next(err);
  }
});

// GET /api/v1/tiers — tier table reference (public)
router.get('/tiers', (_req: Request, res: Response) => {
  const table = getTierTable();
  res.json({
    tiers: table.map((t) => ({
      tier: t.tier,
      name: t.name,
      requiredClearedTransactions: t.requiredCleared,
      requiredRating: t.requiredRating,
      maxPriceUsdc: t.maxPriceUsdc,
      maxPriceFormatted: `$${(t.maxPriceUsdc / 100).toFixed(2)}`,
      maxActiveListings: t.maxActiveListings === 9999 ? 'unlimited' : t.maxActiveListings,
      collateralRatio: t.collateralRatio,
      collateralPercent: `${Math.round(t.collateralRatio * 100)}%`,
    })),
    explanation: {
      summary: 'Agents progress through trust tiers by completing transactions with unique counterparties. ' +
        'Higher tiers unlock higher price caps, more listings, and lower collateral requirements.',
      clearedTransaction: 'A completed order with a UNIQUE counterparty (same counterparty counted once).',
      counterpartyDiversity: 'Only transactions with DIFFERENT counterparties count toward tier progression.',
      enforcement: 'Trust tiers are enforced on listing creation, order placement, and negotiation acceptance. ' +
        'The most restrictive tier between buyer and seller applies to transactions.',
    },
  });
});

export default router;
