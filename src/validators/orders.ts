import { z } from 'zod';

/**
 * Structured shipping address — validated on order creation.
 * ISO 3166-1 alpha-2 country code required (e.g. "US", "CA", "GB").
 */
export const shippingAddressSchema = z.object({
  name: z.string().min(1).max(200),
  street1: z.string().min(1).max(200),
  street2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().max(50).optional(),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2),  // ISO 3166-1 alpha-2
  phone: z.string().max(20).optional(),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export const createOrderSchema = z.object({
  listingId: z.string().uuid(),
  fulfillmentType: z.enum(['shipped', 'local_meetup']).default('shipped'),
  shippingAddress: shippingAddressSchema.optional(),
  /** @deprecated Use shippingAddress instead. Kept for backward compat. */
  shippingInfo: z
    .object({
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  // Local meetup fields
  meetupTime: z.string().datetime().optional(),
  meetupArea: z.string().min(1).max(200).optional(),
}).refine(data => {
  if (data.fulfillmentType === 'local_meetup' && !data.meetupArea) {
    return false;
  }
  return true;
}, { message: 'meetupArea is required for local_meetup orders' });

export const fulfillOrderSchema = z.object({
  trackingNumber: z.string().min(1).max(100).optional(),
  shippingInfo: z.record(z.unknown()).optional(),
});

export const handoffSchema = z.object({
  notes: z.string().max(500).optional(),
});

export const disputeOrderSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export const listOrdersSchema = z.object({
  role: z.enum(['buyer', 'seller', 'all']).default('all'),
  status: z
    .enum(['created', 'funded', 'fulfilled', 'completed', 'disputed', 'cancelled', 'refunded'])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createBuyOrderSchema = z.object({
  searchQuery: z.string().min(1).max(500),
  maxPriceUsdc: z.coerce.number().int().positive(),
  category: z.string().max(100).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional(),
  minSellerReputation: z.number().min(0).max(5).optional(),
  autoBuy: z.boolean().default(false),
  autoBuyMaxUsdc: z.coerce.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateBuyOrderSchema = z.object({
  searchQuery: z.string().min(1).max(500).optional(),
  maxPriceUsdc: z.coerce.number().int().positive().optional(),
  category: z.string().max(100).nullable().optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).nullable().optional(),
  minSellerReputation: z.number().min(0).max(5).nullable().optional(),
  autoBuy: z.boolean().optional(),
  autoBuyMaxUsdc: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(
    z.enum([
      'order.created',
      'order.funded',
      'order.fulfilled',
      'order.completed',
      'order.disputed',
      'order.cancelled',
      'listing.created',
      'listing.sold',
      'listing.delisted',
      'buy_order.matched',
      'negotiation.message',
    ]),
  ).min(1),
});

export const createFeatureRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
});

export const withdrawSchema = z.object({
  toAddress: z.string().min(1),
  amountUsdc: z.coerce.number().int().positive().optional(),
  amountSol: z.coerce.number().int().positive().optional(),
});
