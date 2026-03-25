/**
 * Marketplace Connector Interface
 * 
 * Pluggable architecture for syndicating Agora listings to external marketplaces.
 * Each connector implements this interface to provide create/update/delist/search/sync.
 */

// ─── External Listing / Order Types ─────────────────────────────────

export interface ExternalListing {
  externalId: string;
  marketplace: string;
  title: string;
  description: string;
  priceUsd: number;
  currency: string;
  condition: string;
  category: string;
  url: string;
  imageUrls: string[];
  sellerName?: string;
  sellerRating?: number;
  location?: string;
  shippingCost?: number;
  freeShipping?: boolean;
  itemEndDate?: Date;
  rawData?: Record<string, unknown>;
}

export interface ExternalOrder {
  externalId: string;
  marketplace: string;
  buyerName?: string;
  buyerEmail?: string;
  items: ExternalOrderItem[];
  totalUsd: number;
  status: string;
  shippingAddress?: Record<string, string>;
  paidAt?: Date;
  createdAt: Date;
  rawData?: Record<string, unknown>;
}

export interface ExternalOrderItem {
  externalListingId: string;
  title: string;
  quantity: number;
  priceUsd: number;
}

// ─── Agora Listing (simplified for connector use) ───────────────────

export interface AgoraListing {
  id: string;
  title: string;
  description: string;
  priceUsdc: bigint;
  priceSol?: bigint | null;
  category: string;
  condition: string; // new, like_new, good, fair, poor
  images: string[];
  quantity: number;
  metadata: Record<string, unknown>;
}

// ─── Syndication Result ─────────────────────────────────────────────

export interface SyndicationResult {
  externalId: string;
  url: string;
  marketplace: string;
}

export interface SyndicationStatus {
  marketplace: string;
  externalId: string;
  url: string;
  status: 'active' | 'ended' | 'error' | 'unknown';
  syncedAt: Date;
}

// ─── Marketplace Connector Interface ────────────────────────────────

export interface MarketplaceConnector {
  /** Unique name of this marketplace (e.g. "ebay", "mercari") */
  readonly name: string;

  /**
   * Create a listing on the external marketplace.
   * @returns External listing ID and URL.
   */
  createListing(listing: AgoraListing): Promise<SyndicationResult>;

  /**
   * Update an existing external listing.
   */
  updateListing(externalId: string, updates: Partial<AgoraListing>): Promise<void>;

  /**
   * Remove / end a listing on the external marketplace.
   */
  delistItem(externalId: string): Promise<void>;

  /**
   * Search the external marketplace.
   */
  searchListings(query: string, filters?: Record<string, unknown>): Promise<ExternalListing[]>;

  /**
   * Sync recent orders from the external marketplace.
   */
  syncOrders(): Promise<ExternalOrder[]>;
}

// ─── eBay-Specific Types ────────────────────────────────────────────

export interface EbayCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt?: Date;
}

export interface EbaySearchFilters {
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  condition?: string;
  sort?: 'price' | '-price' | 'date' | '-date' | 'distance' | 'match';
  limit?: number;
  offset?: number;
  buyingOptions?: string[]; // FIXED_PRICE, AUCTION, BEST_OFFER
  deliveryCountry?: string;
}

export interface EbaySearchResult {
  itemId: string;
  title: string;
  price: { value: string; currency: string };
  condition: string;
  conditionId: string;
  categoryPath: string;
  image: { imageUrl: string };
  additionalImages?: { imageUrl: string }[];
  itemWebUrl: string;
  seller: { username: string; feedbackPercentage: string; feedbackScore: number };
  shippingOptions?: { shippingCost: { value: string; currency: string }; type: string }[];
  itemLocation?: { city: string; stateOrProvince: string; country: string };
  buyingOptions: string[];
  itemEndDate?: string;
}

export interface EbayItemDetail extends EbaySearchResult {
  description: string;
  shortDescription?: string;
  brand?: string;
  mpn?: string;
  gtin?: string[];
  itemCreationDate: string;
  estimatedAvailabilities?: { estimatedAvailableQuantity: number }[];
  returnTerms?: { returnsAccepted: boolean; refundMethod: string; returnPeriod: { value: number; unit: string } };
}

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  pricingSummary: {
    total: { value: string; currency: string };
    priceSubtotal: { value: string; currency: string };
    deliveryCost?: { value: string; currency: string };
  };
  buyer: { username: string };
  lineItems: {
    lineItemId: string;
    title: string;
    quantity: number;
    lineItemCost: { value: string; currency: string };
    legacyItemId: string;
    sku?: string;
  }[];
  fulfillmentStartInstructions?: {
    shippingStep: {
      shipTo: {
        fullName: string;
        contactAddress: {
          addressLine1: string;
          addressLine2?: string;
          city: string;
          stateOrProvince: string;
          postalCode: string;
          countryCode: string;
        };
      };
    };
  }[];
}

// ─── Marketplace Config ─────────────────────────────────────────────

export interface EbayConfig {
  appId: string;
  certId: string;
  devId: string;
  redirectUri: string;
  sandbox: boolean;
  /** Configurable USDC-to-USD rate (default 1.0) */
  usdcToUsdRate: number;
}
