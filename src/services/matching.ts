import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { emitEvent } from './events';


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

/** Format USDC minor units as "$X.XX" display string */
function formatUsdc(amount: bigint | number | string): string {
  const cents = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Find NEW matching listings for a buy order, excluding any listing
 * that is already the buy order's current matchedListingId.
 */
export async function findNewMatches(buyOrderId: string) {
  const buyOrder = await prisma.buyOrder.findUnique({ where: { id: buyOrderId } });
  if (!buyOrder || buyOrder.status !== 'active') {
    return { buyOrder: null, matches: [] };
  }

  const allMatches = await findMatchingListings(buyOrderId);

  // Exclude the listing already recorded as the match
  const newMatches = buyOrder.matchedListingId
    ? allMatches.filter((l) => l.id !== buyOrder.matchedListingId)
    : allMatches;

  return { buyOrder, matches: newMatches };
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
      // Determine which matches are NEW (not the already-recorded match)
      const newMatches = buyOrder.matchedListingId
        ? matches.filter((l) => l.id !== buyOrder.matchedListingId)
        : matches;

      // Update buy order with best (cheapest) match
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

      // Emit event notifications for NEW matches only
      for (const listing of newMatches) {
        emitEvent({
          agentId: buyOrder.agentId,
          type: 'buyorder.matched',
          title: 'New listing matches your search',
          message: `"${listing.title}" is available for ${formatUsdc(listing.priceUsdc)} from ${listing.agent.name}.`,
          data: {
            buyOrderId: buyOrder.id,
            listingId: listing.id,
            listingTitle: listing.title,
            priceUsdc: Number(listing.priceUsdc),
            sellerName: listing.agent.name,
          },
        });
      }
    }
  }

  return matchCount;
}
