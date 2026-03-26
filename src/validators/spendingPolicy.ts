import { z } from 'zod';

export const upsertSpendingPolicySchema = z
  .object({
    monthlyLimitUsdc: z.number().int().positive().nullable().optional(),
    perTransactionMax: z.number().int().positive().nullable().optional(),
    autoApproveBelow: z.number().int().positive().nullable().optional(),
    requireHumanAbove: z.number().int().positive().nullable().optional(),
    allowedCategories: z.array(z.string()).optional(),
    blockedSellers: z.array(z.string().uuid()).optional(),
    cooldownMinutes: z.number().int().positive().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => {
      // If both autoApproveBelow and perTransactionMax are provided,
      // autoApproveBelow must not exceed perTransactionMax
      if (
        data.autoApproveBelow !== undefined &&
        data.autoApproveBelow !== null &&
        data.perTransactionMax !== undefined &&
        data.perTransactionMax !== null
      ) {
        return data.autoApproveBelow <= data.perTransactionMax;
      }
      return true;
    },
    {
      message: 'autoApproveBelow must not exceed perTransactionMax',
      path: ['autoApproveBelow'],
    },
  );
