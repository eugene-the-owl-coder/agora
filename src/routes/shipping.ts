/**
 * Shipping Routes — Public endpoints for shipping rate quotes
 *
 * Legacy (backward compat):
 *   GET /api/v1/shipping/rates — FedEx-style rate lookup by listing or manual params
 *
 * Plugin-aware (new):
 *   GET  /api/v1/shipping/carriers — List available carrier plugins
 *   POST /api/v1/shipping/quotes   — Multi-carrier quotes
 *
 * No auth required — buyers need to see shipping before registering.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getShippingRates, ShippingRateParams } from '../services/shipping';
import { createCarrierRegistry, isCarrierPlugin } from '../services/carriers';
import type { QuoteRequest } from '../services/carriers';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

// ─── Shared registry instance for routes ────────────────────────

let _registry: ReturnType<typeof createCarrierRegistry> | null = null;
function getRegistry() {
  if (!_registry) {
    _registry = createCarrierRegistry();
  }
  return _registry;
}

// ─── GET /carriers — List available carrier plugins ─────────────

router.get('/carriers', (_req: Request, res: Response) => {
  const registry = getRegistry();
  const allNames = registry.list();

  const carriers = allNames.map((name) => {
    const tracker = registry.get(name);
    if (!tracker) return null;

    const isPlugin = isCarrierPlugin(tracker);

    return {
      id: isPlugin ? tracker.carrierId : tracker.name,
      name: isPlugin ? tracker.displayName : tracker.name,
      capabilities: {
        tracking: true,
        quotes: isPlugin,
        labels: isPlugin && typeof tracker.purchaseLabel === 'function',
      },
      supportedCountries: isPlugin ? tracker.supportedCountries : [],
    };
  }).filter(Boolean);

  res.json({ carriers });
});

// ─── POST /quotes — Multi-carrier rate quotes ──────────────────

const quotesBodySchema = z.object({
  fromPostalCode: z.string().min(3).max(10),
  fromCountry: z.string().length(2).default('CA'),
  toPostalCode: z.string().min(3).max(10),
  toCountry: z.string().length(2).default('US'),
  weight: z.object({
    value: z.number().positive(),
    unit: z.enum(['lb', 'kg', 'oz', 'g']),
  }),
  dimensions: z.object({
    length: z.number().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
    unit: z.enum(['in', 'cm']),
  }).optional(),
});

router.post('/quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = quotesBodySchema.parse(req.body);
    const registry = getRegistry();
    const plugins = registry.listPlugins();

    if (plugins.length === 0) {
      res.json({
        quotes: [],
        meta: {
          carriers: 0,
          message: 'No carrier plugins available. Check carrier credentials.',
        },
      });
      return;
    }

    const quoteRequest: QuoteRequest = {
      fromPostalCode: body.fromPostalCode,
      fromCountry: body.fromCountry,
      toPostalCode: body.toPostalCode,
      toCountry: body.toCountry,
      weight: body.weight,
      dimensions: body.dimensions,
    };

    // Gather quotes from all carrier plugins in parallel
    const results = await Promise.allSettled(
      plugins.map(async (plugin) => {
        const quotes = await plugin.getQuotes(quoteRequest);
        return quotes;
      }),
    );

    const allQuotes: Array<{
      serviceType: string;
      serviceName: string;
      totalPrice: number;
      currency: string;
      estimatedDays: number;
      carrier: string;
    }> = [];
    const errors: string[] = [];

    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allQuotes.push(...result.value);
      } else {
        const carrierId = plugins[i].carrierId;
        errors.push(`${carrierId}: ${result.reason?.message || 'Unknown error'}`);
        logger.error('Shipping quotes: carrier failed', {
          carrier: carrierId,
          error: result.reason?.message,
        });
      }
    });

    // Sort by price ascending
    allQuotes.sort((a, b) => a.totalPrice - b.totalPrice);

    res.json({
      quotes: allQuotes,
      meta: {
        carriers: plugins.length,
        carriersQueried: plugins.map((p) => p.carrierId),
        quotesReturned: allQuotes.length,
        ...(errors.length > 0 && { errors }),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /rates — Legacy FedEx-style rate lookup (backward compat) ──

const shippingRateQuerySchema = z.object({
  // Option A: lookup by listing
  listingId: z.string().uuid().optional(),

  // Option B: manual params
  originPostalCode: z.string().min(3).max(10).optional(),
  weight: z.coerce.number().positive().optional(),
  length: z.coerce.number().positive().optional(),
  width: z.coerce.number().positive().optional(),
  height: z.coerce.number().positive().optional(),

  // Destination (at least one required)
  destPostalCode: z.string().min(3).max(10).optional(),
  destZip: z.string().min(3).max(10).optional(),
  destCountry: z.string().length(2).optional(),
}).refine(
  (data) => data.listingId || (data.originPostalCode && data.weight && data.length && data.width && data.height),
  { message: 'Provide either listingId or (originPostalCode + weight + length + width + height)' },
).refine(
  (data) => data.destPostalCode || data.destZip || data.destCountry,
  { message: 'Provide at least one destination: destPostalCode, destZip, or destCountry' },
);

router.get('/rates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = shippingRateQuerySchema.parse(req.query);

    let rateParams: ShippingRateParams;

    if (query.listingId) {
      // Look up listing for origin/weight/dimensions
      const listing = await prisma.listing.findUnique({
        where: { id: query.listingId },
        include: {
          agent: { select: { id: true, name: true } },
        },
      });

      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }

      const metadata = (listing.metadata as Record<string, any>) || {};

      // Extract shipping metadata — support both naming conventions
      const shipFromPostalCode = metadata.shipFromPostalCode || metadata.ship_from_postal_code;
      const weightKg = metadata.weightKg ?? metadata.weight_kg;
      const dimensions = metadata.dimensions || metadata.dimensions_cm;

      if (!shipFromPostalCode) {
        throw new AppError(
          'MISSING_SHIPPING_INFO',
          'Listing does not have a ship-from postal code configured',
          400,
        );
      }

      if (!weightKg || weightKg <= 0) {
        throw new AppError(
          'MISSING_SHIPPING_INFO',
          'Listing does not have package weight configured',
          400,
        );
      }

      // Parse dimensions — support { lengthCm, widthCm, heightCm } and { length, width, height }
      let lengthCm: number, widthCm: number, heightCm: number;
      if (dimensions) {
        lengthCm = dimensions.lengthCm ?? dimensions.length ?? 20;
        widthCm = dimensions.widthCm ?? dimensions.width ?? 15;
        heightCm = dimensions.heightCm ?? dimensions.height ?? 10;
      } else {
        // Default dimensions if not specified
        lengthCm = 20;
        widthCm = 15;
        heightCm = 10;
      }

      rateParams = {
        originPostalCode: shipFromPostalCode,
        destinationPostalCode: query.destPostalCode,
        destinationZip: query.destZip,
        destinationCountry: query.destCountry,
        weightKg: parseFloat(weightKg),
        lengthCm,
        widthCm,
        heightCm,
      };
    } else {
      // Manual params
      rateParams = {
        originPostalCode: query.originPostalCode!,
        destinationPostalCode: query.destPostalCode,
        destinationZip: query.destZip,
        destinationCountry: query.destCountry,
        weightKg: query.weight!,
        lengthCm: query.length!,
        widthCm: query.width!,
        heightCm: query.height!,
      };
    }

    const options = await getShippingRates(rateParams);

    res.json({
      rates: options,
      meta: {
        origin: rateParams.originPostalCode,
        destination: query.destPostalCode || query.destZip || query.destCountry || 'unknown',
        weightKg: rateParams.weightKg,
        isEstimate: options.length > 0 && options[0].isEstimate,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
