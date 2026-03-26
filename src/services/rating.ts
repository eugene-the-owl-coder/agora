/**
 * Dual Rating System
 *
 * Every agent has two permanent ratings: buyerRating and sellerRating.
 * These are separate from the reputation score (0-100) in reputation.ts.
 *
 * Rating scale: 0.0 to 5.0
 * - null = N/A (no transactions in that role)
 * - First clean transaction → 5.0
 * - Subsequent clean transactions: EMA pulling toward 5.0
 *   newRating = oldRating * 0.95 + 5.0 * 0.05
 * - Dispute penalties are direct subtractions (clamped to 0.0)
 * - Inactivity decay: -0.1/month after 90 days
 */

import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { emitRatingUpdated } from './events';

// ─── Constants ──────────────────────────────────────────────────

const EMA_WEIGHT = 0.95; // Weight for current rating in EMA
const EMA_TARGET = 5.0;  // Target rating for clean transactions
const INITIAL_RATING = 5.0;

const DISPUTE_OPEN_PENALTY = 0.2;     // Provisional penalty for opening a dispute
const DISPUTE_WIN_BONUS = 0.1;        // Bonus for winning
const DISPUTE_OPEN_REFUND = 0.2;      // Refund of opening cost for winner
const DISPUTE_LOSE_ADDITIONAL = 0.5;  // Additional penalty for losing

const INACTIVITY_THRESHOLD_DAYS = 90;
const INACTIVITY_DECAY_PER_MONTH = 0.1;

const MIN_RATING = 0.0;
const MAX_RATING = 5.0;

// ─── Helpers ────────────────────────────────────────────────────

function clampRating(rating: number): number {
  return Math.round(Math.max(MIN_RATING, Math.min(MAX_RATING, rating)) * 100) / 100;
}

// ─── Clean Transaction ──────────────────────────────────────────

/**
 * Update rating after a clean (non-disputed) transaction completion.
 * First transaction in a role → 5.0
 * Subsequent → EMA pulling toward 5.0
 */
export async function recordCleanTransaction(
  agentId: string,
  role: 'buyer' | 'seller',
): Promise<void> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      buyerRating: true,
      sellerRating: true,
      buyerTxCount: true,
      sellerTxCount: true,
    },
  });

  if (!agent) {
    logger.warn('recordCleanTransaction: agent not found', { agentId });
    return;
  }

  const ratingField = role === 'buyer' ? 'buyerRating' : 'sellerRating';
  const countField = role === 'buyer' ? 'buyerTxCount' : 'sellerTxCount';
  const currentRating = role === 'buyer' ? agent.buyerRating : agent.sellerRating;

  let newRating: number;
  if (currentRating === null) {
    // First transaction in this role
    newRating = INITIAL_RATING;
  } else {
    // EMA: slowly pull toward 5.0
    newRating = clampRating(currentRating * EMA_WEIGHT + EMA_TARGET * (1 - EMA_WEIGHT));
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      [ratingField]: newRating,
      [countField]: { increment: 1 },
      lastTransactionAt: new Date(),
    },
  });

  // Emit rating event
  emitRatingUpdated({ agentId, role, newRating });

  logger.info('Rating updated (clean transaction)', {
    agentId,
    role,
    previousRating: currentRating,
    newRating,
  });
}

// ─── Dispute Outcome ────────────────────────────────────────────

/**
 * Update ratings after a dispute is resolved.
 *
 * When a dispute is opened, the opener gets -0.2 provisional.
 * Winner: +0.1 bonus + 0.2 refund of opening cost = net +0.1 from pre-dispute
 * Loser:  -0.2 stays + additional -0.5 = net -0.7 from pre-dispute
 *
 * The opener's -0.2 was already applied when the dispute was opened.
 * At resolution:
 *   - If opener won: they get +0.1 + 0.2 refund = +0.3 from current (net +0.1 from pre-dispute)
 *   - If opener lost: they get additional -0.5 (net -0.7 from pre-dispute)
 *   - Non-opener who won: +0.1
 *   - Non-opener who lost: -0.7 (full penalty since they didn't have the opening cost)
 */
export async function recordDisputeOpened(
  openerId: string,
  openerRole: 'buyer' | 'seller',
): Promise<void> {
  const agent = await prisma.agent.findUnique({
    where: { id: openerId },
    select: { buyerRating: true, sellerRating: true },
  });

  if (!agent) return;

  const ratingField = openerRole === 'buyer' ? 'buyerRating' : 'sellerRating';
  const currentRating = openerRole === 'buyer' ? agent.buyerRating : agent.sellerRating;

  if (currentRating === null) {
    // Agent has no rating yet — can't deduct. The dispute cost will be applied at resolution.
    return;
  }

  const newRating = clampRating(currentRating - DISPUTE_OPEN_PENALTY);

  await prisma.agent.update({
    where: { id: openerId },
    data: { [ratingField]: newRating },
  });

  logger.info('Rating updated (dispute opened)', {
    agentId: openerId,
    role: openerRole,
    previousRating: currentRating,
    newRating,
    penalty: DISPUTE_OPEN_PENALTY,
  });
}

