import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma, Prisma as P } from '@prisma/client';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { createListingSchema, updateListingSchema, searchListingsSchema } from '../validators/listings';
import { uuidParamSchema } from '../validators/common';
import { dispatchWebhook } from '../services/webhook';
import { runMatchingEngine } from '../services/matching';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// POST / — create listing
router.post('/', authenticate, requireScope('list'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createListingSchema.parse(req.body);

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

    res.status(201).json({
      listing: serializeListing(listing),
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

    res.json({
      listings: listings.map(serializeListing),
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

    res.json({ listing: serializeListing(listing) });
  } catch (err) {
    next(err);
  }
});

// PUT /:id — update listing (owner only)
router.put('/:id', authenticate, requireScope('list'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const data = updateListingSchema.parse(req.body);

    const listing = await prisma.listing.findUnique({ where: { id } });
    if (!listing) {
      throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
    }
    if (listing.agentId !== req.agent!.id) {
      throw new AppError('FORBIDDEN', 'You can only update your own listings', 403);
    }

    const updateData: any = { ...data };
    if (data.priceUsdc !== undefined) updateData.priceUsdc = BigInt(data.priceUsdc);
    if (data.priceSol !== undefined) updateData.priceSol = data.priceSol ? BigInt(data.priceSol) : null;

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
