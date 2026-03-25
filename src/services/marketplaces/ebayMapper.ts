/**
 * eBay Mapper — Converts between Agora and eBay data formats.
 *
 * Maps Agora listing fields ↔ eBay Inventory/Offer/Listing API fields,
 * conditions, categories, orders, and handles USDC→USD pricing.
 */

import type {
  AgoraListing,
  EbayOrder,
  ExternalListing,
  ExternalOrder,
} from './types';

// ─── Condition Mapping ──────────────────────────────────────────────

const AGORA_TO_EBAY_CONDITION: Record<string, { conditionId: string; conditionDescription: string }> = {
  new:      { conditionId: '1000', conditionDescription: 'New' },
  like_new: { conditionId: '1500', conditionDescription: 'New other (see details)' },
  good:     { conditionId: '3000', conditionDescription: 'Used' },
  fair:     { conditionId: '5000', conditionDescription: 'Good' },
  poor:     { conditionId: '6000', conditionDescription: 'Acceptable' },
};

const EBAY_CONDITION_TO_AGORA: Record<string, string> = {
  '1000': 'new',
  '1500': 'like_new',
  '1750': 'like_new',
  '2000': 'like_new',  // Certified Refurbished
  '2010': 'like_new',  // Excellent - Refurbished
  '2020': 'good',      // Very Good - Refurbished
  '2030': 'fair',      // Good - Refurbished
  '2500': 'like_new',  // Seller Refurbished
  '3000': 'good',      // Used
  '4000': 'good',      // Very Good
  '5000': 'fair',      // Good
  '6000': 'poor',      // Acceptable
  '7000': 'poor',      // For parts or not working
};

// ─── Category Mapping ───────────────────────────────────────────────

// Agora category → eBay category ID (top-level defaults; agents can override via metadata)
const AGORA_TO_EBAY_CATEGORY: Record<string, string> = {
  electronics:    '293',     // Electronics
  computers:      '58058',   // Computers/Tablets & Networking
  phones:         '9355',    // Cell Phones & Accessories
  clothing:       '11450',   // Clothing, Shoes & Accessories
  home:           '11700',   // Home & Garden
  toys:           '220',     // Toys & Hobbies
  collectibles:   '1',       // Collectibles
  books:          '267',     // Books
  sports:         '888',     // Sporting Goods
  automotive:     '6000',    // eBay Motors
  music:          '11233',   // Music
  games:          '1249',    // Video Games & Consoles
  art:            '550',     // Art
  jewelry:        '281',     // Jewelry & Watches
  health:         '26395',   // Health & Beauty
  other:          '99',      // Everything Else
};

const EBAY_CATEGORY_TO_AGORA: Record<string, string> = {};
for (const [agora, ebay] of Object.entries(AGORA_TO_EBAY_CATEGORY)) {
  EBAY_CATEGORY_TO_AGORA[ebay] = agora;
}

// ─── Pricing ────────────────────────────────────────────────────────

/**
 * Convert USDC amount (6 decimals, stored as bigint) to USD number.
 * Uses configurable rate (defaults to 1:1 since USDC is pegged).
 */
export function usdcToUsd(amountUsdc: bigint, rate: number = 1.0): number {
  const usdcFloat = Number(amountUsdc) / 1_000_000;
  return Math.round(usdcFloat * rate * 100) / 100; // round to cents
}

/**
 * Convert USD number to USDC bigint (6 decimals).
 */
export function usdToUsdc(amountUsd: number, rate: number = 1.0): bigint {
  return BigInt(Math.round((amountUsd / rate) * 1_000_000));
}

// ─── Listing → eBay Inventory Item ──────────────────────────────────

export function agoraToEbayInventoryItem(listing: AgoraListing, rate: number = 1.0) {
  const condition = AGORA_TO_EBAY_CONDITION[listing.condition] || AGORA_TO_EBAY_CONDITION.good;
  const priceUsd = usdcToUsd(listing.priceUsdc, rate);

  // SKU is the Agora listing ID (unique per inventory item)
  const sku = listing.id;

  // eBay Inventory API: createOrReplaceInventoryItem
  const inventoryItem: Record<string, unknown> = {
    availability: {
      shipToLocationAvailability: {
        quantity: listing.quantity,
      },
    },
    condition: condition.conditionId,
    conditionDescription: condition.conditionDescription,
    product: {
      title: listing.title.substring(0, 80), // eBay max 80 chars
      description: listing.description,
      imageUrls: listing.images.length > 0 ? listing.images.slice(0, 12) : undefined, // eBay max 12
      aspects: buildAspects(listing),
    },
  };

  return { sku, inventoryItem, priceUsd };
}

/**
 * Build eBay product aspects from Agora metadata.
 * Aspects are key-value pairs like { "Brand": ["Apple"], "Color": ["Black"] }.
 */
function buildAspects(listing: AgoraListing): Record<string, string[]> | undefined {
  const meta = listing.metadata || {};
  const aspects: Record<string, string[]> = {};

  if (meta.brand) aspects['Brand'] = [String(meta.brand)];
  if (meta.color) aspects['Color'] = [String(meta.color)];
  if (meta.size) aspects['Size'] = [String(meta.size)];
  if (meta.model) aspects['Model'] = [String(meta.model)];
  if (meta.material) aspects['Material'] = [String(meta.material)];

  // Pass through any ebayAspects directly from metadata
  if (meta.ebayAspects && typeof meta.ebayAspects === 'object') {
    Object.assign(aspects, meta.ebayAspects);
  }

  return Object.keys(aspects).length > 0 ? aspects : undefined;
}

