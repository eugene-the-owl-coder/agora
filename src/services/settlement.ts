/**
 * Settlement Executor — Idempotent escrow release/refund with retry logic.
 *
 * Wraps on-chain escrow operations with:
 * 1. Idempotency keys (orderId:txType) to prevent duplicate settlements
 * 2. Durable transaction tracking (pending → confirmed/failed)
 * 3. Retry up to MAX_RETRIES with error recording
 *
 * Callers should NOT create their own Transaction records — this service
 * handles the full lifecycle.
 */

import { prisma } from '../lib/prisma';
import { releaseEscrow, refundEscrow } from './escrow';
import { logger } from '../utils/logger';

const MAX_RETRIES = 3;

interface SettlementRequest {
  orderId: string;
  txType: 'escrow_release' | 'refund';
  escrowAddress: string;
  destinationWallet: string;
  amountUsdc: bigint;
  fromAgentId?: string | null;
  toAgentId?: string | null;
}

interface SettlementResult {
  txSignature: string;
  transactionId: string;
  wasIdempotent: boolean;
}

/**
 * Execute a settlement (release or refund) with idempotency and retry.
 *
 * Flow:
 * 1. Generate idempotency key: `${orderId}:${txType}`
 * 2. If a confirmed Transaction exists with this key → return it (dedup)
 * 3. If a failed/pending Transaction exists → retry (up to MAX_RETRIES)
 * 4. If no Transaction exists → create pending, then execute on-chain
 * 5. On success: update to confirmed with txSignature
 * 6. On failure: update with error message, increment retryCount
 */
export async function executeSettlement(req: SettlementRequest): Promise<SettlementResult> {
  const idempotencyKey = `${req.orderId}:${req.txType}`;

  // Check for existing settlement
  const existing = await prisma.transaction.findUnique({
    where: { idempotencyKey },
  });

  // Already confirmed — idempotent return
  if (existing?.status === 'confirmed' && existing.txSignature) {
    logger.info('Settlement already confirmed (idempotent)', { idempotencyKey });
    return {
      txSignature: existing.txSignature,
      transactionId: existing.id,
      wasIdempotent: true,
    };
  }

  // Create or reuse the pending transaction
  const tx = existing || await prisma.transaction.create({
    data: {
      orderId: req.orderId,
      fromAgentId: req.fromAgentId || null,
      toAgentId: req.toAgentId || null,
      amountUsdc: req.amountUsdc,
      txType: req.txType,
      status: 'pending',
      idempotencyKey,
      retryCount: 0,
    },
  });

  // Exhausted retries — bail out
  if (tx.retryCount >= MAX_RETRIES) {
    throw new Error(`Settlement exhausted ${MAX_RETRIES} retries for ${idempotencyKey}`);
  }

  // Execute the on-chain operation
  try {
    const txSignature = req.txType === 'escrow_release'
      ? await releaseEscrow(req.escrowAddress, req.destinationWallet)
      : await refundEscrow(req.escrowAddress, req.destinationWallet);

    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'confirmed',
        txSignature,
        lastAttemptAt: new Date(),
        retryCount: tx.retryCount + 1,
      },
    });

    logger.info('Settlement confirmed', { idempotencyKey, txSignature });
    return { txSignature, transactionId: tx.id, wasIdempotent: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'failed',
        errorMessage,
        lastAttemptAt: new Date(),
        retryCount: tx.retryCount + 1,
      },
    });

    logger.error('Settlement failed', {
      idempotencyKey,
      error: errorMessage,
      retryCount: tx.retryCount + 1,
    });

    throw err;
  }
}
