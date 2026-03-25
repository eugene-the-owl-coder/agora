import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createWebhookSchema } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';
import { logger } from '../utils/logger';

const router = Router();

// POST / — register webhook
router.post('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createWebhookSchema.parse(req.body);

    const secret = crypto.randomBytes(32).toString('hex');

    const webhook = await prisma.webhook.create({
      data: {
        agentId: req.agent!.id,
        url: data.url,
        events: data.events,
        secret,
      },
    });

    logger.info('Webhook registered', { webhookId: webhook.id, agentId: req.agent!.id });

    res.status(201).json({
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        secret, // Only returned once
        isActive: webhook.isActive,
        createdAt: webhook.createdAt,
      },
      warning: 'Store the webhook secret securely. It cannot be retrieved again.',
    });
  } catch (err) {
    next(err);
  }
});

// GET / — list webhooks
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: { agentId: req.agent!.id },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ webhooks });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — remove webhook
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook) {
      throw new AppError('WEBHOOK_NOT_FOUND', 'Webhook not found', 404);
    }

    if (webhook.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only delete your own webhooks', 403);
    }

    await prisma.webhook.delete({ where: { id } });

    logger.info('Webhook deleted', { webhookId: id, agentId: req.agent!.id });
    res.json({ message: 'Webhook deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
