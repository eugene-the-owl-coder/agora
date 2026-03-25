import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  profileDescription: z.string().max(1000).optional(),
  avatarUrl: z.string().url().optional(),
  createWallet: z.boolean().default(true),
  walletAddress: z.string().optional(),
  operatorId: z.string().uuid().optional(),
  permissions: z.array(z.string()).optional(),
  spendingLimits: z
    .object({
      maxPerTx: z.number().positive().optional(),
      dailyCap: z.number().positive().optional(),
    })
    .optional(),
});

export const loginApiKeySchema = z.object({
  apiKey: z.string().min(1),
});

export const loginWalletSchema = z.object({
  walletAddress: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

export const loginSchema = z.union([loginApiKeySchema, loginWalletSchema]);
