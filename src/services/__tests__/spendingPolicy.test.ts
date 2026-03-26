import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock prisma before importing the module under test
vi.mock('../../lib/prisma', () => ({
  prisma: {
    spendingPolicy: {
      findUnique: vi.fn(),
    },
    order: {
      aggregate: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// Mock logger to avoid console noise
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { validatePurchase } from '../spendingPolicy';
import { prisma } from '../../lib/prisma';

// Type-safe access to mocked methods
const mockFindPolicy = prisma.spendingPolicy.findUnique as unknown as Mock;
const mockAggregateOrder = prisma.order.aggregate as unknown as Mock;
const mockFindFirstOrder = prisma.order.findFirst as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validatePurchase', () => {
  describe('no policy / inactive policy', () => {
    it('allows purchase when no policy exists', async () => {
      mockFindPolicy.mockResolvedValue(null);

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(true);
    });

    it('allows purchase when policy is inactive', async () => {
      mockFindPolicy.mockResolvedValue({
        id: 'policy-1',
        agentId: 'agent-1',
        isActive: false,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(true);
    });
  });

  describe('blocked sellers', () => {
    it('blocks purchase from a blocked seller', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: ['bad-seller'],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', {
        amount: 1_000_000,
        sellerId: 'bad-seller',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('allows purchase from a non-blocked seller', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: ['bad-seller'],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', {
        amount: 1_000_000,
        sellerId: 'good-seller',
      });

      expect(result.allowed).toBe(true);
    });

    it('skips seller check when no sellerId provided', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: ['bad-seller'],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(true);
    });
  });

  describe('category filtering', () => {
    it('blocks purchase in a disallowed category', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: ['tools', 'data'],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', {
        amount: 1_000_000,
        category: 'entertainment',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Category');
      expect(result.reason).toContain('entertainment');
    });

    it('allows purchase in an allowed category', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: ['tools', 'data'],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', {
        amount: 1_000_000,
        category: 'tools',
      });

      expect(result.allowed).toBe(true);
    });

    it('allows any category when allowedCategories is empty', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', {
        amount: 1_000_000,
        category: 'anything',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('per-transaction max', () => {
    it('blocks purchase exceeding per-transaction limit', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: 500_000,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('per-transaction limit');
    });

    it('allows purchase at exactly per-transaction limit', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: 500_000,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', { amount: 500_000 });
      expect(result.allowed).toBe(true);
    });

    it('allows purchase below per-transaction limit', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: 500_000,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      const result = await validatePurchase('agent-1', { amount: 100_000 });
      expect(result.allowed).toBe(true);
    });
  });

  describe('monthly budget', () => {
    it('blocks purchase that would exceed monthly limit', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: 5_000_000,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      mockAggregateOrder.mockResolvedValue({
        _sum: { amountUsdc: 4_500_000 },
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('monthly budget');
      expect(result.remainingBudget).toBe(500_000);
    });

    it('allows purchase within monthly limit', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: 5_000_000,
        cooldownMinutes: null,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      mockAggregateOrder.mockResolvedValue({
        _sum: { amountUsdc: 1_000_000 },
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(true);
      expect(result.remainingBudget).toBe(4_000_000);
    });
  });

  describe('cooldown', () => {
    it('blocks purchase during cooldown period', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: 60,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      // Last order was 10 minutes ago (within 60-minute cooldown)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockFindFirstOrder.mockResolvedValue({
        createdAt: tenMinutesAgo,
      });

      const result = await validatePurchase('agent-1', { amount: 100_000 });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cooldown active');
    });

    it('allows purchase after cooldown expires', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: 60,
        autoApproveBelow: null,
        requireHumanAbove: null,
      });

      // Last order was 2 hours ago (well past 60-minute cooldown)
      const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
      mockFindFirstOrder.mockResolvedValue({
        createdAt: twoHoursAgo,
      });

      const result = await validatePurchase('agent-1', { amount: 100_000 });
      expect(result.allowed).toBe(true);
    });
  });

  describe('human approval thresholds', () => {
    it('requires human approval above requireHumanAbove', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: 100_000,
        requireHumanAbove: 500_000,
      });

      const result = await validatePurchase('agent-1', { amount: 1_000_000 });
      expect(result.allowed).toBe(true);
      expect(result.requiresHumanApproval).toBe(true);
    });

    it('auto-approves below autoApproveBelow', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: 100_000,
        requireHumanAbove: 500_000,
      });

      const result = await validatePurchase('agent-1', { amount: 50_000 });
      expect(result.allowed).toBe(true);
      expect(result.requiresHumanApproval).toBe(false);
    });

    it('requires approval between auto-approve and require-human thresholds', async () => {
      mockFindPolicy.mockResolvedValue({
        isActive: true,
        blockedSellers: [],
        allowedCategories: [],
        perTransactionMax: null,
        monthlyLimitUsdc: null,
        cooldownMinutes: null,
        autoApproveBelow: 100_000,
        requireHumanAbove: 500_000,
      });

      const result = await validatePurchase('agent-1', { amount: 250_000 });
      expect(result.allowed).toBe(true);
      expect(result.requiresHumanApproval).toBe(true);
    });
  });
});
