import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createFeatureRequestSchema } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';

const router = Router();
const prisma = new PrismaClient();

// POST / — submit feature request
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createFeatureRequestSchema.parse(req.body);

    // Optional auth — can be anonymous
    let agentId: string | null = null;
    const authHeader = req.headers.authorization;
    const apiKey = req.headers['x-api-key'];
    if (authHeader || apiKey) {
      // Try to extract agent ID if authenticated
      try {
        await new Promise<void>((resolve, reject) => {
          authenticate(req, res as any, (err?: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
        agentId = req.agent?.id || null;
      } catch {
        // Anonymous is fine
      }
    }

    const featureRequest = await prisma.featureRequest.create({
      data: {
        agentId,
        title: data.title,
        description: data.description,
      },
    });

    res.status(201).json({ featureRequest });
  } catch (err) {
    next(err);
  }
});

// GET / — list feature requests (sorted by votes)
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where = status ? { status: status as any } : {};

    const [featureRequests, total] = await Promise.all([
      prisma.featureRequest.findMany({
        where,
        include: {
          agent: { select: { id: true, name: true } },
        },
        orderBy: { votes: 'desc' },
        skip,
        take: limit,
      }),
      prisma.featureRequest.count({ where }),
    ]);

    res.json({
      featureRequests,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/vote — upvote a feature request
router.post('/:id/vote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const featureRequest = await prisma.featureRequest.findUnique({ where: { id } });
    if (!featureRequest) {
      throw new AppError('FEATURE_REQUEST_NOT_FOUND', 'Feature request not found', 404);
    }

    const updated = await prisma.featureRequest.update({
      where: { id },
      data: { votes: { increment: 1 } },
    });

    res.json({ featureRequest: updated });
  } catch (err) {
    next(err);
  }
});

// GET /:id — get feature request details
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const featureRequest = await prisma.featureRequest.findUnique({
      where: { id },
      include: {
        agent: { select: { id: true, name: true } },
      },
    });

    if (!featureRequest) {
      throw new AppError('FEATURE_REQUEST_NOT_FOUND', 'Feature request not found', 404);
    }

    res.json({ featureRequest });
  } catch (err) {
    next(err);
  }
});

export default router;
