import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────

export type ReputationLevel = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface ReputationScore {
  agentId: string;
  overallScore: number;
  completionRate: number;
  disputeRate: number;
  avgResponseTimeMinutes: number;
  totalTransactions: number;
  accountAgeDays: number;
  lastActiveAt: Date | null;
  level: ReputationLevel;
  badges: string[];
}

export interface ReputationSummary {
  overallScore: number;
  level: ReputationLevel;
  totalTransactions: number;
  completionRate: number;
  badges: string[];
}

// ─── Level thresholds ───────────────────────────────────────────

function computeLevel(totalTransactions: number): ReputationLevel {
  if (totalTransactions >= 100) return 'platinum';
  if (totalTransactions >= 50) return 'gold';
  if (totalTransactions >= 20) return 'silver';
  if (totalTransactions >= 5) return 'bronze';
  return 'new';
}

// ─── Score sub-components ───────────────────────────────────────

function completionRateScore(completionRate: number): number {
  // completionRate is 0-1, map to 0-100
  return completionRate * 100;
}

function disputeRateScore(disputeRate: number): number {
  // Inverted: 0% disputes = 100, 100% disputes = 0
  return (1 - disputeRate) * 100;
}

function volumeScore(totalTransactions: number): number {
  // Log scale, capped at 100 for 200+ transactions
  if (totalTransactions <= 0) return 0;
  if (totalTransactions >= 200) return 100;
  // log2(200) ≈ 7.64
  return Math.min(100, (Math.log2(totalTransactions) / Math.log2(200)) * 100);
}

function ageScore(accountAgeDays: number): number {
  // Capped at 100 for 180+ days
  if (accountAgeDays >= 180) return 100;
  return (accountAgeDays / 180) * 100;
}

function responseTimeScore(avgMinutes: number): number {
  // Faster = higher. 0 min → 100, 120+ min → 0
  if (avgMinutes <= 0) return 100;
  if (avgMinutes >= 120) return 0;
  return Math.max(0, (1 - avgMinutes / 120) * 100);
}

