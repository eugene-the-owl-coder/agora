import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  startNegotiationSchema,
  negotiationMessageSchema,
  counterPayloadSchema,
  listNegotiationsSchema,
  payloadValidators,
} from '../validators/negotiations';
import { uuidParamSchema } from '../validators/common';
import { dispatchWebhook } from '../services/webhook';
import { validatePurchase } from '../services/spendingPolicy';
import { logger } from '../utils/logger';
import { validateOrderPrice, getAgentTier as getTrustTierInfo } from '../services/trustTier';

const router = Router();

// ─── Helper: dispatch webhook to the OTHER party ────────────────────

async function dispatchNegotiationWebhook(
  targetAgentId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  // Find active webhooks for the target agent subscribed to this event
  const webhooks = await prisma.webhook.findMany({
    where: {
      agentId: targetAgentId,
      isActive: true,
      events: { has: event },
    },
  });

  if (webhooks.length === 0) {
    // Fall back to global webhook dispatch (broadcasts to all matching)
    dispatchWebhook(event, data).catch(() => {});
    return;
  }

  // Dispatch to each of the target agent's webhooks
  dispatchWebhook(event, data).catch(() => {});
}

// ─── Helper: auto-accept logic ─────────────────────────────────────

async function checkAutoAccept(
  negotiationId: string,
  listingId: string,
  offeredPrice: number,
  offeringAgentId: string,
): Promise<boolean> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { metadata: true, agentId: true, quantity: true },
  });

  if (!listing) return false;

  const metadata = listing.metadata as Record<string, unknown>;
  const autoAcceptBelow = metadata?.autoAcceptBelow;

  if (typeof autoAcceptBelow !== 'number') return false;

  // If offer meets or exceeds the auto-accept threshold
  if (offeredPrice >= autoAcceptBelow) {
    // ── Security: Check listing quantity ──────────────────────────
    // If the listing tracks quantity and it's exhausted, reject the offer
    if (typeof listing.quantity === 'number' && listing.quantity <= 0) {
      logger.info('Auto-accept skipped: listing quantity exhausted', {
        negotiationId,
        listingId,
        quantity: listing.quantity,
      });

      // Auto-reject the offer since inventory is gone
      const negotiation = await prisma.negotiation.findUnique({
        where: { id: negotiationId },
        select: { buyerAgentId: true, sellerAgentId: true },
      });
      if (negotiation) {
        const rejectingAgentId =
          offeringAgentId === negotiation.buyerAgentId
            ? negotiation.sellerAgentId
            : negotiation.buyerAgentId;

        await prisma.negotiationMessage.create({
          data: {
            negotiationId,
            fromAgentId: rejectingAgentId,
            type: 'REJECT',
            payload: { autoRejected: true, reason: 'listing_quantity_exhausted' },
          },
        });
        await prisma.negotiation.update({
          where: { id: negotiationId },
          data: { status: 'rejected' },
        });
      }
      return false;
    }

    // ── Security: Daily auto-accept limit ────────────────────────
    // Prevent a malicious agent from flooding offers below threshold to drain inventory
    const autoAcceptMaxDaily =
      typeof metadata?.autoAcceptMaxDaily === 'number'
        ? metadata.autoAcceptMaxDaily
        : 10; // default: 10 per day

    // Count auto-accepts today for this listing's seller
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const autoAcceptCountToday = await prisma.negotiationMessage.count({
      where: {
        type: 'ACCEPT',
        payload: {
          path: ['autoAccepted'],
          equals: true,
        },
        createdAt: { gte: todayStart },
        negotiation: {
          listingId,
          sellerAgentId: listing.agentId,
        },
      },
    });

    if (autoAcceptCountToday >= autoAcceptMaxDaily) {
      logger.info('Auto-accept skipped: daily limit reached', {
        negotiationId,
        listingId,
        autoAcceptCountToday,
        autoAcceptMaxDaily,
      });
      // Leave the offer pending for human review — do not auto-accept
      return false;
    }

    // ── Proceed with auto-accept ─────────────────────────────────
    // Determine who should auto-accept (the party that didn't make the offer)
    const negotiation = await prisma.negotiation.findUnique({
      where: { id: negotiationId },
      select: { buyerAgentId: true, sellerAgentId: true },
    });

    if (!negotiation) return false;

    // ── Trust Tier check before auto-accept ─────────────────────
    const autoAcceptTierCheck = await validateOrderPrice(
      negotiation.buyerAgentId,
      negotiation.sellerAgentId,
      offeredPrice,
    );
    if (!autoAcceptTierCheck.allowed) {
      logger.info('Auto-accept skipped: trust tier price limit exceeded', {
        negotiationId,
        listingId,
        reason: autoAcceptTierCheck.reason,
      });
      return false;
    }

    // ── Spending policy check for buyer ──────────────────────────
    // Before auto-accepting, verify the buyer's spending policy allows this purchase
    const buyerPolicyCheck = await validatePurchase(negotiation.buyerAgentId, {
      amount: offeredPrice,
      sellerId: negotiation.sellerAgentId,
    });

    if (!buyerPolicyCheck.allowed) {
      logger.info('Auto-accept skipped: buyer spending policy rejected', {
        negotiationId,
        listingId,
        buyerAgentId: negotiation.buyerAgentId,
        reason: buyerPolicyCheck.reason,
      });
      return false;
    }

    if (buyerPolicyCheck.requiresHumanApproval) {
      logger.info('Auto-accept skipped: buyer spending policy requires human approval', {
        negotiationId,
        listingId,
        buyerAgentId: negotiation.buyerAgentId,
      });
      return false;
    }

    const acceptingAgentId =
      offeringAgentId === negotiation.buyerAgentId
        ? negotiation.sellerAgentId
        : negotiation.buyerAgentId;

    // Create auto-ACCEPT message
    await prisma.negotiationMessage.create({
      data: {
        negotiationId,
        fromAgentId: acceptingAgentId,
        type: 'ACCEPT',
        payload: { autoAccepted: true },
      },
    });

    // Update negotiation status
    await prisma.negotiation.update({
      where: { id: negotiationId },
      data: { status: 'accepted' },
    });

    // Create the order
    await createOrderFromNegotiation(negotiationId, offeredPrice);

    logger.info('Negotiation auto-accepted', {
      negotiationId,
      offeredPrice,
      autoAcceptBelow,
      autoAcceptCountToday: autoAcceptCountToday + 1,
      autoAcceptMaxDaily,
    });

    return true;
  }

  return false;
}

