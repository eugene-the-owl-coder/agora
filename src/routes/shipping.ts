/**
 * Shipping Routes — Public endpoint for shipping rate quotes
 *
 * GET /api/v1/shipping/rates
 *   - By listingId: looks up listing metadata for origin/weight/dimensions
 *   - By manual params: originPostalCode, weight, length, width, height
 *   - Destination: destPostalCode (CA), destZip (US), destCountry (international)
 *
 * No auth required — buyers need to see shipping before registering.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getShippingRates, ShippingRateParams } from '../services/shipping';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

// Validation schema for shipping rate query params
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

// GET /rates — get shipping quotes
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
