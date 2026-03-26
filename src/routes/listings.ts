import { Router, Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createListingSchema, updateListingSchema, searchListingsSchema } from '../validators/listings';
import { uuidParamSchema } from '../validators/common';
import { dispatchWebhook } from '../services/webhook';
import { runMatchingEngine } from '../services/matching';
import { logger } from '../utils/logger';
import { getReputationSummary } from '../services/reputation';
import { getAgentRatings } from '../services/rating';
import { validateListingPrice, validateActiveListings, getAgentTier as getTrustTierInfo } from '../services/trustTier';
import { sanitizeText } from '../utils/sanitize';
import { listingCreationRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// POST / — create listing
router.post('/', listingCreationRateLimiter, authenticate, requireScope('list'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createListingSchema.parse(req.body);

    // Sanitize text fields
    data.title = sanitizeText(data.title, 200);
    data.description = sanitizeText(data.description, 5000);
    data.category = sanitizeText(data.category, 100);

    // ── Price Sanity Guard ──────────────────────────────────────
    // priceUsdc is in USDC cents (1500 = $15.00). Reject values that
    // look like micro-USDC (6 decimal on-chain units) or are otherwise
    // unreasonable for a peer-to-peer marketplace.
    if (data.priceUsdc > 10_000_000) {
      throw new AppError(
        'PRICE_TOO_HIGH',
        `priceUsdc ${data.priceUsdc} exceeds the maximum of 10,000,000 ($100,000). ` +
        `Ensure the price is in USDC cents (e.g. 1500 = $15.00), not micro-USDC.`,
        400,
      );
    }
    if (data.priceUsdc > 1_000_000) {
      logger.warn('Suspiciously high listing price', {
        priceUsdc: data.priceUsdc,
        agentId: req.agent!.id,
        title: data.title,
      });
    }

    // ── Trust Tier Enforcement ──────────────────────────────────
    const priceCheck = await validateListingPrice(req.agent!.id, data.priceUsdc);
    if (!priceCheck.allowed) {
      throw new AppError('TIER_PRICE_EXCEEDED', priceCheck.reason || 'Price exceeds your trust tier limit', 403);
    }

    const listingCheck = await validateActiveListings(req.agent!.id);
    if (!listingCheck.allowed) {
      throw new AppError(
        'TIER_LISTING_CAP',
        `You have ${listingCheck.current}/${listingCheck.max} active listings. Upgrade your trust tier by completing more transactions with unique counterparties.`,
        403,
      );
    }

    const listing = await prisma.listing.create({
      data: {
        agentId: req.agent!.id,
        title: data.title,
        description: data.description,
        images: data.images,
        priceUsdc: BigInt(data.priceUsdc),
        priceSol: data.priceSol ? BigInt(data.priceSol) : null,
        category: data.category,
        condition: data.condition,
        status: data.status,
        quantity: data.quantity,
        metadata: data.metadata as Prisma.InputJsonValue,
        minimumBuyerRating: data.minimumBuyerRating ?? null,
      },
      include: {
        agent: { select: { id: true, name: true, reputation: true } },
      },
    });

    logger.info('Listing created', { listingId: listing.id, agentId: req.agent!.id });

    // Dispatch webhook
    dispatchWebhook('listing.created', {
      listingId: listing.id,
      title: listing.title,
      priceUsdc: listing.priceUsdc.toString(),
      sellerId: listing.agentId,
    }).catch(() => {});

    // Run matching engine for buy orders
    if (listing.status === 'active') {
      runMatchingEngine().catch(() => {});
    }

    // Include tier info in response
    let tierInfo = null;
    try {
      tierInfo = await getTrustTierInfo(req.agent!.id);
    } catch { /* non-fatal */ }

    res.status(201).json({
      listing: serializeListing(listing),
      tierInfo,
    });
  } catch (err) {
    next(err);
  }
});

