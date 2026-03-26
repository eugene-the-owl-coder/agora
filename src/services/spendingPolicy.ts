import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

export interface ValidatePurchaseParams {
  amount: number;       // USDC minor units
  category?: string;
  sellerId?: string;
}

export interface ValidatePurchaseResult {
  allowed: boolean;
  reason?: string;
  requiresHumanApproval?: boolean;
  remainingBudget?: number;
}

/**
 * Validates whether an agent's spending policy allows a purchase.
 * Checks are performed in priority order — first failure wins.
 * If no policy exists, everything is allowed (backwards-compatible).
 */
export async function validatePurchase(
  agentId: string,
  params: ValidatePurchaseParams,
): Promise<ValidatePurchaseResult> {
  const { amount, category, sellerId } = params;

  // 1. Policy exists and isActive?
  const policy = await prisma.spendingPolicy.findUnique({
    where: { agentId },
  });

  if (!policy || !policy.isActive) {
    return { allowed: true };
  }

  // 2. Is seller blocked?
  if (sellerId && policy.blockedSellers.length > 0) {
    if (policy.blockedSellers.includes(sellerId)) {
      return {
        allowed: false,
        reason: 'Seller is blocked by your spending policy',
      };
    }
  }

  // 3. Is category allowed?
  if (category && policy.allowedCategories.length > 0) {
    if (!policy.allowedCategories.includes(category)) {
      return {
        allowed: false,
        reason: `Category "${category}" is not in your allowed categories`,
      };
    }
  }

  // 4. Is amount > perTransactionMax?
  if (policy.perTransactionMax !== null && amount > policy.perTransactionMax) {
    return {
      allowed: false,
      reason: `Amount ${amount} exceeds per-transaction limit of ${policy.perTransactionMax}`,
    };
  }

  // 5. Would this exceed monthlyLimitUsdc?
  let remainingBudget: number | undefined;
  if (policy.monthlyLimitUsdc !== null) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthlySpend = await prisma.order.aggregate({
      where: {
        buyerAgentId: agentId,
        status: { in: ['created', 'funded', 'fulfilled', 'completed', 'pending_approval'] },
        createdAt: { gte: monthStart },
      },
      _sum: { amountUsdc: true },
    });

    const totalSpent = Number(monthlySpend._sum.amountUsdc ?? 0);
    remainingBudget = policy.monthlyLimitUsdc - totalSpent;

    if (totalSpent + amount > policy.monthlyLimitUsdc) {
      return {
        allowed: false,
        reason: `Purchase would exceed monthly budget. Spent: ${totalSpent}, Limit: ${policy.monthlyLimitUsdc}, This purchase: ${amount}`,
        remainingBudget,
      };
    }
  }

  // 6. Is cooldown still active?
  if (policy.cooldownMinutes !== null && policy.cooldownMinutes > 0) {
    const lastOrder = await prisma.order.findFirst({
      where: {
        buyerAgentId: agentId,
        status: { in: ['created', 'funded', 'fulfilled', 'completed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastOrder) {
      const cooldownEnd = new Date(
        lastOrder.createdAt.getTime() + policy.cooldownMinutes * 60 * 1000,
      );
      if (new Date() < cooldownEnd) {
        return {
          allowed: false,
          reason: `Cooldown active. Next purchase allowed after ${cooldownEnd.toISOString()}`,
          remainingBudget,
        };
      }
    }
  }

  // 7–9. Human approval logic
  const needsHumanApproval = determineHumanApproval(
    amount,
    policy.autoApproveBelow,
    policy.requireHumanAbove,
  );

  logger.info('Spending policy check passed', {
    agentId,
    amount,
    requiresHumanApproval: needsHumanApproval,
    remainingBudget,
  });

  return {
    allowed: true,
    requiresHumanApproval: needsHumanApproval,
    remainingBudget,
  };
}

/**
 * Determines whether human approval is required based on amount thresholds.
 *
 * 7. amount > requireHumanAbove → requires approval
 * 8. amount <= autoApproveBelow → no approval needed
 * 9. Between autoApproveBelow and requireHumanAbove → requires approval
 */
function determineHumanApproval(
  amount: number,
  autoApproveBelow: number | null,
  requireHumanAbove: number | null,
): boolean {
  // If requireHumanAbove is set and amount exceeds it → always requires approval
  if (requireHumanAbove !== null && amount > requireHumanAbove) {
    return true;
  }

  // If autoApproveBelow is set and amount is within it → no approval
  if (autoApproveBelow !== null && amount <= autoApproveBelow) {
    return false;
  }

  // If autoApproveBelow is set but amount exceeds it → requires approval
  if (autoApproveBelow !== null && amount > autoApproveBelow) {
    return true;
  }

  // No thresholds configured → no approval needed
  return false;
}

/**
 * Get spending summary for the current calendar month.
 */
export async function getSpendingSummary(agentId: string) {
  const policy = await prisma.spendingPolicy.findUnique({
    where: { agentId },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [monthlyAgg, orderCount, lastOrder] = await Promise.all([
    prisma.order.aggregate({
      where: {
        buyerAgentId: agentId,
        status: { in: ['created', 'funded', 'fulfilled', 'completed', 'pending_approval'] },
        createdAt: { gte: monthStart },
      },
      _sum: { amountUsdc: true },
    }),
    prisma.order.count({
      where: {
        buyerAgentId: agentId,
        status: { in: ['created', 'funded', 'fulfilled', 'completed', 'pending_approval'] },
        createdAt: { gte: monthStart },
      },
    }),
    prisma.order.findFirst({
      where: {
        buyerAgentId: agentId,
        status: { in: ['created', 'funded', 'fulfilled', 'completed'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  const totalSpent = Number(monthlyAgg._sum.amountUsdc ?? 0);
  const monthlyLimit = policy?.monthlyLimitUsdc ?? null;
  const remainingBudget = monthlyLimit !== null ? monthlyLimit - totalSpent : null;

  let nextAllowedPurchase: string | null = null;
  if (policy?.cooldownMinutes && lastOrder) {
    const cooldownEnd = new Date(
      lastOrder.createdAt.getTime() + policy.cooldownMinutes * 60 * 1000,
    );
    if (cooldownEnd > new Date()) {
      nextAllowedPurchase = cooldownEnd.toISOString();
    }
  }

  return {
    totalSpentThisMonth: totalSpent,
    monthlyLimit,
    remainingBudget,
    transactionCount: orderCount,
    lastPurchaseDate: lastOrder?.createdAt?.toISOString() ?? null,
    nextAllowedPurchase,
  };
}