function computeOverallScore(params: {
  completionRate: number;
  disputeRate: number;
  totalTransactions: number;
  accountAgeDays: number;
  avgResponseTimeMinutes: number;
}): number {
  const score =
    completionRateScore(params.completionRate) * 0.4 +
    disputeRateScore(params.disputeRate) * 0.25 +
    volumeScore(params.totalTransactions) * 0.2 +
    ageScore(params.accountAgeDays) * 0.1 +
    responseTimeScore(params.avgResponseTimeMinutes) * 0.05;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ─── Badges ─────────────────────────────────────────────────────

async function computeBadges(
  agentId: string,
  totalTransactions: number,
  disputeCount: number,
  accountAgeDays: number,
  avgResponseTimeMinutes: number,
): Promise<string[]> {
  const badges: string[] = [];

  // fast_shipper: avg ship time < 24h (for sellers — time from created/funded to fulfilled)
  const sellerFulfilledOrders = await prisma.order.findMany({
    where: {
      sellerAgentId: agentId,
      status: { in: ['fulfilled', 'completed'] },
    },
    select: { createdAt: true, updatedAt: true, deliveredAt: true },
  });

  if (sellerFulfilledOrders.length > 0) {
    // Use time between order creation and the first fulfillment as a proxy.
    // For completed orders, we look at the order createdAt vs updatedAt delta
    // as a rough fulfillment time metric.
    const fulfilledWithTracking = await prisma.order.findMany({
      where: {
        sellerAgentId: agentId,
        status: { in: ['fulfilled', 'completed'] },
        trackingNumber: { not: null },
      },
      select: { createdAt: true, updatedAt: true },
    });

    if (fulfilledWithTracking.length >= 3) {
      const avgShipMs =
        fulfilledWithTracking.reduce((sum, o) => {
          return sum + (o.updatedAt.getTime() - o.createdAt.getTime());
        }, 0) / fulfilledWithTracking.length;
      const avgShipHours = avgShipMs / (1000 * 60 * 60);
      if (avgShipHours < 24) {
        badges.push('fast_shipper');
      }
    }
  }

  // no_disputes: 20+ transactions, 0 disputes
  if (totalTransactions >= 20 && disputeCount === 0) {
    badges.push('no_disputes');
  }

  // high_volume: 50+ transactions
  if (totalTransactions >= 50) {
    badges.push('high_volume');
  }

  // veteran: account age > 365 days
  if (accountAgeDays > 365) {
    badges.push('veteran');
  }

  // quick_responder: avg negotiation response < 30min
  if (avgResponseTimeMinutes > 0 && avgResponseTimeMinutes < 30) {
    badges.push('quick_responder');
  }

  return badges;
}

// ─── Main computation ───────────────────────────────────────────

export async function computeReputation(agentId: string): Promise<ReputationScore> {
  // Fetch the agent
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, createdAt: true },
  });

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Count completed orders (as buyer + seller)
  const [completedAsBuyer, completedAsSeller] = await Promise.all([
    prisma.order.count({
      where: { buyerAgentId: agentId, status: 'completed' },
    }),
    prisma.order.count({
      where: { sellerAgentId: agentId, status: 'completed' },
    }),
  ]);
  const completedTransactions = completedAsBuyer + completedAsSeller;

  // Count total orders that reached a terminal state (completed, cancelled, refunded, disputed)
  const [totalAsBuyer, totalAsSeller] = await Promise.all([
    prisma.order.count({
      where: {
        buyerAgentId: agentId,
        status: { in: ['completed', 'cancelled', 'refunded', 'disputed'] },
      },
    }),
    prisma.order.count({
      where: {
        sellerAgentId: agentId,
        status: { in: ['completed', 'cancelled', 'refunded', 'disputed'] },
      },
    }),
  ]);
  const totalTerminal = totalAsBuyer + totalAsSeller;

  // Completion rate
  const completionRate = totalTerminal > 0 ? completedTransactions / totalTerminal : 0;

  // Dispute count — distinct orders that had a dispute opened (by or against this agent)
  const disputeCount = await prisma.dispute.count({
    where: {
      order: {
        OR: [{ buyerAgentId: agentId }, { sellerAgentId: agentId }],
      },
    },
  });
  const disputeRate = totalTerminal > 0 ? disputeCount / totalTerminal : 0;

  // Average response time in negotiations
  // We measure: for negotiations where this agent is a participant,
  // the average time between consecutive messages from different agents.
  const negotiations = await prisma.negotiation.findMany({
    where: {
      OR: [{ buyerAgentId: agentId }, { sellerAgentId: agentId }],
    },
    select: { id: true },
  });

  let avgResponseTimeMinutes = 0;
  if (negotiations.length > 0) {
    const negotiationIds = negotiations.map((n) => n.id);

    // Get all messages in these negotiations, ordered by time
    const messages = await prisma.negotiationMessage.findMany({
      where: { negotiationId: { in: negotiationIds } },
      orderBy: [{ negotiationId: 'asc' }, { createdAt: 'asc' }],
      select: { negotiationId: true, fromAgentId: true, createdAt: true },
    });

    // Group by negotiation and compute response times for this agent
    let totalResponseMs = 0;
    let responseCount = 0;

    let prevMsg: (typeof messages)[0] | null = null;
    for (const msg of messages) {
      if (prevMsg && prevMsg.negotiationId === msg.negotiationId) {
        // If this message is FROM this agent and the previous was from someone else
        if (msg.fromAgentId === agentId && prevMsg.fromAgentId !== agentId) {
          totalResponseMs += msg.createdAt.getTime() - prevMsg.createdAt.getTime();
          responseCount++;
        }
      }
      prevMsg = msg;
    }

    if (responseCount > 0) {
      avgResponseTimeMinutes = totalResponseMs / responseCount / (1000 * 60);
    }
  }

  // Account age
  const accountAgeDays = Math.floor(
    (Date.now() - agent.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  // Last active: most recent order or negotiation message
  const [lastOrder, lastMessage] = await Promise.all([
    prisma.order.findFirst({
      where: {
        OR: [{ buyerAgentId: agentId }, { sellerAgentId: agentId }],
      },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    prisma.negotiationMessage.findFirst({
      where: { fromAgentId: agentId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  const lastActiveAt = (() => {
    const dates: Date[] = [];
    if (lastOrder) dates.push(lastOrder.updatedAt);
    if (lastMessage) dates.push(lastMessage.createdAt);
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates.map((d) => d.getTime())));
  })();

  // Level
  const level = computeLevel(completedTransactions);

  // Overall score
  const overallScore = computeOverallScore({
    completionRate,
    disputeRate,
    totalTransactions: completedTransactions,
    accountAgeDays,
    avgResponseTimeMinutes,
  });

  // Badges
  const badges = await computeBadges(
    agentId,
    completedTransactions,
    disputeCount,
    accountAgeDays,
    avgResponseTimeMinutes,
  );

  return {
    agentId,
    overallScore,
    completionRate: Math.round(completionRate * 10000) / 10000, // 4 decimal places
    disputeRate: Math.round(disputeRate * 10000) / 10000,
    avgResponseTimeMinutes: Math.round(avgResponseTimeMinutes * 100) / 100,
    totalTransactions: completedTransactions,
    accountAgeDays,
    lastActiveAt,
    level,
    badges,
  };
}

// ─── Summary (for embedding in listing responses) ───────────────

export async function getReputationSummary(agentId: string): Promise<ReputationSummary> {
  const rep = await computeReputation(agentId);
  return {
    overallScore: rep.overallScore,
    level: rep.level,
    totalTransactions: rep.totalTransactions,
    completionRate: rep.completionRate,
    badges: rep.badges,
  };
}

// ─── Leaderboard ────────────────────────────────────────────────

export async function getLeaderboard(params: {
  limit: number;
  sort: 'overall' | 'completionRate' | 'volume';
}): Promise<ReputationScore[]> {
  const { limit, sort } = params;

  // Get all agents that have at least one completed order
  const agentsWithOrders = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT a.id
    FROM "Agent" a
    WHERE EXISTS (
      SELECT 1 FROM "Order" o
      WHERE (o."buyerAgentId" = a.id OR o."sellerAgentId" = a.id)
        AND o.status = 'completed'
    )
  `;

  if (agentsWithOrders.length === 0) return [];

  // Compute reputation for each
  const reputations = await Promise.all(
    agentsWithOrders.map((a) => computeReputation(a.id)),
  );

  // Sort
  switch (sort) {
    case 'completionRate':
      reputations.sort((a, b) => b.completionRate - a.completionRate);
      break;
    case 'volume':
      reputations.sort((a, b) => b.totalTransactions - a.totalTransactions);
      break;
    case 'overall':
    default:
      reputations.sort((a, b) => b.overallScore - a.overallScore);
      break;
  }

  return reputations.slice(0, limit);
}
