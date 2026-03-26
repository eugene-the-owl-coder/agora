import { z } from 'zod';

export const openDisputeSchema = z.object({
  reason: z.enum([
    'not_received',
    'wrong_item',
    'damaged',
    'counterfeit',
    'not_as_described',
    'other',
  ]),
  description: z.string().min(10).max(5000),
  evidence: z
    .array(z.string().url().max(2048))
    .max(10)
    .optional(),
});

export const submitEvidenceSchema = z.object({
  description: z.string().min(1).max(5000),
  urls: z
    .array(z.string().url().max(2048))
    .max(10)
    .optional(),
  type: z
    .enum(['photo', 'screenshot', 'receipt', 'communication', 'other'])
    .default('other'),
});

export const resolveDisputeSchema = z.object({
  resolution: z.enum([
    'full_refund',
    'partial_refund',
    'release_to_seller',
    'split',
  ]),
  refundAmount: z.coerce.number().int().positive().optional(),
  notes: z.string().min(1).max(5000),
});
