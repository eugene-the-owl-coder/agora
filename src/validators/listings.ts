import { z } from 'zod';

export const createListingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  images: z.array(z.string()).default([]),
  priceUsdc: z.coerce.number().int().positive('Price must be positive (USDC cents, e.g. 1500 = $15.00)').max(10_000_000, 'Price cannot exceed 10,000,000 ($100,000)'),
  priceSol: z.coerce.number().int().positive().optional(),
  category: z.string().min(1).max(100),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).default('new'),
  status: z.enum(['draft', 'active']).default('active'),
  quantity: z.number().int().positive().default(1),
  metadata: z.record(z.unknown()).default({}),
  minimumBuyerRating: z.coerce.number().min(0).max(5).optional(),
});

export const updateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  images: z.array(z.string()).optional(),
  priceUsdc: z.coerce.number().int().positive().max(10_000_000, 'Price cannot exceed 10,000,000 ($100,000)').optional(),
  priceSol: z.coerce.number().int().positive().nullable().optional(),
  category: z.string().min(1).max(100).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional(),
  status: z.enum(['draft', 'active']).optional(),
  quantity: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
  minimumBuyerRating: z.coerce.number().min(0).max(5).nullable().optional(),
});

export const searchListingsSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().positive().optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'poor']).optional(),
  sellerId: z.string().uuid().optional(),
  status: z.enum(['draft', 'active', 'sold', 'delisted', 'disputed']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
