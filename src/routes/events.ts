/**
 * Event Notification Routes
 *
 * GET  /api/v1/events              — List my events (params: unreadOnly, type, limit)
 * GET  /api/v1/events/unread/count — Unread count (for badge)
 * PUT  /api/v1/events/:id/read     — Mark one event as read
 * PUT  /api/v1/events/read-all     — Mark all as read
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { getEvents, markRead, markAllRead, getUnreadCount } from '../services/events';
import { uuidParamSchema } from '../validators/common';

const router = Router();

// ── Validators ─────────────────────────────────────────────────

const listEventsSchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── GET /api/v1/events ─────────────────────────────────────────

router.get(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = listEventsSchema.parse(req.query);

      const events = await getEvents(req.agent!.id, {
        unreadOnly: params.unreadOnly || undefined,
        type: params.type,
        limit: params.limit,
      });

      res.json({
        events: events.map(serializeEvent),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/v1/events/unread/count ────────────────────────────

router.get(
  '/unread/count',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await getUnreadCount(req.agent!.id);
      res.json({ unreadCount: count });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/v1/events/:id/read ────────────────────────────────

router.put(
  '/:id/read',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      await markRead(id, req.agent!.id);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ── PUT /api/v1/events/read-all ────────────────────────────────

router.put(
  '/read-all',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await markAllRead(req.agent!.id);
      res.json({ success: true, markedRead: count });
    } catch (err) {
      next(err);
    }
  },
);

// ── Serializer ─────────────────────────────────────────────────

function serializeEvent(event: any) {
  return {
    id: event.id,
    agentId: event.agentId,
    type: event.type,
    title: event.title,
    message: event.message,
    data: event.data,
    read: event.read,
    createdAt: event.createdAt?.toISOString?.() || event.createdAt,
  };
}

export default router;