// GET / — search/filter listings
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = searchListingsSchema.parse(req.query);
    const skip = (params.page - 1) * params.limit;

    const where: Prisma.ListingWhereInput = {};

    if (params.status) {
      where.status = params.status;
    } else {
      where.status = 'active'; // Default to active listings
    }

    if (params.category) {
      where.category = params.category;
    }

    if (params.condition) {
      where.condition = params.condition;
    }

    if (params.sellerId) {
      where.agentId = params.sellerId;
    }

    if (params.priceMin !== undefined || params.priceMax !== undefined) {
      where.priceUsdc = {};
      if (params.priceMin !== undefined) {
        where.priceUsdc.gte = BigInt(params.priceMin);
      }
      if (params.priceMax !== undefined) {
        where.priceUsdc.lte = BigInt(params.priceMax);
      }
    }

    if (params.query) {
      where.OR = [
        { title: { contains: params.query, mode: 'insensitive' } },
        { description: { contains: params.query, mode: 'insensitive' } },
      ];
    }

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        include: {
          agent: { select: { id: true, name: true, reputation: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: params.limit,
      }),
      prisma.listing.count({ where }),
    ]);

    // Enrich with seller reputation summaries and ratings
    const sellerIds = [...new Set(listings.map((l) => l.agentId))];
    const reputationMap = new Map<string, Awaited<ReturnType<typeof getReputationSummary>>>();
    const ratingsMap = new Map<string, Awaited<ReturnType<typeof getAgentRatings>>>();
    await Promise.all(
      sellerIds.map(async (sid) => {
        try {
          reputationMap.set(sid, await getReputationSummary(sid));
        } catch {
          // If reputation computation fails, skip it
        }
        try {
          ratingsMap.set(sid, await getAgentRatings(sid));
        } catch {
          // If ratings fetch fails, skip it
        }
      }),
    );

    res.json({
      listings: listings.map((l) => ({
        ...serializeListing(l),
        sellerReputation: reputationMap.get(l.agentId) ?? null,
        sellerRatings: ratingsMap.get(l.agentId) ?? null,
      })),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id — get listing details
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const listing = await prisma.listing.findUnique({
      where: { id },
      include: {
        agent: {
          select: {
            id: true,
            name: true,
            reputation: true,
            totalSales: true,
            isVerified: true,
            avatarUrl: true,
            profileDescription: true,
          },
        },
      },
    });

    if (!listing) {
      throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
    }

    let sellerReputation = null;
    let sellerRatings = null;
    try {
      sellerReputation = await getReputationSummary(listing.agentId);
    } catch {
      // Non-fatal — reputation is additive
    }
    try {
      sellerRatings = await getAgentRatings(listing.agentId);
    } catch {
      // Non-fatal
    }

    res.json({ listing: { ...serializeListing(listing), sellerReputation, sellerRatings } });
  } catch (err) {
    next(err);
  }
});

// PUT /:id — update listing (owner only)
router.put('/:id', authenticate, requireScope('list'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = updateListingSchema.parse(req.body);

    // Sanitize text fields if provided
    if (data.title) data.title = sanitizeText(data.title, 200);
    if (data.description) data.description = sanitizeText(data.description, 5000);
    if (data.category) data.category = sanitizeText(data.category, 100);

    const listing = await prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
    }
    if (listing.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only update your own listings', 403);
    }

    // ── Price Sanity Guard (update) ────────────────────────────
    if (data.priceUsdc !== undefined) {
      if (data.priceUsdc > 10_000_000) {
        throw new AppError(
          'PRICE_TOO_HIGH',
          `priceUsdc ${data.priceUsdc} exceeds the maximum of 10,000,000 ($100,000). ` +
          `Ensure the price is in USDC cents (e.g. 1500 = $15.00), not micro-USDC.`,
          400,
        );
      }
      if (data.priceUsdc > 1_000_000) {
        logger.warn('Suspiciously high listing price update', {
          priceUsdc: data.priceUsdc,
          agentId: req.agent!.id,
          listingId: id,
        });
      }
    }

    // ── Trust Tier: validate price change ─────────────────────
    if (data.priceUsdc !== undefined) {
      const priceCheck = await validateListingPrice(req.agent!.id, data.priceUsdc);
      if (!priceCheck.allowed) {
        throw new AppError('TIER_PRICE_EXCEEDED', priceCheck.reason || 'Price exceeds your trust tier limit', 403);
      }
    }

    const updateData: any = { ...data };
    if (data.priceUsdc !== undefined) updateData.priceUsdc = BigInt(data.priceUsdc);
    if (data.priceSol !== undefined) updateData.priceSol = data.priceSol ? BigInt(data.priceSol) : null;
    if (data.minimumBuyerRating !== undefined) updateData.minimumBuyerRating = data.minimumBuyerRating;

    const updated = await prisma.listing.update({
      where: { id },
      data: updateData,
      include: {
        agent: { select: { id: true, name: true, reputation: true } },
      },
    });

    res.json({ listing: serializeListing(updated) });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — delist (owner only, soft delete)
router.delete('/:id', authenticate, requireScope('list'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);

    const listing = await prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
    }
    if (listing.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only delist your own listings', 403);
    }

    const updated = await prisma.listing.update({
      where: { id },
      data: { status: 'delisted' },
    });

    dispatchWebhook('listing.delisted', { listingId: id }).catch(() => {});

    logger.info('Listing delisted', { listingId: id, agentId: req.agent!.id });
    res.json({ message: 'Listing delisted', listing: serializeListing(updated) });
  } catch (err) {
    next(err);
  }
});

// Helper to serialize BigInt fields
function serializeListing(listing: any) {
  return {
    ...listing,
    priceUsdc: listing.priceUsdc?.toString(),
    priceSol: listing.priceSol?.toString() || null,
  };
}

export default router;
