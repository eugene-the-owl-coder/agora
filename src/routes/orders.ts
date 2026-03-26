import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createOrderSchema, fulfillOrderSchema, disputeOrderSchema, listOrdersSchema } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';
import { createEscrow, releaseEscrow, refundEscrow, openDisputeOnChain, determineTier } from '../services/escrow';
import { dispatchWebhook } from '../services/webhook';
import { validatePurchase } from '../services/spendingPolicy';
import {
  calculateCollateral,
  validateCollateral,
  getAgentTier,
  getCollateralStatus,
  estimateCollateral,
} from '../services/collateral';
import { logger } from '../utils/logger';
import { validateOrderPrice } from '../services/trustTier';

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

    // Validate wallet presence before escrow
    if (!req.agent!.walletAddress) {
      throw new AppError(
        'BUYER_NO_WALLET',
        'Buyer has no wallet. Provision one via POST /api/v1/wallet/provision before placing orders.',
        400,
      );
    }

    if (!listing.agent.walletAddress) {
      throw new AppError(
        'SELLER_NO_WALLET',
        'Seller has no wallet configured. The seller must provision a wallet before their listings can be purchased.',
        400,
      );
    }

    // Spending policy enforcement
    const policyCheck = await validatePurchase(req.agent!.id, {
      amount: Number(listing.priceUsdc),
      category: listing.category,
      sellerId: listing.agentId,
    });

    if (!policyCheck.allowed) {
      throw new AppError(
        'SPENDING_POLICY_REJECTED',
        policyCheck.reason || 'Purchase blocked by spending policy',
        403,
      );
    }

    // If human approval is required, create order in pending_approval state
    if (policyCheck.requiresHumanApproval) {
      const pendingOrder = await prisma.order.create({
        data: {
          listingId: listing.id,
          buyerAgentId: req.agent!.id,
          sellerAgentId: listing.agentId,
          amountUsdc: listing.priceUsdc,
          status: 'pending_approval',
          shippingInfo: (data.shippingInfo || Prisma.JsonNull) as Prisma.InputJsonValue,
        },
        include: {
          listing: { select: { id: true, title: true } },
          buyer: { select: { id: true, name: true } },
          seller: { select: { id: true, name: true } },
        },
      });

      logger.info('Order pending human approval', {
        orderId: pendingOrder.id,
        listingId: listing.id,
        reason: 'Amount requires human approval per spending policy',
      });

      dispatchWebhook('order.pending_approval', {
        orderId: pendingOrder.id,
        listingId: listing.id,
        buyerId: req.agent!.id,
        sellerId: listing.agentId,
        amountUsdc: listing.priceUsdc.toString(),
        remainingBudget: policyCheck.remainingBudget?.toString(),
      }).catch(() => {});

      return res.status(201).json({
        order: serializeOrder(pendingOrder),
        pendingApproval: true,
        message: 'Order requires human approval before proceeding',
      });
    }

    // ── Trust Tier Price Enforcement ─────────────────────────────
    // Both buyer AND seller tiers are checked — the most restrictive applies.
    const tierPriceCheck = await validateOrderPrice(
      req.agent!.id,
      listing.agentId,
      Number(listing.priceUsdc),
    );
    if (!tierPriceCheck.allowed) {
      throw new AppError(
        'TIER_PRICE_EXCEEDED',
        tierPriceCheck.reason || 'Transaction price exceeds trust tier limit',
        403,
      );
    }

    // ── Collateral Enforcement ──────────────────────────────────
    // Both buyer and seller must stake collateral ≥ 100% of item price.
    // This makes fraud economically irrational.

    const [buyerTier, sellerTier] = await Promise.all([
      getAgentTier(req.agent!.id),
      getAgentTier(listing.agentId),
    ]);

    const collateral = calculateCollateral(
      Number(listing.priceUsdc),
      buyerTier,
      sellerTier,
    );

    logger.info('Collateral calculated', {
      listingId: listing.id,
      buyerTier,
      sellerTier,
      ratio: collateral.collateralRatio,
      buyerCollateral: collateral.buyerCollateralUsdc,
      sellerCollateral: collateral.sellerCollateralUsdc,
      totalEscrow: collateral.totalEscrowUsdc,
    });

    // Validate buyer has enough USDC for item price + collateral
    const buyerRequired = Number(listing.priceUsdc) + collateral.buyerCollateralUsdc;
    const buyerValidation = await validateCollateral(req.agent!.id, buyerRequired);
    if (!buyerValidation.sufficient) {
      throw new AppError(
        'INSUFFICIENT_BUYER_COLLATERAL',
        `Buyer needs ${buyerRequired} USDC (item: ${Number(listing.priceUsdc)}, collateral: ${collateral.buyerCollateralUsdc}) ` +
        `but only has ${buyerValidation.available}. Shortfall: ${buyerValidation.shortfall} USDC.`,
        400,
      );
    }

    // Validate seller has enough USDC for their collateral
    const sellerValidation = await validateCollateral(listing.agentId, collateral.sellerCollateralUsdc);
    if (!sellerValidation.sufficient) {
      throw new AppError(
        'INSUFFICIENT_SELLER_COLLATERAL',
        `Seller needs ${collateral.sellerCollateralUsdc} USDC collateral but only has ${sellerValidation.available}. ` +
        `The seller must fund their wallet before this listing can be purchased.`,
        400,
      );
    }

    // Create escrow (includes item price + both collaterals)
    const escrow = await createEscrow(
      req.agent!.walletAddress,
      listing.agent.walletAddress,
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
        buyerCollateralUsdc: BigInt(collateral.buyerCollateralUsdc),
        sellerCollateralUsdc: BigInt(collateral.sellerCollateralUsdc),
        collateralRatio: collateral.collateralRatio,
        status: 'created',
        shippingInfo: (data.shippingInfo || Prisma.JsonNull) as Prisma.InputJsonValue,
      },
      include: {
        listing: { select: { id: true, title: true } },
        buyer: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
      },
    });

    // Create transaction records for item price + collateral deposits
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
      buyerCollateralUsdc: collateral.buyerCollateralUsdc.toString(),
      sellerCollateralUsdc: collateral.sellerCollateralUsdc.toString(),
      collateralRatio: collateral.collateralRatio,
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
        dispute: {
          select: {
            id: true,
            reason: true,
            status: true,
            resolution: true,
            resolvedAt: true,
            createdAt: true,
          },
        },
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

    // Validate seller wallet before releasing escrow
    if (!order.seller.walletAddress) {
      throw new AppError(
        'SELLER_NO_WALLET',
        'Seller has no wallet. Cannot release escrow funds without a valid seller wallet.',
        400,
      );
    }

    // Release escrow
    const releaseSig = await releaseEscrow(
      order.escrowAddress || '',
      order.seller.walletAddress,
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
      // Look up buyer wallet for refund
      const buyer = await prisma.agent.findUnique({ where: { id: order.buyerAgentId } });
      if (!buyer?.walletAddress) {
        throw new AppError(
          'BUYER_NO_WALLET',
          'Buyer has no wallet. Cannot process escrow refund without a valid buyer wallet.',
          400,
        );
      }
      const refundSig = await refundEscrow(order.escrowAddress, buyer.walletAddress);
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

// GET /:id/collateral — collateral status for an order
router.get('/:id/collateral', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const order = await prisma.order.findUnique({
      where: { id },
      select: { buyerAgentId: true, sellerAgentId: true },
    });

    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.buyerAgentId !== req.agent!.id && order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only view collateral for your own orders', 403);
    }

    const status = await getCollateralStatus(id);
    if (!status) {
      throw new AppError('COLLATERAL_NOT_FOUND', 'Collateral data not found for this order', 404);
    }

    res.json({ collateral: status });
  } catch (err) {
    next(err);
  }
});

function serializeOrder(order: any) {
  return {
    ...order,
    amountUsdc: order.amountUsdc?.toString(),
    buyerCollateralUsdc: order.buyerCollateralUsdc?.toString() ?? null,
    sellerCollateralUsdc: order.sellerCollateralUsdc?.toString() ?? null,
    collateralRatio: order.collateralRatio ?? null,
    transactions: order.transactions?.map((tx: any) => ({
      ...tx,
      amountUsdc: tx.amountUsdc?.toString(),
      amountSol: tx.amountSol?.toString(),
    })),
  };
}

export default router;
