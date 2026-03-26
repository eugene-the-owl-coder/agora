/**
 * Admin Routes
 *
 * POST /api/v1/admin/fix-seed-prices — fix over-inflated seed listing prices
 *
 * Protected by ADMIN_SECRET header. Not for public use.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { config } from '../config';

const router = Router();

/**
 * Middleware: require x-admin-secret header matching ADMIN_SECRET env var.
 */
function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-admin-secret'];
  if (!config.adminSecret || secret !== config.adminSecret) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing admin secret',
        status: 401,
      },
    });
    return;
  }
  next();
}

/**
 * POST /fix-seed-prices
 *
 * Finds listings where priceUsdc > 10,000,000 (likely seeded with
 * raw-cent values instead of USDC micro-units) and divides by 10,000.
 *
 * Query params:
 *   ?dry_run=true — preview changes without writing
 */
router.post(
  '/fix-seed-prices',
  requireAdminSecret,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dryRun = req.query.dry_run === 'true';
      const threshold = 10_000_000n;
      const divisor = 10_000n;

      const overpriced = await prisma.listing.findMany({
        where: { priceUsdc: { gt: threshold } },
        select: { id: true, title: true, priceUsdc: true },
      });

      const results = overpriced.map((l) => ({
        id: l.id,
        title: l.title,
        before: l.priceUsdc.toString(),
        after: (l.priceUsdc / divisor).toString(),
      }));

      if (!dryRun) {
        for (const listing of overpriced) {
          await prisma.listing.update({
            where: { id: listing.id },
            data: { priceUsdc: listing.priceUsdc / divisor },
          });
        }
      }

      res.json({
        dryRun,
        fixed: results.length,
        listings: results,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
