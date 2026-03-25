import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createBuyOrderSchema, updateBuyOrderSchema } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';
import { findMatchingListings } from '../services/matching';
import { logger } from '../utils/logger';

const router = Router();

// POST / — create buy order
router.post('/', authenticate, requireScope('buy'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createBuyOrderSchema.parse(req.body);

    const buyOrder = await prisma.buyOrder.create({
      data: {
        agentId: req.agent!.id,
        searchQuery: data.searchQuery,
        maxPriceUsdc: BigInt(data.maxPriceUsdc),
        category: data.category || null,
        condition: data.condition || null,
        minSellerReputation: data.minSellerReputation || null,
        autoBuy: data.autoBuy,
        autoBuyMaxUsdc: data.autoBuyMaxUsdc ? BigInt(data.autoBuyMaxUsdc) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      },
    });

    logger.info('Buy order created', { buyOrderId: buyOrder.id, agentId: req.agent!.id });

    // Immediately check for matches
    const matches = await findMatchingListings(buyOrder.id);

    res.status(201).json({
      buyOrder: serializeBuyOrder(buyOrder),
      immediateMatches: matches.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET / — list my buy orders
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;

    const [buyOrders, total] = await Promise.all([
      prisma.buyOrder.findMany({
        where: { agentId: req.agent!.id },
        include: {
          matchedListing: {
            select: { id: true, title: true, priceUsdc: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.buyOrder.count({ where: { agentId: req.agent!.id } }),
    ]);

    res.json({
      buyOrders: buyOrders.map(serializeBuyOrder),
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

// PUT /:id — update buy order
router.put('/:id', authenticate, requireScope('buy'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = updateBuyOrderSchema.parse(req.body);

    const buyOrder = await prisma.buyOrder.findUnique({ where: { id } });
    if (!buyOrder) {
      throw new AppError('BUY_ORDER_NOT_FOUND', 'Buy order not found', 404);
    }

    if (buyOrder.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only update your own buy orders', 403);
    }

    const updateData: any = { ...data };
    if (data.maxPriceUsdc !== undefined) updateData.maxPriceUsdc = BigInt(data.maxPriceUsdc);
    if (data.autoBuyMaxUsdc !== undefined) {
      updateData.autoBuyMaxUsdc = data.autoBuyMaxUsdc ? BigInt(data.autoBuyMaxUsdc) : null;
    }
    if (data.expiresAt !== undefined) {
      updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    }

    const updated = await prisma.buyOrder.update({
      where: { id },
      data: updateData,
    });

    res.json({ buyOrder: serializeBuyOrder(updated) });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — cancel buy order
router.delete('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const buyOrder = await prisma.buyOrder.findUnique({ where: { id } });
    if (!buyOrder) {
      throw new AppError('BUY_ORDER_NOT_FOUND', 'Buy order not found', 404);
    }

    if (buyOrder.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only cancel your own buy orders', 403);
    }

    await prisma.buyOrder.update({
      where: { id },
      data: { status: 'expired' },
    });

    logger.info('Buy order cancelled', { buyOrderId: id });
    res.json({ message: 'Buy order cancelled' });
  } catch (err) {
    next(err);
  }
});

// GET /:id/matches — get matching listings
router.get('/:id/matches', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const buyOrder = await prisma.buyOrder.findUnique({ where: { id } });
    if (!buyOrder) {
      throw new AppError('BUY_ORDER_NOT_FOUND', 'Buy order not found', 404);
    }

    if (buyOrder.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only view matches for your own buy orders', 403);
    }

    const matches = await findMatchingListings(buyOrder.id);

    res.json({
      buyOrderId: id,
      matches: matches.map((m: any) => ({
        ...m,
        priceUsdc: m.priceUsdc?.toString(),
        priceSol: m.priceSol?.toString() || null,
      })),
      total: matches.length,
    });
  } catch (err) {
    next(err);
  }
});

function serializeBuyOrder(bo: any) {
  return {
    ...bo,
    maxPriceUsdc: bo.maxPriceUsdc?.toString(),
    autoBuyMaxUsdc: bo.autoBuyMaxUsdc?.toString() || null,
    matchedListing: bo.matchedListing
      ? {
          ...bo.matchedListing,
          priceUsdc: bo.matchedListing.priceUsdc?.toString(),
        }
      : null,
  };
}

export default router;
