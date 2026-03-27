import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createOrderSchema, fulfillOrderSchema, disputeOrderSchema, listOrdersSchema, handoffSchema, type ShippingAddress } from '../validators/orders';
import { uuidParamSchema } from '../validators/common';
import { createEscrow, releaseEscrow, refundEscrow, openDisputeOnChain, determineTier } from '../services/escrow';
import { dispatchWebhook } from '../services/webhook';
import { validatePurchase } from '../services/spendingPolicy';
import { recordCleanTransaction } from '../services/rating';
import { meetsMinimumRating, getAgentRatings } from '../services/rating';
import {
  calculateCollateral,
  validateCollateral,
  getAgentTier,
  getCollateralStatus,
  estimateCollateral,
} from '../services/collateral';
import { logger } from '../utils/logger';
import { validateOrderPrice } from '../services/trustTier';
import { sanitizeText } from '../utils/sanitize';
import {
  emitOrderCreated,
  emitOrderShipped,
  emitOrderCompleted,
  emitMeetupScheduled,
  emitItemHandedOver,
} from '../services/events';

const COOLING_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours

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

    // Check minimum buyer rating if seller set one
    if (listing.minimumBuyerRating !== null && listing.minimumBuyerRating !== undefined) {
      const buyerRatings = await getAgentRatings(req.agent!.id);
      if (!meetsMinimumRating(buyerRatings.buyerRating, listing.minimumBuyerRating)) {
        const ratingDisplay = buyerRatings.buyerRating === null
          ? 'N/A (no completed purchases yet)'
          : buyerRatings.buyerRating.toFixed(1);
        throw new AppError(
          'BUYER_RATING_TOO_LOW',
          `This seller requires a minimum buyer rating of ${listing.minimumBuyerRating.toFixed(1)}★. ` +
          `Your buyer rating is ${ratingDisplay}. ` +
          (buyerRatings.buyerRating === null
            ? 'Complete purchases on other listings to build your buyer rating.'
            : 'Improve your rating by completing more transactions without disputes.'),
          403,
        );
      }
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

    // Build structured shipping info from the new shippingAddress field
    const shippingData: Prisma.InputJsonValue = data.shippingAddress
      ? (data.shippingAddress as unknown as Prisma.InputJsonValue)
      : (data.shippingInfo || Prisma.JsonNull) as Prisma.InputJsonValue;

    // If human approval is required, create order in pending_approval state
    if (policyCheck.requiresHumanApproval) {
      const pendingOrder = await prisma.order.create({
        data: {
          listingId: listing.id,
          buyerAgentId: req.agent!.id,
          sellerAgentId: listing.agentId,
          amountUsdc: listing.priceUsdc,
          status: 'pending_approval',
          shippingInfo: shippingData,
        },
        include: {
          listing: { select: { id: true, title: true, images: true } },
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
        order: serializeOrder(pendingOrder, { viewerAgentId: req.agent!.id }),
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

    // ── Snapshot settlement wallets at order creation ──────────────
    const getEffectiveAddress = (w: { address: string; changeEffectiveAt: Date | null; pendingAddress: string | null } | undefined): string | null => {
      if (!w) return null;
      if (w.changeEffectiveAt && w.changeEffectiveAt <= new Date() && w.pendingAddress) return w.pendingAddress;
      return w.address;
    };

    const [sellerWallets, buyerWallets] = await Promise.all([
      prisma.userWallet.findMany({ where: { agentId: listing.agentId } }),
      prisma.userWallet.findMany({ where: { agentId: req.agent!.id } }),
    ]);

    const sellerReleaseWallet = getEffectiveAddress(
      sellerWallets.find((w) => w.role === 'escrow_release'),
    ) || listing.agent.walletAddress;

    const buyerRefundWallet = getEffectiveAddress(
      buyerWallets.find((w) => w.role === 'escrow_refund'),
    ) || req.agent!.walletAddress;

    // ── Race condition guard: re-check listing availability inside transaction ──
    // Between the initial check and escrow creation, another buyer may have purchased.
    // We atomically decrement quantity to claim the item.
    let order: any;
    let escrow: Awaited<ReturnType<typeof createEscrow>>;

    try {
      // Create escrow first — if this fails, no order is created
      escrow = await createEscrow(
        req.agent!.walletAddress,
        listing.agent.walletAddress,
        listing.priceUsdc,
      );
    } catch (escrowErr) {
      // Classify escrow errors for the buyer
      const errMsg = escrowErr instanceof Error ? escrowErr.message : String(escrowErr);

      if (errMsg.includes('Insufficient USDC') || errMsg.includes('insufficient funds') || errMsg.includes('INSUFFICIENT_USDC')) {
        throw new AppError(
          'INSUFFICIENT_BUYER_FUNDS',
          'Your wallet has insufficient USDC to fund this escrow. ' +
          `Required: ${Number(listing.priceUsdc) + collateral.buyerCollateralUsdc} USDC (item + collateral).`,
          400,
        );
      }

      if (errMsg.includes('Insufficient SOL') || errMsg.includes('INSUFFICIENT_SOL')) {
        throw new AppError(
          'INSUFFICIENT_SOL',
          'Your wallet needs SOL to pay transaction fees. Fund your wallet with a small amount of SOL.',
          400,
        );
      }

      if (errMsg.includes('RPC') || errMsg.includes('timeout') || errMsg.includes('fetch failed')) {
        throw new AppError(
          'ESCROW_NETWORK_ERROR',
          'Unable to create escrow due to a network issue. Please try again in a few moments.',
          503,
        );
      }

      logger.error('Escrow creation failed', {
        listingId: listing.id,
        buyerId: req.agent!.id,
        error: errMsg,
      });

      throw new AppError(
        'ESCROW_CREATION_FAILED',
        'Failed to create escrow for this order. The order was not placed. Please try again.',
        500,
      );
    }

    // Escrow succeeded — now atomically create order + claim listing quantity
    try {
      order = await prisma.$transaction(async (tx) => {
        // Re-fetch listing inside transaction to guard against race conditions
        const freshListing = await tx.listing.findUnique({
          where: { id: data.listingId },
          select: { id: true, status: true, quantity: true },
        });

        if (!freshListing || freshListing.status !== 'active') {
          throw new AppError(
            'LISTING_UNAVAILABLE',
            'This listing is no longer available for purchase. It may have been sold or delisted.',
            409,
          );
        }

        if (freshListing.quantity < 1) {
          throw new AppError(
            'OUT_OF_STOCK',
            'This listing has been purchased by another buyer.',
            409,
          );
        }

        // Decrement quantity atomically
        await tx.listing.update({
          where: { id: data.listingId },
          data: { quantity: { decrement: 1 } },
        });

        // Create the order
        const newOrder = await tx.order.create({
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
            shippingInfo: shippingData,
            fulfillmentType: data.fulfillmentType,
            meetupTime: data.meetupTime ? new Date(data.meetupTime) : null,
            meetupArea: data.meetupArea || null,
            meetupStatus: data.fulfillmentType === 'local_meetup' ? 'scheduled' : null,
            sellerReleaseWallet,
            buyerRefundWallet,
          },
          include: {
            listing: { select: { id: true, title: true, images: true } },
            buyer: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
          },
        });

        // Create transaction record
        await tx.transaction.create({
          data: {
            orderId: newOrder.id,
            fromAgentId: req.agent!.id,
            toAgentId: null,
            amountUsdc: listing.priceUsdc,
            txSignature: escrow.txSignature,
            txType: 'escrow_fund',
            status: 'pending',
          },
        });

        return newOrder;
      });
    } catch (txErr) {
      // If the DB transaction failed but escrow was created, attempt refund
      if (escrow && escrow.escrowAddress && !escrow.txSignature.startsWith('STUB_')) {
        logger.warn('Order creation failed after escrow — attempting refund', {
          escrowAddress: escrow.escrowAddress,
          buyerWallet: req.agent!.walletAddress,
        });
        try {
          await refundEscrow(escrow.escrowAddress, req.agent!.walletAddress!);
          logger.info('Escrow refunded after failed order creation');
        } catch (refundErr) {
          logger.error('CRITICAL: Failed to refund escrow after order creation failure', {
            escrowAddress: escrow.escrowAddress,
            error: (refundErr as Error).message,
          });
          // This is a critical state — escrow funds are locked
          // The error thrown below will alert the buyer
        }
      }
      throw txErr;
    }

    logger.info('Order created', { orderId: order.id, listingId: listing.id });

    // Emit event notification to seller
    emitOrderCreated({
      sellerId: listing.agentId,
      buyerName: req.agent!.name,
      listingTitle: listing.title,
      amountUsdc: listing.priceUsdc,
      orderId: order.id,
      listingId: listing.id,
    });

    // Emit meetup-specific event if local_meetup
    if (data.fulfillmentType === 'local_meetup') {
      emitMeetupScheduled({
        sellerId: listing.agentId,
        buyerName: req.agent!.name,
        listingTitle: listing.title,
        meetupArea: data.meetupArea!,
        meetupTime: data.meetupTime,
        orderId: order.id,
        listingId: listing.id,
      });
    }

    dispatchWebhook('order.created', {
      orderId: order.id,
      listingId: listing.id,
      buyerId: req.agent!.id,
      sellerId: listing.agentId,
      amountUsdc: listing.priceUsdc.toString(),
      buyerCollateralUsdc: collateral.buyerCollateralUsdc.toString(),
      sellerCollateralUsdc: collateral.sellerCollateralUsdc.toString(),
      collateralRatio: collateral.collateralRatio,
      shippingAddress: data.shippingAddress || null,
      item: {
        id: listing.id,
        title: listing.title,
        description: listing.description,
        category: listing.category,
        condition: listing.condition,
        images: listing.images,
      },
    }).catch(() => {});

    res.status(201).json({ order: serializeOrder(order, { viewerAgentId: req.agent!.id }) });
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
      orders: orders.map((o) => serializeOrder(o, { viewerAgentId: req.agent!.id })),
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

    res.json({ order: serializeOrder(order, { viewerAgentId: req.agent!.id }) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/fulfill — seller marks fulfilled
router.post('/:id/fulfill', authenticate, requireScope('sell'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = fulfillOrderSchema.parse(req.body);

    const order = await prisma.order.findUnique({
      where: { id },
      include: { listing: { select: { id: true, title: true } } },
    });
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

    // Notify buyer that order has shipped
    emitOrderShipped({
      buyerId: order.buyerAgentId,
      listingTitle: (order as any).listing?.title || 'your item',
      trackingNumber: data.trackingNumber,
      orderId: id,
    });

    dispatchWebhook('order.fulfilled', {
      orderId: id,
      sellerId: req.agent!.id,
      trackingNumber: data.trackingNumber,
    }).catch(() => {});

    logger.info('Order fulfilled', { orderId: id });
    res.json({ order: serializeOrder(updated, { viewerAgentId: req.agent!.id }) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/handoff — seller marks item handed over (local_meetup)
router.post('/:id/handoff', authenticate, requireScope('sell'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = handoffSchema.parse(req.body);

    const order = await prisma.order.findUnique({
      where: { id },
      include: { listing: { select: { id: true, title: true } } },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.sellerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only the seller can mark handoff for this order', 403);
    }

    if (order.fulfillmentType !== 'local_meetup') {
      throw new AppError('INVALID_FULFILLMENT_TYPE', 'Handoff is only available for local_meetup orders', 400);
    }

    // Idempotent: if already handed over, return existing state
    if (order.meetupStatus === 'seller_handed_over') {
      logger.info('Handoff already recorded (idempotent)', { orderId: id });
      return res.json({ order: serializeOrder(order, { viewerAgentId: req.agent!.id }), idempotent: true });
    }

    if (order.status !== 'created' && order.status !== 'funded') {
      throw new AppError('INVALID_STATUS', `Order cannot be handed off from status: ${order.status}`, 400);
    }

    const now = new Date();
    const coolingPeriodEndsAt = new Date(now.getTime() + COOLING_PERIOD_MS);

    const updated = await prisma.order.update({
      where: { id },
      data: {
        meetupStatus: 'seller_handed_over',
        handedOverAt: now,
        coolingPeriodEndsAt,
      },
    });

    // Notify buyer
    emitItemHandedOver({
      buyerId: order.buyerAgentId,
      listingTitle: (order as any).listing?.title || 'your item',
      orderId: id,
      coolingPeriodEndsAt: coolingPeriodEndsAt.toISOString(),
    });

    dispatchWebhook('order.handed_over', {
      orderId: id,
      sellerId: req.agent!.id,
      handedOverAt: now.toISOString(),
      coolingPeriodEndsAt: coolingPeriodEndsAt.toISOString(),
      notes: data.notes,
    }).catch(() => {});

    logger.info('Order handed over', { orderId: id, coolingPeriodEndsAt: coolingPeriodEndsAt.toISOString() });
    res.json({ order: serializeOrder(updated, { viewerAgentId: req.agent!.id }) });
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
      include: {
        seller: true,
        listing: { select: { id: true, title: true } },
      },
    });
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (order.buyerAgentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'Only the buyer can confirm this order', 403);
    }

    // Validate confirmation eligibility based on fulfillment type
    if (order.fulfillmentType === 'local_meetup') {
      // For local meetup: order must be created/funded AND seller must have marked handoff
      if (order.status !== 'created' && order.status !== 'funded') {
        throw new AppError('INVALID_STATUS', `Order cannot be confirmed from status: ${order.status}`, 400);
      }
      if (order.meetupStatus !== 'seller_handed_over') {
        throw new AppError('INVALID_STATUS', 'Seller must mark item as handed over before buyer can confirm', 400);
      }
      // Log if buyer confirms after cooling period expired (auto-release deadline passed)
      if (order.coolingPeriodEndsAt && new Date() > order.coolingPeriodEndsAt) {
        logger.warn('Buyer confirmed after cooling period expired', { orderId: id });
      }
    } else {
      // For shipped: existing behavior — status must be 'fulfilled'
      if (order.status !== 'fulfilled') {
        throw new AppError('INVALID_STATUS', `Order cannot be confirmed from status: ${order.status}`, 400);
      }
    }

    // Use snapshotted settlement wallet, fall back to live wallet
    const sellerWallet = order.sellerReleaseWallet || order.seller.walletAddress;
    if (!sellerWallet) {
      throw new AppError(
        'SELLER_NO_WALLET',
        'Seller has no release wallet configured',
        500,
      );
    }

    // Release escrow
    const releaseSig = await releaseEscrow(
      order.escrowAddress || '',
      sellerWallet,
    );

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'completed',
        resolvedAt: new Date(),
        ...(order.fulfillmentType === 'local_meetup' ? { meetupStatus: 'buyer_confirmed' } : {}),
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

    // Update buyer and seller ratings (clean transaction)
    await Promise.all([
      recordCleanTransaction(order.buyerAgentId, 'buyer'),
      recordCleanTransaction(order.sellerAgentId, 'seller'),
    ]);

    // Emit event notifications to both parties
    emitOrderCompleted({
      buyerId: order.buyerAgentId,
      sellerId: order.sellerAgentId,
      listingTitle: (order as any).listing?.title || 'Unknown item',
      orderId: id,
    });

    dispatchWebhook('order.completed', { orderId: id }).catch(() => {});
    dispatchWebhook('listing.sold', { listingId: order.listingId, orderId: id }).catch(() => {});

    logger.info('Order completed', { orderId: id });
    res.json({ order: serializeOrder(updated, { viewerAgentId: req.agent!.id }) });
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

    const sanitizedReason = sanitizeText(data.reason, 2000);

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: 'disputed',
        disputeReason: sanitizedReason,
      },
    });

    dispatchWebhook('order.disputed', { orderId: id, reason: data.reason }).catch(() => {});

    logger.info('Order disputed', { orderId: id });
    res.json({ order: serializeOrder(updated, { viewerAgentId: req.agent!.id }) });
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
      // Use snapshotted refund wallet, fall back to live wallet lookup
      let buyerWallet = order.buyerRefundWallet;
      if (!buyerWallet) {
        const buyer = await prisma.agent.findUnique({ where: { id: order.buyerAgentId } });
        buyerWallet = buyer?.walletAddress || null;
      }
      if (!buyerWallet) {
        throw new AppError(
          'BUYER_NO_WALLET',
          'Buyer has no wallet. Cannot process escrow refund without a valid buyer wallet.',
          400,
        );
      }
      const refundSig = await refundEscrow(order.escrowAddress, buyerWallet);
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
    res.json({ order: serializeOrder(updated, { viewerAgentId: req.agent!.id }) });
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

/**
 * Redact a shipping address to only city + country (for non-participant views).
 */
function redactShippingInfo(info: unknown): Record<string, unknown> | null {
  if (!info || typeof info !== 'object') return null;
  const addr = info as Record<string, unknown>;
  return {
    city: addr.city ?? null,
    country: addr.country ?? null,
  };
}

function serializeOrder(order: any, opts?: { viewerAgentId?: string }) {
  const isParticipant =
    opts?.viewerAgentId &&
    (order.buyerAgentId === opts.viewerAgentId || order.sellerAgentId === opts.viewerAgentId);

  const shippingInfo = isParticipant
    ? order.shippingInfo ?? null
    : redactShippingInfo(order.shippingInfo);

  return {
    ...order,
    shippingInfo,
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
