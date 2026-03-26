import { z } from 'zod';

export const startNegotiationSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (USDC minor units)'),
  currency: z.literal('USDC').default('USDC'),
  message: z.string().max(2000).optional(),
  shippingMethod: z.string().max(200).optional(),
});

export const negotiationMessageSchema = z.object({
  type: z.enum([
    'COUNTER',
    'ACCEPT',
    'REJECT',
    'CLARIFY',
    'INSPECT',
    'ESCALATE_TO_HUMAN',
    'WITHDRAW',
  ]),
  payload: z.record(z.unknown()).default({}),
});

// Type-specific payload validators
export const counterPayloadSchema = z.object({
  amount: z.number().int().positive('Counter amount must be a positive integer'),
  message: z.string().max(2000).optional(),
});

export const acceptPayloadSchema = z.object({}).strict();

export const rejectPayloadSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const clarifyPayloadSchema = z.object({
  question: z.string().min(1).max(2000),
});

export const inspectPayloadSchema = z.object({
  requestedPhotos: z.array(z.string().max(500)).max(10).optional(),
  requestedDetails: z.array(z.string().max(500)).max(10).optional(),
});

export const escalatePayloadSchema = z.object({
  reason: z.string().min(1).max(2000),
  context: z.string().max(5000).optional(),
});

export const withdrawPayloadSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const listNegotiationsSchema = z.object({
  status: z.enum(['active', 'accepted', 'rejected', 'withdrawn', 'expired']).optional(),
  listingId: z.string().uuid().optional(),
  role: z.enum(['buyer', 'seller', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const payloadValidators: Record<string, z.ZodType<any>> = {
  COUNTER: counterPayloadSchema,
  ACCEPT: acceptPayloadSchema,
  REJECT: rejectPayloadSchema,
  CLARIFY: clarifyPayloadSchema,
  INSPECT: inspectPayloadSchema,
  ESCALATE_TO_HUMAN: escalatePayloadSchema,
  WITHDRAW: withdrawPayloadSchema,
};