// ─── Helper: create order from accepted negotiation ────────────────

async function createOrderFromNegotiation(
  negotiationId: string,
  agreedPrice: number,
): Promise<void> {
  const negotiation = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    include: {
      listing: true,
      buyerAgent: true,
      sellerAgent: true,
    },
  });

  if (!negotiation) return;

  await prisma.order.create({
    data: {
      listingId: negotiation.listingId,
      buyerAgentId: negotiation.buyerAgentId,
      sellerAgentId: negotiation.sellerAgentId,
      amountUsdc: BigInt(agreedPrice),
      status: 'created',
    },
  });

  logger.info('Order created from negotiation', {
    negotiationId,
    listingId: negotiation.listingId,
    agreedPrice,
  });

  dispatchWebhook('order.created', {
    negotiationId,
    listingId: negotiation.listingId,
    buyerId: negotiation.buyerAgentId,
    sellerId: negotiation.sellerAgentId,
    amountUsdc: agreedPrice.toString(),
    source: 'negotiation',
  }).catch(() => {});
}

// ─── POST /api/v1/listings/:id/negotiate — Start negotiation ───────

router.post(
  '/listings/:id/negotiate',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: listingId } = uuidParamSchema.parse(req.params);
      const data = startNegotiationSchema.parse(req.body);

      // Validate listing exists and is active
      const listing = await prisma.listing.findUnique({
        where: { id: listingId },
        include: { agent: true },
      });

      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }

      if (listing.status !== 'active') {
        throw new AppError(
          'LISTING_UNAVAILABLE',
          'This listing is not available for negotiation',
          400,
        );
      }

      // Buyer cannot be the seller
      if (listing.agentId === req.agent!.id) {
        throw new AppError(
          'SELF_NEGOTIATION',
          'Cannot negotiate on your own listing',
          400,
        );
      }

      // ── Trust Tier: check buyer's tier allows the offer price ──
      const tierCheck = await validateOrderPrice(
        req.agent!.id,
        listing.agentId,
        data.amount,
      );
      if (!tierCheck.allowed) {
        throw new AppError(
          'TIER_PRICE_EXCEEDED',
          tierCheck.reason || 'Offer price exceeds trust tier limit',
          403,
        );
      }

      // Check for duplicate active negotiation
      const existing = await prisma.negotiation.findFirst({
        where: {
          listingId,
          buyerAgentId: req.agent!.id,
          status: 'active',
        },
      });

      if (existing) {
        throw new AppError(
          'DUPLICATE_NEGOTIATION',
          'You already have an active negotiation for this listing',
          409,
        );
      }

      // Create negotiation + first OFFER message in a transaction
      const negotiation = await prisma.$transaction(async (tx) => {
        const neg = await tx.negotiation.create({
          data: {
            listingId,
            buyerAgentId: req.agent!.id,
            sellerAgentId: listing.agentId,
            status: 'active',
            currentPrice: data.amount,
          },
          include: {
            listing: { select: { id: true, title: true } },
            buyerAgent: { select: { id: true, name: true } },
            sellerAgent: { select: { id: true, name: true } },
          },
        });

        await tx.negotiationMessage.create({
          data: {
            negotiationId: neg.id,
            fromAgentId: req.agent!.id,
            type: 'OFFER',
            payload: {
              amount: data.amount,
              currency: data.currency,
              message: data.message,
              shippingMethod: data.shippingMethod,
            },
          },
        });

        return neg;
      });

      logger.info('Negotiation started', {
        negotiationId: negotiation.id,
        listingId,
        buyerAgentId: req.agent!.id,
        offerAmount: data.amount,
      });

      // Dispatch webhook to seller
      dispatchNegotiationWebhook(listing.agentId, 'negotiation.message', {
        negotiation_id: negotiation.id,
        message_type: 'OFFER',
        from_agent: req.agent!.id,
        listing_id: listingId,
        amount: data.amount,
      }).catch(() => {});

      // Check auto-accept
      const autoAccepted = await checkAutoAccept(
        negotiation.id,
        listingId,
        data.amount,
        req.agent!.id,
      );

      // Refetch if auto-accepted to get updated status
      const result = autoAccepted
        ? await prisma.negotiation.findUnique({
            where: { id: negotiation.id },
            include: {
              listing: { select: { id: true, title: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          })
        : await prisma.negotiation.findUnique({
            where: { id: negotiation.id },
            include: {
              listing: { select: { id: true, title: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

      res.status(201).json({
        negotiation: result,
        autoAccepted,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/negotiations — List my negotiations ───────────────

router.get(
  '/negotiations',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const params = listNegotiationsSchema.parse(req.query);
      const skip = (params.page - 1) * params.limit;

      const where: Prisma.NegotiationWhereInput = {};

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

      if (params.listingId) {
        where.listingId = params.listingId;
      }

      const [negotiations, total] = await Promise.all([
        prisma.negotiation.findMany({
          where,
          include: {
            listing: { select: { id: true, title: true, priceUsdc: true } },
            buyerAgent: { select: { id: true, name: true } },
            sellerAgent: { select: { id: true, name: true } },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
          orderBy: { updatedAt: 'desc' },
          skip,
          take: params.limit,
        }),
        prisma.negotiation.count({ where }),
      ]);

      res.json({
        negotiations: negotiations.map(serializeNegotiation),
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
  },
);

// ─── GET /api/v1/negotiations/:id — Negotiation details ────────────

router.get(
  '/negotiations/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);

      const negotiation = await prisma.negotiation.findUnique({
        where: { id },
        include: {
          listing: {
            select: { id: true, title: true, priceUsdc: true, images: true },
          },
          buyerAgent: { select: { id: true, name: true } },
          sellerAgent: { select: { id: true, name: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              fromAgent: { select: { id: true, name: true } },
            },
          },
        },
      });

      if (!negotiation) {
        throw new AppError('NEGOTIATION_NOT_FOUND', 'Negotiation not found', 404);
      }

      // Only buyer or seller can view
      if (
        negotiation.buyerAgentId !== req.agent!.id &&
        negotiation.sellerAgentId !== req.agent!.id
      ) {
        throw new AppError(
          'FORBIDDEN',
          'You can only view negotiations you are a party to',
          403,
        );
      }

      res.json({ negotiation: serializeNegotiation(negotiation) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/negotiations/:id/message — Send message ─────────

router.post(
  '/negotiations/:id/message',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const data = negotiationMessageSchema.parse(req.body);

      const negotiation = await prisma.negotiation.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          listing: { select: { id: true, metadata: true, agentId: true } },
        },
      });

      if (!negotiation) {
        throw new AppError('NEGOTIATION_NOT_FOUND', 'Negotiation not found', 404);
      }

      // Must be a party to this negotiation
      if (
        negotiation.buyerAgentId !== req.agent!.id &&
        negotiation.sellerAgentId !== req.agent!.id
      ) {
        throw new AppError(
          'FORBIDDEN',
          'You can only send messages in negotiations you are a party to',
          403,
        );
      }

      // Negotiation must be active
      if (negotiation.status !== 'active') {
        throw new AppError(
          'NEGOTIATION_CLOSED',
          `Negotiation is ${negotiation.status}, no further messages allowed`,
          400,
        );
      }

      // Validate type-specific payload
      const payloadValidator = payloadValidators[data.type];
      if (payloadValidator) {
        payloadValidator.parse(data.payload);
      }

      // Type-specific business logic
      const lastMessage = negotiation.messages[0];

      switch (data.type) {
        case 'COUNTER': {
          const counterData = counterPayloadSchema.parse(data.payload);

          // ── Trust Tier: validate counter price against both tiers ──
          const counterTierCheck = await validateOrderPrice(
            negotiation.buyerAgentId,
            negotiation.sellerAgentId,
            counterData.amount,
          );
          if (!counterTierCheck.allowed) {
            throw new AppError(
              'TIER_PRICE_EXCEEDED',
              counterTierCheck.reason || 'Counter price exceeds trust tier limit',
              403,
            );
          }

          // COUNTER can only be sent by the party who did NOT send the last OFFER/COUNTER
          if (lastMessage && lastMessage.fromAgentId === req.agent!.id) {
            const lastType = lastMessage.type;
            if (lastType === 'OFFER' || lastType === 'COUNTER') {
              throw new AppError(
                'INVALID_COUNTER',
                'You cannot counter your own offer. Wait for the other party to respond.',
                400,
              );
            }
          }

          // Create COUNTER message + update price
          const counterMsg = await prisma.$transaction(async (tx) => {
            const msg = await tx.negotiationMessage.create({
              data: {
                negotiationId: id,
                fromAgentId: req.agent!.id,
                type: 'COUNTER',
                payload: data.payload as Prisma.InputJsonValue,
              },
            });

            await tx.negotiation.update({
              where: { id },
              data: { currentPrice: counterData.amount },
            });

            return msg;
          });

          // Webhook to the other party
          const counterTarget =
            req.agent!.id === negotiation.buyerAgentId
              ? negotiation.sellerAgentId
              : negotiation.buyerAgentId;

          dispatchNegotiationWebhook(counterTarget, 'negotiation.message', {
            negotiation_id: id,
            message_type: 'COUNTER',
            from_agent: req.agent!.id,
            listing_id: negotiation.listingId,
            amount: counterData.amount,
          }).catch(() => {});

          // Check auto-accept on counter
          const autoAccepted = await checkAutoAccept(
            id,
            negotiation.listingId,
            counterData.amount,
            req.agent!.id,
          );

          const updated = await prisma.negotiation.findUnique({
            where: { id },
            include: {
              listing: { select: { id: true, title: true, priceUsdc: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

          return res.json({
            negotiation: serializeNegotiation(updated),
            message: counterMsg,
            autoAccepted,
          });
        }

        case 'ACCEPT': {
          // Accept the current price
          if (!negotiation.currentPrice) {
            throw new AppError(
              'NO_PRICE',
              'No price has been offered yet',
              400,
            );
          }

          // ── Trust Tier: re-validate agreed price against both tiers ──
          const acceptTierCheck = await validateOrderPrice(
            negotiation.buyerAgentId,
            negotiation.sellerAgentId,
            negotiation.currentPrice,
          );
          if (!acceptTierCheck.allowed) {
            throw new AppError(
              'TIER_PRICE_EXCEEDED',
              acceptTierCheck.reason || 'Agreed price exceeds trust tier limit',
              403,
            );
          }

          const acceptResult = await prisma.$transaction(async (tx) => {
            const msg = await tx.negotiationMessage.create({
              data: {
                negotiationId: id,
                fromAgentId: req.agent!.id,
                type: 'ACCEPT',
                payload: data.payload as Prisma.InputJsonValue,
              },
            });

            await tx.negotiation.update({
              where: { id },
              data: { status: 'accepted' },
            });

            return msg;
          });

          // Create order
          await createOrderFromNegotiation(id, negotiation.currentPrice);

          // Webhook
          const acceptTarget =
            req.agent!.id === negotiation.buyerAgentId
              ? negotiation.sellerAgentId
              : negotiation.buyerAgentId;

          dispatchNegotiationWebhook(acceptTarget, 'negotiation.message', {
            negotiation_id: id,
            message_type: 'ACCEPT',
            from_agent: req.agent!.id,
            listing_id: negotiation.listingId,
          }).catch(() => {});

          const accepted = await prisma.negotiation.findUnique({
            where: { id },
            include: {
              listing: { select: { id: true, title: true, priceUsdc: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

          logger.info('Negotiation accepted', {
            negotiationId: id,
            acceptedBy: req.agent!.id,
            price: negotiation.currentPrice,
          });

          return res.json({
            negotiation: serializeNegotiation(accepted),
            message: acceptResult,
          });
        }

        case 'REJECT': {
          const rejectResult = await prisma.$transaction(async (tx) => {
            const msg = await tx.negotiationMessage.create({
              data: {
                negotiationId: id,
                fromAgentId: req.agent!.id,
                type: 'REJECT',
                payload: data.payload as Prisma.InputJsonValue,
              },
            });

            await tx.negotiation.update({
              where: { id },
              data: { status: 'rejected' },
            });

            return msg;
          });

          const rejectTarget =
            req.agent!.id === negotiation.buyerAgentId
              ? negotiation.sellerAgentId
              : negotiation.buyerAgentId;

          dispatchNegotiationWebhook(rejectTarget, 'negotiation.message', {
            negotiation_id: id,
            message_type: 'REJECT',
            from_agent: req.agent!.id,
            listing_id: negotiation.listingId,
          }).catch(() => {});

          logger.info('Negotiation rejected', {
            negotiationId: id,
            rejectedBy: req.agent!.id,
          });

          const rejected = await prisma.negotiation.findUnique({
            where: { id },
            include: {
              listing: { select: { id: true, title: true, priceUsdc: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

          return res.json({
            negotiation: serializeNegotiation(rejected),
            message: rejectResult,
          });
        }

        case 'WITHDRAW': {
          // Only buyer can withdraw
          if (req.agent!.id !== negotiation.buyerAgentId) {
            throw new AppError(
              'FORBIDDEN',
              'Only the buyer can withdraw from a negotiation',
              403,
            );
          }

          const withdrawResult = await prisma.$transaction(async (tx) => {
            const msg = await tx.negotiationMessage.create({
              data: {
                negotiationId: id,
                fromAgentId: req.agent!.id,
                type: 'WITHDRAW',
                payload: data.payload as Prisma.InputJsonValue,
              },
            });

            await tx.negotiation.update({
              where: { id },
              data: { status: 'withdrawn' },
            });

            return msg;
          });

          dispatchNegotiationWebhook(
            negotiation.sellerAgentId,
            'negotiation.message',
            {
              negotiation_id: id,
              message_type: 'WITHDRAW',
              from_agent: req.agent!.id,
              listing_id: negotiation.listingId,
            },
          ).catch(() => {});

          logger.info('Negotiation withdrawn', {
            negotiationId: id,
            withdrawnBy: req.agent!.id,
          });

          const withdrawn = await prisma.negotiation.findUnique({
            where: { id },
            include: {
              listing: { select: { id: true, title: true, priceUsdc: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

          return res.json({
            negotiation: serializeNegotiation(withdrawn),
            message: withdrawResult,
          });
        }

        case 'CLARIFY':
        case 'INSPECT':
        case 'ESCALATE_TO_HUMAN': {
          // Informational messages — don't change negotiation status or price
          const infoMsg = await prisma.negotiationMessage.create({
            data: {
              negotiationId: id,
              fromAgentId: req.agent!.id,
              type: data.type,
              payload: data.payload as Prisma.InputJsonValue,
            },
          });

          const infoTarget =
            req.agent!.id === negotiation.buyerAgentId
              ? negotiation.sellerAgentId
              : negotiation.buyerAgentId;

          dispatchNegotiationWebhook(infoTarget, 'negotiation.message', {
            negotiation_id: id,
            message_type: data.type,
            from_agent: req.agent!.id,
            listing_id: negotiation.listingId,
          }).catch(() => {});

          logger.info('Negotiation message sent', {
            negotiationId: id,
            type: data.type,
            from: req.agent!.id,
          });

          const updated = await prisma.negotiation.findUnique({
            where: { id },
            include: {
              listing: { select: { id: true, title: true, priceUsdc: true } },
              buyerAgent: { select: { id: true, name: true } },
              sellerAgent: { select: { id: true, name: true } },
              messages: { orderBy: { createdAt: 'asc' } },
            },
          });

          return res.json({
            negotiation: serializeNegotiation(updated),
            message: infoMsg,
          });
        }

        default:
          throw new AppError('INVALID_TYPE', `Unknown message type: ${data.type}`, 400);
      }
    } catch (err) {
      next(err);
    }
  },
);

// ─── Serializer ─────────────────────────────────────────────────────

function serializeNegotiation(negotiation: any) {
  if (!negotiation) return null;
  return {
    ...negotiation,
    listing: negotiation.listing
      ? {
          ...negotiation.listing,
          priceUsdc: negotiation.listing.priceUsdc?.toString(),
        }
      : negotiation.listing,
  };
}

export default router;
