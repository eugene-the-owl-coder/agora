/**
 * Rating Routes
 *
 * GET  /api/v1/agents/me/ratings   — authenticated agent's own ratings
 * GET  /api/v1/agents/:id/ratings  — public, any agent's ratings
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getAgentRatings } from '../services/rating';
import { uuidParamSchema } from '../validators/common';

const router = Router();

// GET /api/v1/agents/me/ratings — my ratings (auth required)
router.get(
  '/agents/me/ratings',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ratings = await getAgentRatings(req.agent!.id);
      res.json({ ratings });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/agents/:id/ratings — any agent's ratings (public)
router.get(
  '/agents/:id/ratings',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const ratings = await getAgentRatings(id);
      res.json({ ratings });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return next(new AppError('AGENT_NOT_FOUND', 'Agent not found', 404));
      }
      next(err);
    }
  },
);

export default router;
