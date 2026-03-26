/**
 * Dispute Resolution Routes
 *
 * Mounted at /api/v1/orders — dispute sub-routes on individual orders.
 *
 * POST   /:id/dispute          — Open a dispute (buyer or seller)
 * GET    /:id/dispute          — Get dispute details (buyer, seller, or admin)
 * POST   /:id/dispute/evidence — Submit evidence (buyer or seller)
 * POST   /:id/dispute/resolve  — Resolve a dispute (admin only)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { openDisputeSchema, submitEvidenceSchema, resolveDisputeSchema } from '../validators/disputes';
import { openDisputeOnChain, refundEscrow, releaseEscrow } from '../services/escrow';
import { dispatchWebhook } from '../services/webhook';
import { calculateDisputeDistribution } from '../services/collateral';
import { logger } from '../utils/logger';

const router = Router();

// ── Helper: load order + verify party access ──────────────────────────────

async function loadOrderForDispute(orderId: string, agentId: string, requireAdmin = false) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      buyer: { select: { id: true, name: true, walletAddress: true } },
      seller: { select: { id: true, name: true, walletAddress: true } },
      dispute: {
        include: {
          evidence: {
            include: {
              submittedBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
          openedBy: { select: { id: true, name: true } },
          resolvedBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!order) {
    throw new AppError('ORDER_NOT_FOUND', 'Order not found', 404);
  }

  // Check the requesting agent for access
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  const permissions = Array.isArray(agent?.permissions) ? (agent.permissions as string[]) : [];
  const isAdmin = permissions.includes('admin');
  const isBuyer = order.buyerAgentId === agentId;
  const isSeller = order.sellerAgentId === agentId;

  if (requireAdmin && !isAdmin) {
    throw new AppError('FORBIDDEN', 'Only platform admins can resolve disputes', 403);
  }

  if (!isBuyer && !isSeller && !isAdmin) {
    throw new AppError('FORBIDDEN', 'You are not a party to this order', 403);
  }

  return { order, isBuyer, isSeller, isAdmin };
}

// ── POST /:id/dispute — Open a dispute ────────────────────────────────────

router.post(
  '/:id/dispute',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const data = openDisputeSchema.parse(req.body);
      const { order, isBuyer } = await loadOrderForDispute(id, req.agent!.id);

      // Validate order status — must be in an active shipping/delivery state
      const disputableStatuses = ['fulfilled', 'funded'];
      if (!disputableStatuses.includes(order.status)) {
        throw new AppError(
          'INVALID_STATUS',
          `Cannot open dispute on order with status: ${order.status}. Order must be in fulfilled or funded state.`,
          400,
        );
      }

      // Check for existing dispute
      if (order.dispute) {
        throw new AppError(
          'DISPUTE_EXISTS',
          'A dispute has already been opened for this order',
          409,
        );
      }

      // Determine the opener's wallet for on-chain call
      const openerWallet = isBuyer
        ? order.buyer.walletAddress
        : order.seller.walletAddress;

      // Call on-chain dispute instruction
      let disputeTxSignature: string | null = null;
      try {
        if (openerWallet) {
          disputeTxSignature = await openDisputeOnChain(
            order.id,
            openerWallet,
            data.reason,
          );
        }
      } catch (err) {
        logger.warn('On-chain dispute open failed (continuing with DB update)', {
          orderId: id,
          error: (err as Error).message,
        });
      }

      // Evidence deadline: 72 hours from now
      const evidenceDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000);

      // Create dispute + update order in a transaction
      const dispute = await prisma.$transaction(async (tx) => {
        // Create the dispute
        const newDispute = await tx.dispute.create({
          data: {
            orderId: id,
            openedById: req.agent!.id,
            reason: data.reason,
            description: data.description,
            disputeTxSignature,
            evidenceDeadline,
          },
          include: {
            openedBy: { select: { id: true, name: true } },
            evidence: true,
          },
        });

        // If opener provided initial evidence URLs, store them
        if (data.evidence && data.evidence.length > 0) {
          await tx.disputeEvidence.create({
            data: {
              disputeId: newDispute.id,
              submittedById: req.agent!.id,
              description: 'Initial evidence submitted with dispute',
              urls: data.evidence,
              type: 'other',
            },
          });
        }

        // Update order status to disputed
        await tx.order.update({
          where: { id },
          data: {
            status: 'disputed',
            disputeReason: data.reason,
          },
        });

        return newDispute;
      });

      dispatchWebhook('order.disputed', {
        orderId: id,
        disputeId: dispute.id,
        reason: data.reason,
        openedBy: req.agent!.id,
      }).catch(() => {});

      logger.info('Dispute opened', {
        orderId: id,
        disputeId: dispute.id,
        reason: data.reason,
        openedBy: req.agent!.id,
      });

      // Reload with evidence if initial evidence was added
      const fullDispute = await prisma.dispute.findUnique({
        where: { id: dispute.id },
        include: {
          openedBy: { select: { id: true, name: true } },
          evidence: {
            include: { submittedBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      res.status(201).json({ dispute: serializeDispute(fullDispute!) });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id/dispute — Get dispute details ────────────────────────────────

router.get(
  '/:id/dispute',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const { order } = await loadOrderForDispute(id, req.agent!.id);

      if (!order.dispute) {
        throw new AppError('NO_DISPUTE', 'No dispute found for this order', 404);
      }

      res.json({ dispute: serializeDispute(order.dispute) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/dispute/evidence — Submit evidence ─────────────────────────

router.post(
  '/:id/dispute/evidence',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const data = submitEvidenceSchema.parse(req.body);
      const { order } = await loadOrderForDispute(id, req.agent!.id);

      if (!order.dispute) {
        throw new AppError('NO_DISPUTE', 'No dispute found for this order', 404);
      }

      if (order.dispute.status === 'resolved') {
        throw new AppError(
          'DISPUTE_RESOLVED',
          'Cannot submit evidence for a resolved dispute',
          400,
        );
      }

      const evidence = await prisma.disputeEvidence.create({
        data: {
          disputeId: order.dispute.id,
          submittedById: req.agent!.id,
          description: data.description,
          urls: data.urls || [],
          type: data.type,
        },
        include: {
          submittedBy: { select: { id: true, name: true } },
        },
      });

      // Update dispute status to evidence_review if still open
      if (order.dispute.status === 'open') {
        await prisma.dispute.update({
          where: { id: order.dispute.id },
          data: { status: 'evidence_review' },
        });
      }

      logger.info('Dispute evidence submitted', {
        orderId: id,
        disputeId: order.dispute.id,
        evidenceId: evidence.id,
        submittedBy: req.agent!.id,
      });

      res.status(201).json({ evidence: serializeEvidence(evidence) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/dispute/resolve — Resolve a dispute (admin only) ───────────

router.post(
  '/:id/dispute/resolve',
  authenticate,
  requireScope('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const data = resolveDisputeSchema.parse(req.body);
      const { order } = await loadOrderForDispute(id, req.agent!.id, true);

      if (!order.dispute) {
        throw new AppError('NO_DISPUTE', 'No dispute found for this order', 404);
      }

      if (order.dispute.status === 'resolved') {
        throw new AppError('ALREADY_RESOLVED', 'This dispute has already been resolved', 400);
      }

      // Calculate collateral distribution
      const buyerCollateral = Number(order.buyerCollateralUsdc ?? 0);
      const sellerCollateral = Number(order.sellerCollateralUsdc ?? 0);
      const itemPrice = Number(order.amountUsdc);

      if (buyerCollateral > 0 || sellerCollateral > 0) {
        const distribution = calculateDisputeDistribution(
          data.resolution,
          buyerCollateral,
          sellerCollateral,
          itemPrice,
        );
        logger.info('Dispute collateral distribution calculated', {
          orderId: id,
          resolution: data.resolution,
          buyerReceives: distribution.buyerReceives,
          sellerReceives: distribution.sellerReceives,
          platformReceives: distribution.platformReceives,
          description: distribution.description,
        });
      }

      // Execute the resolution on-chain
      let resolutionTxSignature: string | null = null;
      const escrowAddress = order.escrowAddress || '';
      const buyerWallet = order.buyer.walletAddress || '';
      const sellerWallet = order.seller.walletAddress || '';

      try {
        switch (data.resolution) {
          case 'full_refund': {
            if (!buyerWallet) {
              throw new AppError('BUYER_NO_WALLET', 'Buyer has no wallet for refund', 400);
            }
            resolutionTxSignature = await refundEscrow(escrowAddress, buyerWallet, order.id);
            break;
          }

          case 'release_to_seller': {
            if (!sellerWallet) {
              throw new AppError('SELLER_NO_WALLET', 'Seller has no wallet for release', 400);
            }
            resolutionTxSignature = await releaseEscrow(escrowAddress, sellerWallet, order.id);
            break;
          }

          case 'partial_refund': {
            // MVP: For partial refund, issue a full refund on-chain.
            // Platform handles the partial manually or via a future split instruction.
            if (!buyerWallet) {
              throw new AppError('BUYER_NO_WALLET', 'Buyer has no wallet for refund', 400);
            }
            if (!data.refundAmount) {
              throw new AppError('MISSING_AMOUNT', 'refundAmount is required for partial_refund', 400);
            }
            resolutionTxSignature = await refundEscrow(escrowAddress, buyerWallet, order.id);
            logger.info('Partial refund: full on-chain refund executed. Manual seller payment needed.', {
              orderId: id,
              refundAmount: data.refundAmount,
              orderAmount: order.amountUsdc.toString(),
            });
            break;
          }

          case 'split': {
            // MVP: Split = refund to buyer on-chain, then manually pay seller their portion.
            if (!buyerWallet) {
              throw new AppError('BUYER_NO_WALLET', 'Buyer has no wallet for split', 400);
            }
            resolutionTxSignature = await refundEscrow(escrowAddress, buyerWallet, order.id);
            logger.info('Split resolution: full on-chain refund executed. Manual seller portion needed.', {
              orderId: id,
              refundAmount: data.refundAmount,
              orderAmount: order.amountUsdc.toString(),
            });
            break;
          }
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error('On-chain resolution failed', {
          orderId: id,
          resolution: data.resolution,
          error: (err as Error).message,
        });
        throw new AppError(
          'RESOLUTION_FAILED',
          `On-chain resolution failed: ${(err as Error).message}`,
          500,
        );
      }

      // Determine final order status
      const finalOrderStatus =
        data.resolution === 'release_to_seller' ? 'completed' : 'refunded';

      // Update dispute + order in a transaction
      const updatedDispute = await prisma.$transaction(async (tx) => {
        const resolved = await tx.dispute.update({
          where: { id: order.dispute!.id },
          data: {
            status: 'resolved',
            resolution: data.resolution,
            resolvedById: req.agent!.id,
            resolvedAt: new Date(),
            resolutionNotes: data.notes,
            refundAmount: data.refundAmount ? BigInt(data.refundAmount) : null,
            resolutionTxSignature,
          },
          include: {
            openedBy: { select: { id: true, name: true } },
            resolvedBy: { select: { id: true, name: true } },
            evidence: {
              include: { submittedBy: { select: { id: true, name: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        });

        await tx.order.update({
          where: { id },
          data: {
            status: finalOrderStatus,
            resolvedAt: new Date(),
          },
        });

        // Record the resolution transaction
        if (resolutionTxSignature) {
          const txType =
            data.resolution === 'release_to_seller' ? 'escrow_release' : 'refund';
          const toAgentId =
            data.resolution === 'release_to_seller'
              ? order.sellerAgentId
              : order.buyerAgentId;

          await tx.transaction.create({
            data: {
              orderId: id,
              fromAgentId: null,
              toAgentId,
              amountUsdc: data.refundAmount
                ? BigInt(data.refundAmount)
                : order.amountUsdc,
              txSignature: resolutionTxSignature,
              txType: txType as any,
              status: 'confirmed',
            },
          });
        }

        return resolved;
      });

      dispatchWebhook('order.disputed', {
        orderId: id,
        disputeId: updatedDispute.id,
        resolution: data.resolution,
        resolvedBy: req.agent!.id,
      }).catch(() => {});

      logger.info('Dispute resolved', {
        orderId: id,
        disputeId: updatedDispute.id,
        resolution: data.resolution,
        resolvedBy: req.agent!.id,
      });

      res.json({ dispute: serializeDispute(updatedDispute) });
    } catch (err) {
      next(err);
    }
  },
);

// ── Serialization ─────────────────────────────────────────────────────────

function serializeDispute(dispute: any) {
  return {
    id: dispute.id,
    orderId: dispute.orderId,
    openedBy: dispute.openedBy,
    reason: dispute.reason,
    description: dispute.description,
    status: dispute.status,
    resolution: dispute.resolution,
    resolvedBy: dispute.resolvedBy,
    resolvedAt: dispute.resolvedAt?.toISOString() || null,
    resolutionNotes: dispute.resolutionNotes,
    refundAmount: dispute.refundAmount?.toString() || null,
    disputeTxSignature: dispute.disputeTxSignature,
    resolutionTxSignature: dispute.resolutionTxSignature,
    evidenceDeadline: dispute.evidenceDeadline?.toISOString() || null,
    flaggedAt: dispute.flaggedAt?.toISOString() || null,
    flagReason: dispute.flagReason,
    evidence: dispute.evidence?.map(serializeEvidence) || [],
    createdAt: dispute.createdAt?.toISOString(),
    updatedAt: dispute.updatedAt?.toISOString(),
  };
}

function serializeEvidence(evidence: any) {
  return {
    id: evidence.id,
    disputeId: evidence.disputeId,
    submittedBy: evidence.submittedBy,
    description: evidence.description,
    urls: evidence.urls,
    type: evidence.type,
    createdAt: evidence.createdAt?.toISOString(),
  };
}

export default router;