// ─── Listing → eBay Offer ───────────────────────────────────────────

export function agoraToEbayOffer(
  listing: AgoraListing,
  sku: string,
  rate: number = 1.0,
) {
  const priceUsd = usdcToUsd(listing.priceUsdc, rate);
  const ebayCategoryId = (listing.metadata as any)?.ebayCategoryId
    || AGORA_TO_EBAY_CATEGORY[listing.category]
    || AGORA_TO_EBAY_CATEGORY.other;

  return {
    sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    listingDescription: listing.description,
    availableQuantity: listing.quantity,
    categoryId: ebayCategoryId,
    listingPolicies: {
      // These require policy IDs from the seller's eBay account.
      // Agents provide these via metadata or the platform has defaults.
      fulfillmentPolicyId: (listing.metadata as any)?.ebayFulfillmentPolicyId || '',
      paymentPolicyId: (listing.metadata as any)?.ebayPaymentPolicyId || '',
      returnPolicyId: (listing.metadata as any)?.ebayReturnPolicyId || '',
    },
    pricingSummary: {
      price: {
        value: priceUsd.toFixed(2),
        currency: 'USD',
      },
    },
    merchantLocationKey: (listing.metadata as any)?.ebayLocationKey || undefined,
  };
}

// ─── eBay Search Result → External Listing ──────────────────────────

export function ebaySearchToExternal(item: any): ExternalListing {
  const conditionId = item.conditionId || item.condition?.conditionId || '';
  const agoraCondition = EBAY_CONDITION_TO_AGORA[conditionId] || 'good';

  // Try to map eBay category to Agora category
  const categoryParts = (item.categoryPath || '').split('|').map((s: string) => s.trim());
  const topCategory = categoryParts[0] || '';
  let agoraCategory = 'other';
  for (const [ebayId, agoraCat] of Object.entries(EBAY_CATEGORY_TO_AGORA)) {
    if (item.categoryId === ebayId) {
      agoraCategory = agoraCat;
      break;
    }
  }

  return {
    externalId: item.itemId,
    marketplace: 'ebay',
    title: item.title || '',
    description: item.shortDescription || item.description || '',
    priceUsd: parseFloat(item.price?.value || '0'),
    currency: item.price?.currency || 'USD',
    condition: agoraCondition,
    category: agoraCategory,
    url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
    imageUrls: [
      item.image?.imageUrl,
      ...(item.additionalImages || []).map((img: any) => img.imageUrl),
    ].filter(Boolean),
    sellerName: item.seller?.username,
    sellerRating: item.seller?.feedbackScore,
    location: item.itemLocation
      ? `${item.itemLocation.city || ''}, ${item.itemLocation.stateOrProvince || ''}, ${item.itemLocation.country || ''}`
      : undefined,
    shippingCost: item.shippingOptions?.[0]?.shippingCost
      ? parseFloat(item.shippingOptions[0].shippingCost.value)
      : undefined,
    freeShipping: item.shippingOptions?.[0]?.shippingCost?.value === '0.00',
    itemEndDate: item.itemEndDate ? new Date(item.itemEndDate) : undefined,
    rawData: item,
  };
}

// ─── eBay Order → External Order ────────────────────────────────────

export function ebayOrderToExternal(order: EbayOrder): ExternalOrder {
  const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const addr = shipTo?.contactAddress;

  return {
    externalId: order.orderId,
    marketplace: 'ebay',
    buyerName: shipTo?.fullName || order.buyer?.username,
    items: order.lineItems.map((li) => ({
      externalListingId: li.legacyItemId,
      title: li.title,
      quantity: li.quantity,
      priceUsd: parseFloat(li.lineItemCost?.value || '0'),
    })),
    totalUsd: parseFloat(order.pricingSummary?.total?.value || '0'),
    status: mapEbayOrderStatus(order.orderFulfillmentStatus, order.orderPaymentStatus),
    shippingAddress: addr
      ? {
          name: shipTo?.fullName || '',
          address1: addr.addressLine1 || '',
          address2: addr.addressLine2 || '',
          city: addr.city || '',
          state: addr.stateOrProvince || '',
          zip: addr.postalCode || '',
          country: addr.countryCode || '',
        }
      : undefined,
    createdAt: new Date(order.creationDate),
    rawData: order as unknown as Record<string, unknown>,
  };
}

function mapEbayOrderStatus(fulfillment: string, payment: string): string {
  if (payment === 'PAID' && fulfillment === 'NOT_STARTED') return 'funded';
  if (payment === 'PAID' && fulfillment === 'IN_PROGRESS') return 'fulfilled';
  if (payment === 'PAID' && fulfillment === 'FULFILLED') return 'completed';
  if (payment === 'PENDING') return 'created';
  if (payment === 'FAILED') return 'cancelled';
  return 'unknown';
}

// ─── Exports ────────────────────────────────────────────────────────

export {
  AGORA_TO_EBAY_CONDITION,
  EBAY_CONDITION_TO_AGORA,
  AGORA_TO_EBAY_CATEGORY,
  EBAY_CATEGORY_TO_AGORA,
};
