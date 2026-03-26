import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { upsertSpendingPolicySchema } from '../validators/spendingPolicy';
import { getSpendingSummary } from '../services/spendingPolicy';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/v1/agents/me/spending-policy — Get my spending policy
router.get(
  '/spending-policy',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await prisma.spendingPolicy.findUnique({
        where: { agentId: req.agent!.id },
      });

      res.json({ policy: policy ?? null });
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/v1/agents/me/spending-policy — Create or update spending policy
router.put(
  '/spending-policy',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = upsertSpendingPolicySchema.parse(req.body);

      // If updating, cross-validate against existing values
      const existing = await prisma.spendingPolicy.findUnique({
        where: { agentId: req.agent!.id },
      });

      // Resolve effective values for cross-validation
      const effectiveAutoApprove =
        data.autoApproveBelow !== undefined ? data.autoApproveBelow : existing?.autoApproveBelow ?? null;
      const effectivePerTxMax =
        data.perTransactionMax !== undefined ? data.perTransactionMax : existing?.perTransactionMax ?? null;

      if (
        effectiveAutoApprove !== null &&
        effectivePerTxMax !== null &&
        effectiveAutoApprove > effectivePerTxMax
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          'autoApproveBelow must not exceed perTransactionMax',
          400,
        );
      }

      const policy = await prisma.spendingPolicy.upsert({
        where: { agentId: req.agent!.id },
        create: {
          agentId: req.agent!.id,
          monthlyLimitUsdc: data.monthlyLimitUsdc ?? null,
          perTransactionMax: data.perTransactionMax ?? null,
          autoApproveBelow: data.autoApproveBelow ?? null,
          requireHumanAbove: data.requireHumanAbove ?? null,
          allowedCategories: data.allowedCategories ?? [],
          blockedSellers: data.blockedSellers ?? [],
          cooldownMinutes: data.cooldownMinutes ?? null,
          isActive: data.isActive ?? true,
        },
        update: {
          ...(data.monthlyLimitUsdc !== undefined && { monthlyLimitUsdc: data.monthlyLimitUsdc }),
          ...(data.perTransactionMax !== undefined && { perTransactionMax: data.perTransactionMax }),
          ...(data.autoApproveBelow !== undefined && { autoApproveBelow: data.autoApproveBelow }),
          ...(data.requireHumanAbove !== undefined && { requireHumanAbove: data.requireHumanAbove }),
          ...(data.allowedCategories !== undefined && { allowedCategories: data.allowedCategories }),
          ...(data.blockedSellers !== undefined && { blockedSellers: data.blockedSellers }),
          ...(data.cooldownMinutes !== undefined && { cooldownMinutes: data.cooldownMinutes }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });

      logger.info('Spending policy updated', { agentId: req.agent!.id });

      res.json({ policy });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/agents/me/spending-summary — Get spending summary for current month
router.get(
  '/spending-summary',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await getSpendingSummary(req.agent!.id);
      res.json({ summary });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
