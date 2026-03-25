import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createOrderSchema, fulfillOrderSchema, disputeOrderSchema, listOrdersSchema } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';
import { createEscrow, releaseEscrow, refundEscrow, openDisputeOnChain, determineTier } from '../services/escrow';
import { dispatchWebhook } from '../services/webhook';
import { logger } from '../utils/logger';

const router = Router();

// POST / — create order
router.post('/', authenticate, requireScope('buy'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createOrderSchema.parse(req.body);

    const listing = await prisma.listing.findUnique({
      where: { id: data.listingId },
      include: { agent: true },
    });

    if (!listing) {
      throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
    }

    if (listing.status !== 'active') {
      throw new AppError('LISTING_UNAVAILABLE', 'This listing is not available for purchase', 400);
    }

    if (listing.agentId === req.agent!.id) {
      throw new AppError('SELF_PURCHASE', 'Cannot purchase your own listing', 400);
    }

    if (listing.quantity < 1) {
      throw new AppError('OUT_OF_STOCK', 'This listing is out of stock', 400);
    }

    // Create escrow (stubbed for Phase 2)
    const escrow = await createEscrow(
      req.agent!.walletAddress || '',
      listing.agent.walletAddress || '',
      listing.priceUsdc,
    );

    const order = await prisma.order.create({
      data: {
        listingId: listing.id,
        buyerAgentId: req.agent!.id,
        sellerAgentId: listing.agentId,
        amountUsdc: listing.priceUsdc,
        escrowAddress: escrow.escrowAddress,
        escrowSignature: escrow.txSignature,
        status: 'created',
        shippingInfo: (data.shippingInfo || Prisma.JsonNull) as Prisma.InputJsonValue,
      },
      include: {
        listing: { select: { id: true, title: true } },
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
      },
    });

    // Create transaction record
    await prisma.transaction.create({
      data: {
        orderId: order.id,
        fromAgentId: req.agent!.id,
        toAgentId: null,
        amountUsdc: listing.priceUsdc,
        txSignature: escrow.txSignature,
        txType: 'escrow_fund',
        status: 'pending',
      },
    });

    logger.info('Order created', { orderId: order.id, listingId: listing.id });

    dispatchWebhook('order.created', {
      orderId: order.id,
      listingId: listing.id,
      buyerId: req.agent!.id,
      sellerId: listing.agentId,
      amountUsdc: listing.priceUsdc.toString(),
    }).catch(() => {});

    res.status(201).json({ order: serializeOrder(order) });
  } catch (err) {
    next(err);
  }
});

