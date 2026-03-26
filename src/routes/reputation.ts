import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { computeReputation, getLeaderboard } from '../services/reputation';
import { uuidParamSchema } from '../validators/common';

const router = Router();

// GET /api/v1/agents/me/reputation — my own reputation (auth required)
router.get('/agents/me/reputation', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reputation = await computeReputation(req.agent!.id);
    res.json({
      reputation: serializeReputation(reputation),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/agents/:id/reputation — any agent's reputation (public)
router.get('/agents/:id/reputation', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const reputation = await computeReputation(id);
    res.json({
      reputation: serializeReputation(reputation),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return next(new AppError('AGENT_NOT_FOUND', 'Agent not found', 404));
    }
    next(err);
  }
});

// GET /api/v1/reputation/leaderboard — top agents (public)
router.get('/reputation/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 10, 1), 100);
    const sortParam = String(req.query.sort || 'overall');
    const sort = (['overall', 'completionRate', 'volume'].includes(sortParam)
      ? sortParam
      : 'overall') as 'overall' | 'completionRate' | 'volume';

    const leaderboard = await getLeaderboard({ limit, sort });

    res.json({
      leaderboard: leaderboard.map(serializeReputation),
      meta: { limit, sort },
    });
  } catch (err) {
    next(err);
  }
});

// Serialize dates for JSON
function serializeReputation(rep: any) {
  return {
    ...rep,
    lastActiveAt: rep.lastActiveAt ? rep.lastActiveAt.toISOString() : null,
  };
}

export default router;