export async function recordDisputeOutcome(params: {
  openerId: string;
  winnerId: string;
  loserId: string;
  openerRole: 'buyer' | 'seller';
}): Promise<void> {
  const { openerId, winnerId, loserId, openerRole } = params;

  // Determine roles: the opener's role is given.
  // The other party has the opposite role in this transaction.
  const loserRole = openerId === loserId ? openerRole : (openerRole === 'buyer' ? 'seller' : 'buyer');
  const winnerRole = openerId === winnerId ? openerRole : (openerRole === 'buyer' ? 'seller' : 'buyer');

  // Load both agents
  const [winner, loser] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: winnerId },
      select: { buyerRating: true, sellerRating: true },
    }),
    prisma.agent.findUnique({
      where: { id: loserId },
      select: { buyerRating: true, sellerRating: true },
    }),
  ]);

  if (!winner || !loser) {
    logger.warn('recordDisputeOutcome: agent not found', { winnerId, loserId });
    return;
  }

  // ── Winner adjustment ──
  const winnerRatingField = winnerRole === 'buyer' ? 'buyerRating' : 'sellerRating';
  const winnerCurrentRating = winnerRole === 'buyer' ? winner.buyerRating : winner.sellerRating;

  if (winnerCurrentRating !== null) {
    let winnerDelta: number;
    if (winnerId === openerId) {
      // Winner was the opener — they already lost 0.2 at open time
      // Refund 0.2 + bonus 0.1 = +0.3
      winnerDelta = DISPUTE_WIN_BONUS + DISPUTE_OPEN_REFUND;
    } else {
      // Winner was not the opener — just get bonus
      winnerDelta = DISPUTE_WIN_BONUS;
    }

    const newWinnerRating = clampRating(winnerCurrentRating + winnerDelta);
    await prisma.agent.update({
      where: { id: winnerId },
      data: { [winnerRatingField]: newWinnerRating },
    });

    logger.info('Rating updated (dispute winner)', {
      agentId: winnerId,
      role: winnerRole,
      previousRating: winnerCurrentRating,
      newRating: newWinnerRating,
      delta: winnerDelta,
    });
  }

  // ── Loser adjustment ──
  const loserRatingField = loserRole === 'buyer' ? 'buyerRating' : 'sellerRating';
  const loserCurrentRating = loserRole === 'buyer' ? loser.buyerRating : loser.sellerRating;

  if (loserCurrentRating !== null) {
    let loserDelta: number;
    if (loserId === openerId) {
      // Loser was the opener — they already lost 0.2 at open time
      // Additional penalty: -0.5
      loserDelta = -DISPUTE_LOSE_ADDITIONAL;
    } else {
      // Loser was not the opener — full penalty
      loserDelta = -(DISPUTE_OPEN_PENALTY + DISPUTE_LOSE_ADDITIONAL);
    }

    const newLoserRating = clampRating(loserCurrentRating + loserDelta);
    await prisma.agent.update({
      where: { id: loserId },
      data: { [loserRatingField]: newLoserRating },
    });

    logger.info('Rating updated (dispute loser)', {
      agentId: loserId,
      role: loserRole,
      previousRating: loserCurrentRating,
      newRating: newLoserRating,
      delta: loserDelta,
    });
  }
}

// ─── Inactivity Decay ───────────────────────────────────────────

/**
 * Apply inactivity decay to agents who haven't transacted in 90+ days.
 * -0.1 per month of inactivity past the 90-day threshold.
 * Returns the count of agents decayed.
 */
export async function applyInactivityDecay(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - INACTIVITY_THRESHOLD_DAYS);

  // Find agents with lastTransactionAt before cutoff and non-null ratings
  const inactiveAgents = await prisma.agent.findMany({
    where: {
      lastTransactionAt: { lt: cutoffDate },
      OR: [
        { buyerRating: { not: null } },
        { sellerRating: { not: null } },
      ],
    },
    select: {
      id: true,
      buyerRating: true,
      sellerRating: true,
      lastTransactionAt: true,
    },
  });

  let decayedCount = 0;

  for (const agent of inactiveAgents) {
    if (!agent.lastTransactionAt) continue;

    // Calculate months of inactivity past the threshold
    const daysSinceTransaction = Math.floor(
      (Date.now() - agent.lastTransactionAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const monthsPastThreshold = Math.floor(
      (daysSinceTransaction - INACTIVITY_THRESHOLD_DAYS) / 30,
    );

    if (monthsPastThreshold <= 0) continue;

    const totalDecay = INACTIVITY_DECAY_PER_MONTH * monthsPastThreshold;

    const updates: Record<string, number> = {};
    let needsUpdate = false;

    if (agent.buyerRating !== null) {
      const decayed = clampRating(agent.buyerRating - totalDecay);
      if (decayed !== agent.buyerRating) {
        updates.buyerRating = decayed;
        needsUpdate = true;
      }
    }

    if (agent.sellerRating !== null) {
      const decayed = clampRating(agent.sellerRating - totalDecay);
      if (decayed !== agent.sellerRating) {
        updates.sellerRating = decayed;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: updates,
      });
      decayedCount++;

      logger.info('Rating decay applied', {
        agentId: agent.id,
        monthsPastThreshold,
        totalDecay,
        buyerRating: updates.buyerRating ?? agent.buyerRating,
        sellerRating: updates.sellerRating ?? agent.sellerRating,
      });
    }
  }

  return decayedCount;
}

// ─── Get Ratings ────────────────────────────────────────────────

export async function getAgentRatings(agentId: string): Promise<{
  buyerRating: number | null;
  sellerRating: number | null;
  buyerTxCount: number;
  sellerTxCount: number;
}> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      buyerRating: true,
      sellerRating: true,
      buyerTxCount: true,
      sellerTxCount: true,
    },
  });

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  return {
    buyerRating: agent.buyerRating,
    sellerRating: agent.sellerRating,
    buyerTxCount: agent.buyerTxCount,
    sellerTxCount: agent.sellerTxCount,
  };
}

// ─── Minimum Rating Check ───────────────────────────────────────

/**
 * Check if an agent's rating meets a minimum requirement.
 * null (N/A) ratings never meet a minimum — the buyer must have
 * at least one completed transaction to have a rating.
 */
export function meetsMinimumRating(
  rating: number | null,
  minimum: number,
): boolean {
  if (rating === null) return false;
  return rating >= minimum;
}
