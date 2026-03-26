/**
 * Tracking Routes
 *
 * GET  /api/v1/orders/:id/tracking — get tracking status and events
 * POST /api/v1/orders/:id/tracking — seller adds tracking number (triggers mark_shipped)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { markShippedOnChain } from '../services/escrow';
import { createCarrierRegistry } from '../services/carriers';
import { dispatchWebhook } from '../services/webhook';
import { emitOrderShipped } from '../services/events';
import { logger } from '../utils/logger';

const router = Router();

// ── Validators ─────────────────────────────────────────────────────────────

const addTrackingSchema = z.object({
  trackingNumber: z.string().min(1).max(100),
  carrier: z.enum(['fedex', 'canada_post']),
});

// ── GET /api/v1/orders/:id/tracking ────────────────────────────────────────

router.get(
  '/:id/tracking',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          trackingEvents: {
            orderBy: { occurredAt: 'desc' },
            take: 50,
          },
        },
      });

      if (!order) {
        throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
      }

      // Only buyer or seller can view tracking
      if (order.buyerAgentId !== req.agent!.id && order.sellerAgentId !== req.agent!.id) {
        throw new AppError('FORBIDDEN', 'You can only view tracking for your own orders', 403);
      }

      // Optionally fetch live tracking data
      let liveTracking = null;
      if (order.trackingNumber && order.carrier) {
        try {
          const registry = createCarrierRegistry();
          const tracker = registry.get(order.carrier);
          if (tracker) {
            liveTracking = await tracker.track(order.trackingNumber);
          }
        } catch (err) {
          logger.warn('Failed to fetch live tracking', {
            orderId: id,
            error: (err as Error).message,
          });
        }
      }

      res.json({
        tracking: {
          orderId: id,
          trackingNumber: order.trackingNumber,
          carrier: order.carrier,
          status: order.status,
          deliveredAt: order.deliveredAt,
          events: order.trackingEvents.map((e) => ({
            id: e.id,
            status: e.status,
            description: e.description,
            location: e.location,
            occurredAt: e.occurredAt,
          })),
          live: liveTracking
            ? {
                status: liveTracking.status,
                estimatedDelivery: liveTracking.estimatedDelivery,
                deliveredAt: liveTracking.deliveredAt,
                signedBy: liveTracking.signedBy,
                eventCount: liveTracking.events.length,
              }
            : null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/v1/orders/:id/tracking ───────────────────────────────────────

router.post(
  '/:id/tracking',
  authenticate,
  requireScope('sell'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const data = addTrackingSchema.parse(req.body);

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          seller: { select: { walletAddress: true } },
          listing: { select: { id: true, title: true } },
        },
      });

      if (!order) {
        throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
      }

      if (order.sellerAgentId !== req.agent!.id) {
        throw new AppError('FORBIDDEN', 'Only the seller can add tracking', 403);
      }

      if (order.status !== 'created' && order.status !== 'funded') {
        throw new AppError(
          'INVALID_STATUS',
          `Cannot add tracking to order in status: ${order.status}`,
          400,
        );
      }

      // Mark shipped on-chain (if escrow is live)
      let txSignature: string | null = null;
      try {
        txSignature = await markShippedOnChain(
          id,
          order.seller.walletAddress || '',
          data.trackingNumber,
          data.carrier,
        );
      } catch (err) {
        logger.warn('On-chain mark_shipped failed (continuing with DB update)', {
          orderId: id,
          error: (err as Error).message,
        });
      }

      // Update order in database
      const updated = await prisma.order.update({
        where: { id },
        data: {
          trackingNumber: data.trackingNumber,
          carrier: data.carrier,
          status: 'fulfilled',
          shippingInfo: {
            ...(order.shippingInfo as any || {}),
            carrier: data.carrier,
            trackingNumber: data.trackingNumber,
            shippedAt: new Date().toISOString(),
            onChainTx: txSignature,
          },
        },
      });

      // Create initial tracking event
      await prisma.trackingEvent.create({
        data: {
          id: `${id}-${data.carrier}-shipped-${Date.now()}`,
          orderId: id,
          carrier: data.carrier,
          status: 'in_transit',
          description: `Tracking number added: ${data.trackingNumber}`,
          occurredAt: new Date(),
        },
      });

      // Record transaction if we got an on-chain signature
      if (txSignature && !txSignature.startsWith('SHIP_STUB_')) {
        await prisma.transaction.create({
          data: {
            orderId: id,
            fromAgentId: order.sellerAgentId,
            toAgentId: null,
            txSignature,
            txType: 'escrow_fund',
            status: 'confirmed',
          },
        });
      }

      // Notify buyer that order has shipped
      emitOrderShipped({
        buyerId: order.buyerAgentId,
        listingTitle: (order as any).listing?.title || 'your item',
        trackingNumber: data.trackingNumber,
        carrier: data.carrier,
        orderId: id,
      });

      // Dispatch webhook
      dispatchWebhook('order.fulfilled', {
        orderId: id,
        sellerId: req.agent!.id,
        trackingNumber: data.trackingNumber,
        carrier: data.carrier,
      }).catch(() => {});

      logger.info('Tracking added to order', {
        orderId: id,
        trackingNumber: data.trackingNumber,
        carrier: data.carrier,
      });

      res.json({
        tracking: {
          orderId: id,
          trackingNumber: data.trackingNumber,
          carrier: data.carrier,
          status: updated.status,
          txSignature,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