// GET / — list orders
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = listOrdersSchema.parse(req.query);
    const skip = (params.page - 1) * params.limit;

    const where: Prisma.OrderWhereInput = {};

    if (params.role === 'buyer') {
      where.buyerAgentId = req.agent!.id;
    } else if (params.role === 'seller') {
      where.sellerAgentId = req.agent!.id;
    } else {
      where.OR = [
        { buyerAgentId: req.agent!.id },
        { sellerAgentId: req.agent!.id },
      ];
    }

    if (params.status) {
      where.status = params.status;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          listing: { select: { id: true, title: true, images: true } },
          buyer: { select: { id: true, name: true } },
          seller: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: params.limit,
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      orders: orders.map(serializeOrder),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id — order details with transactions
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        listing: { select: { id: true, title: true, images: true, description: true } },
        buyer: { select: { id: true, name: true, walletAddress: true } },
        seller: { select: { id: true, name: true, walletAddress: true } },
        transactions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    // Only buyer or seller can view
    if (order.buyerAgentId !== req.agent!.id && order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only view your own orders', 403);
    }

    res.json({ order: serializeOrder(order) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/fulfill — seller marks fulfilled
router.post('/:id/fulfill', authenticate, requireScope('sell'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = fulfillOrderSchema.parse(req.body);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only the seller can fulfill this order', 403);
    }

    if (order.status !== 'created' && order.status !== 'funded') {
      throw new AppError('INVALID_STATUS', `Order cannot be fulfilled from status: ${order.status}`, 400);
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'fulfilled',
        trackingNumber: data.trackingNumber || null,
        shippingInfo: (data.shippingInfo || order.shippingInfo || undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    dispatchWebhook('order.fulfilled', {
      orderId: id,
      sellerId: req.agent!.id,
      trackingNumber: data.trackingNumber,
    }).catch(() => {});

    logger.info('Order fulfilled', { orderId: id });
    res.json({ order: serializeOrder(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/confirm — buyer confirms receipt
router.post('/:id/confirm', authenticate, requireScope('buy'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const order = await prisma.order.findUnique({
      where: { id },
      include: { seller: true },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.buyerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only the buyer can confirm this order', 403);
    }

    if (order.status !== 'fulfilled') {
      throw new AppError('INVALID_STATUS', `Order cannot be confirmed from status: ${order.status}`, 400);
    }

    // Release escrow (stubbed)
    const releaseSig = await releaseEscrow(
      order.escrowAddress || '',
      order.seller.walletAddress || '',
    );

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'completed',
        resolvedAt: new Date(),
      },
    });

    // Record release transaction
    await prisma.transaction.create({
      data: {
        orderId: id,
        fromAgentId: null,
        toAgentId: order.sellerAgentId,
        amountUsdc: order.amountUsdc,
        txSignature: releaseSig,
        txType: 'escrow_release',
        status: 'confirmed',
      },
    });

    // Update seller stats
    await prisma.agent.update({
      where: { id: order.sellerAgentId },
      data: { totalSales: { increment: 1 } },
    });

    // Update buyer stats
    await prisma.agent.update({
      where: { id: order.buyerAgentId },
      data: { totalPurchases: { increment: 1 } },
    });

    // Update listing
    await prisma.listing.update({
      where: { id: order.listingId },
      data: {
        quantity: { decrement: 1 },
        status: 'sold',
      },
    });

    dispatchWebhook('order.completed', { orderId: id }).catch(() => {});
    dispatchWebhook('listing.sold', { listingId: order.listingId, orderId: id }).catch(() => {});

    logger.info('Order completed', { orderId: id });
    res.json({ order: serializeOrder(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/dispute — open dispute
router.post('/:id/dispute', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = disputeOrderSchema.parse(req.body);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.buyerAgentId !== req.agent!.id && order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only buyer or seller can dispute this order', 403);
    }

    if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'refunded') {
      throw new AppError('INVALID_STATUS', `Order cannot be disputed from status: ${order.status}`, 400);
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'disputed',
        disputeReason: data.reason,
      },
    });

    dispatchWebhook('order.disputed', { orderId: id, reason: data.reason }).catch(() => {});

    logger.info('Order disputed', { orderId: id });
    res.json({ order: serializeOrder(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/cancel — cancel order
router.post('/:id/cancel', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.buyerAgentId !== req.agent!.id && order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only buyer or seller can cancel this order', 403);
    }

    if (order.status !== 'created' && order.status !== 'funded') {
      throw new AppError('INVALID_STATUS', `Order cannot be cancelled from status: ${order.status}`, 400);
    }

    // Refund escrow if funded
    if (order.escrowAddress) {
      const refundSig = await refundEscrow(order.escrowAddress, '');
      await prisma.transaction.create({
        data: {
          orderId: id,
          fromAgentId: null,
          toAgentId: order.buyerAgentId,
          amountUsdc: order.amountUsdc,
          txSignature: refundSig,
          txType: 'refund',
          status: 'confirmed',
        },
      });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'cancelled',
        resolvedAt: new Date(),
      },
    });

    dispatchWebhook('order.cancelled', { orderId: id }).catch(() => {});

    logger.info('Order cancelled', { orderId: id });
    res.json({ order: serializeOrder(updated) });
  } catch (err) {
    next(err);
  }
});

function serializeOrder(order: any) {
  return {
    ...order,
    amountUsdc: order.amountUsdc?.toString(),
    transactions: order.transactions?.map((tx: any) => ({
      ...tx,
      amountUsdc: tx.amountUsdc?.toString(),
      amountSol: tx.amountSol?.toString(),
    })),
  };
}

export default router;
