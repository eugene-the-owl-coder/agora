import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

/**
 * Find listings that match a buy order's criteria.
 */
export async function findMatchingListings(buyOrderId: string) {
  const buyOrder = await prisma.buyOrder.findUnique({ where: { id: buyOrderId } });
  if (!buyOrder || buyOrder.status !== 'active') {
    return [];
  }

  const where: Prisma.ListingWhereInput = {
    status: 'active',
    priceUsdc: { lte: buyOrder.maxPriceUsdc },
    quantity: { gt: 0 },
  };

  // Category filter
  if (buyOrder.category) {
    where.category = buyOrder.category;
  }

  // Condition filter
  if (buyOrder.condition) {
    where.condition = buyOrder.condition;
  }

  // Search query — simple title/description ILIKE
  if (buyOrder.searchQuery) {
    where.OR = [
      { title: { contains: buyOrder.searchQuery, mode: 'insensitive' } },
      { description: { contains: buyOrder.searchQuery, mode: 'insensitive' } },
    ];
  }

  const listings = await prisma.listing.findMany({
    where,
    include: { agent: { select: { id: true, name: true, reputation: true } } },
    orderBy: { priceUsdc: 'asc' },
    take: 20,
  });

  // Filter by seller reputation if specified
  if (buyOrder.minSellerReputation) {
    return listings.filter(
      (l) => l.agent.reputation >= (buyOrder.minSellerReputation || 0),
    );
  }

  return listings;
}

/**
 * Run matching for all active buy orders.
 * Called periodically or on new listing creation.
 */
export async function runMatchingEngine(): Promise<number> {
  const activeBuyOrders = await prisma.buyOrder.findMany({
    where: {
      status: 'active',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  let matchCount = 0;

  for (const buyOrder of activeBuyOrders) {
    const matches = await findMatchingListings(buyOrder.id);
    if (matches.length > 0) {
      // Update buy order with first match
      await prisma.buyOrder.update({
        where: { id: buyOrder.id },
        data: { matchedListingId: matches[0].id },
      });
      matchCount++;

      logger.info('Buy order matched', {
        buyOrderId: buyOrder.id,
        matchedListingId: matches[0].id,
        matchCount: matches.length,
      });
    }
  }

  return matchCount;
}
