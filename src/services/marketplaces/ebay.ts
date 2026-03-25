/**
 * eBay Marketplace Connector
 *
 * Integrates with eBay REST APIs:
 * - Browse API (search/discovery) — app-level token
 * - Inventory API (create/update inventory items) — user-level token
 * - Offer API (create offers → publish to eBay) — user-level token
 * - Fulfillment API (orders) — user-level token
 *
 * Supports sandbox (EBAY_SANDBOX=true) and production modes.
 * Handles OAuth2 (client credentials + authorization code flows).
 * Respects eBay rate limits via X-RateLimit headers.
 */

import { config } from '../../config';
import { encrypt, decrypt } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import type {
  AgoraListing,
  EbayConfig,
  EbayCredentials,
  EbaySearchFilters,
  EbaySearchResult,
  EbayItemDetail,
  EbayOrder,
  ExternalListing,
  ExternalOrder,
  MarketplaceConnector,
  SyndicationResult,
} from './types';
import {
  agoraToEbayInventoryItem,
  agoraToEbayOffer,
  ebaySearchToExternal,
  ebayOrderToExternal,
  usdcToUsd,
} from './ebayMapper';

// ─── eBay API Base URLs ─────────────────────────────────────────────

const EBAY_SANDBOX_API = 'https://api.sandbox.ebay.com';
const EBAY_PRODUCTION_API = 'https://api.ebay.com';
const EBAY_SANDBOX_AUTH = 'https://auth.sandbox.ebay.com';
const EBAY_PRODUCTION_AUTH = 'https://auth.ebay.com';

// ─── Rate Limit State ───────────────────────────────────────────────

interface RateLimitState {
  remaining: number;
  limit: number;
  resetTime: number; // epoch ms
}

const rateLimits = new Map<string, RateLimitState>();

// ─── eBay Service ───────────────────────────────────────────────────

export class EbayService {
  private appId: string;
  private certId: string;
  private devId: string;
  private redirectUri: string;
  private sandbox: boolean;
  private usdcToUsdRate: number;
  private appToken: string | null = null;
  private appTokenExpiresAt: number = 0;

  constructor(ebayConfig?: Partial<EbayConfig>) {
    this.appId = ebayConfig?.appId || config.ebay.appId;
    this.certId = ebayConfig?.certId || config.ebay.certId;
    this.devId = ebayConfig?.devId || config.ebay.devId;
    this.redirectUri = ebayConfig?.redirectUri || config.ebay.redirectUri;
    this.sandbox = ebayConfig?.sandbox ?? config.ebay.sandbox;
    this.usdcToUsdRate = ebayConfig?.usdcToUsdRate ?? config.ebay.usdcToUsdRate;
  }

  private get apiBase(): string {
    return this.sandbox ? EBAY_SANDBOX_API : EBAY_PRODUCTION_API;
  }

  private get authBase(): string {
    return this.sandbox ? EBAY_SANDBOX_AUTH : EBAY_PRODUCTION_AUTH;
  }

  // ─── OAuth2: Client Credentials (App Token) ────────────────────

  /**
   * Get an application-level token (client credentials grant).
   * Used for Browse API searches (no user context needed).
   */
  async getAppToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.appToken && Date.now() < this.appTokenExpiresAt - 60_000) {
      return this.appToken;
    }

    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'https://api.ebay.com/oauth/api_scope',
        }).toString(),
      },
      'oauth-token',
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error('eBay app token failed', { status: response.status, body: err });
      throw new Error(`eBay OAuth failed: ${response.status} ${err}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.appToken = data.access_token;
    this.appTokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.appToken!;
  }

  // ─── OAuth2: Authorization Code (User Token) ───────────────────

  /**
   * Generate the eBay OAuth consent URL.
   * The agent/user visits this URL, authorizes, and gets redirected with an auth code.
   */
  getAuthUrl(state?: string): string {
    const scopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.marketing',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ];

    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      ...(state ? { state } : {}),
    });

    return `${this.authBase}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for user access + refresh tokens.
   */
  async getUserToken(authCode: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: this.redirectUri,
        }).toString(),
      },
      'oauth-token',
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error('eBay user token exchange failed', { status: response.status, body: err });
      throw new Error(`eBay user token failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh a user-level token using a refresh token.
   */
  async refreshUserToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const credentials = Buffer.from(`${this.appId}:${this.certId}`).toString('base64');

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/identity/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: [
            'https://api.ebay.com/oauth/api_scope',
            'https://api.ebay.com/oauth/api_scope/sell.inventory',
            'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
          ].join(' '),
        }).toString(),
      },
      'oauth-token',
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error('eBay token refresh failed', { status: response.status, body: err });
      throw new Error(`eBay token refresh failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  // ─── Selling: Inventory + Offer API ─────────────────────────────

  /**
   * Create a listing on eBay using the Inventory API workflow:
   * 1. Create/replace inventory item (PUT /sell/inventory/v1/inventory_item/{sku})
   * 2. Create offer (POST /sell/inventory/v1/offer)
   * 3. Publish offer (POST /sell/inventory/v1/offer/{offerId}/publish)
   *
   * Returns the eBay listing ID.
   */
  async createListing(listing: AgoraListing, creds: EbayCredentials): Promise<SyndicationResult> {
    const accessToken = await this.ensureValidToken(creds);

    // Step 1: Create inventory item
    const { sku, inventoryItem, priceUsd } = agoraToEbayInventoryItem(listing, this.usdcToUsdRate);

    const invResponse = await this.fetchWithRateLimit(
      `${this.apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(inventoryItem),
      },
      'sell-inventory',
    );

    if (!invResponse.ok && invResponse.status !== 204) {
      const err = await invResponse.text();
      logger.error('eBay createInventoryItem failed', { status: invResponse.status, body: err, sku });
      throw new Error(`eBay inventory item creation failed: ${invResponse.status} ${err}`);
    }

    logger.info('eBay inventory item created', { sku });

    // Step 2: Create offer
    const offerData = agoraToEbayOffer(listing, sku, this.usdcToUsdRate);

    const offerResponse = await this.fetchWithRateLimit(
      `${this.apiBase}/sell/inventory/v1/offer`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(offerData),
      },
      'sell-inventory',
    );

    if (!offerResponse.ok) {
      const err = await offerResponse.text();
      logger.error('eBay createOffer failed', { status: offerResponse.status, body: err, sku });
      throw new Error(`eBay offer creation failed: ${offerResponse.status} ${err}`);
    }

    const offer = await offerResponse.json() as { offerId: string };
    const offerId = offer.offerId;
    logger.info('eBay offer created', { offerId, sku });

    // Step 3: Publish offer
    const publishResponse = await this.fetchWithRateLimit(
      `${this.apiBase}/sell/inventory/v1/offer/${offerId}/publish`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
      'sell-inventory',
    );

    if (!publishResponse.ok) {
      const err = await publishResponse.text();
      logger.error('eBay publishOffer failed', { status: publishResponse.status, body: err, offerId });
      throw new Error(`eBay offer publish failed: ${publishResponse.status} ${err}`);
    }

    const published = await publishResponse.json() as { listingId: string };
    const listingId = published.listingId;
    const isSandbox = this.sandbox;
    const url = isSandbox
      ? `https://www.sandbox.ebay.com/itm/${listingId}`
      : `https://www.ebay.com/itm/${listingId}`;

    logger.info('eBay listing published', { listingId, offerId, sku, url });

    return {
      externalId: listingId,
      url,
      marketplace: 'ebay',
    };
  }

  /**
   * Update an existing eBay listing.
   * Updates inventory item and offer pricing/quantity.
   */
  async updateListing(ebayListingId: string, updates: Partial<AgoraListing>, creds: EbayCredentials): Promise<void> {
    const accessToken = await this.ensureValidToken(creds);

    // The SKU is the Agora listing ID stored in externalListings metadata.
    // For update, we need the SKU. The caller should provide it via updates.id or metadata.
    const sku = updates.id || ebayListingId;

    // Update inventory item if product details changed
    if (updates.title || updates.description || updates.images || updates.condition || updates.quantity) {
      const inventoryItemUpdate: Record<string, unknown> = {};

      if (updates.quantity !== undefined) {
        inventoryItemUpdate.availability = {
          shipToLocationAvailability: { quantity: updates.quantity },
        };
      }

      if (updates.title || updates.description || updates.images) {
        const product: Record<string, unknown> = {};
        if (updates.title) product.title = updates.title.substring(0, 80);
        if (updates.description) product.description = updates.description;
        if (updates.images) product.imageUrls = updates.images.slice(0, 12);
        inventoryItemUpdate.product = product;
      }

      if (updates.condition) {
        const condMap: Record<string, string> = {
          new: '1000', like_new: '1500', good: '3000', fair: '5000', poor: '6000',
        };
        inventoryItemUpdate.condition = condMap[updates.condition] || '3000';
      }

      const response = await this.fetchWithRateLimit(
        `${this.apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
          },
          body: JSON.stringify(inventoryItemUpdate),
        },
        'sell-inventory',
      );

      if (!response.ok && response.status !== 204) {
        const err = await response.text();
        throw new Error(`eBay inventory update failed: ${response.status} ${err}`);
      }
    }

    // Update offer pricing if price changed
    if (updates.priceUsdc) {
      const priceUsd = usdcToUsd(updates.priceUsdc, this.usdcToUsdRate);

      // Get existing offers for this SKU
      const offersResponse = await this.fetchWithRateLimit(
        `${this.apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${accessToken}` },
        },
        'sell-inventory',
      );

      if (offersResponse.ok) {
        const offersData = await offersResponse.json() as { offers?: { offerId: string; [k: string]: unknown }[] };
        const offers = offersData.offers || [];

        for (const offer of offers) {
          await this.fetchWithRateLimit(
            `${this.apiBase}/sell/inventory/v1/offer/${offer.offerId}`,
            {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Content-Language': 'en-US',
              },
              body: JSON.stringify({
                ...offer,
                pricingSummary: {
                  price: { value: priceUsd.toFixed(2), currency: 'USD' },
                },
              }),
            },
            'sell-inventory',
          );
        }
      }
    }

    logger.info('eBay listing updated', { ebayListingId, sku });
  }

  /**
   * End/delist an item on eBay by withdrawing its offer.
   */
  async delistItem(ebayListingId: string, creds: EbayCredentials): Promise<void> {
    const accessToken = await this.ensureValidToken(creds);

    // Use the Trading API's EndItem equivalent via Inventory API:
    // We withdraw the offer, which ends the listing.
    // First, get offers for this listing's SKU
    const sku = ebayListingId; // SKU = Agora listing ID

    const offersResponse = await this.fetchWithRateLimit(
      `${this.apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      },
      'sell-inventory',
    );

    if (offersResponse.ok) {
      const offersData = await offersResponse.json() as { offers?: { offerId: string; status: string }[] };
      const offers = offersData.offers || [];

      for (const offer of offers) {
        if (offer.status === 'PUBLISHED') {
          // Withdraw the offer (ends the listing)
          await this.fetchWithRateLimit(
            `${this.apiBase}/sell/inventory/v1/offer/${offer.offerId}/withdraw`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}` },
            },
            'sell-inventory',
          );
        }
      }
    }

    // Delete the inventory item
    await this.fetchWithRateLimit(
      `${this.apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      },
      'sell-inventory',
    );

    logger.info('eBay listing delisted', { ebayListingId, sku });
  }

  // ─── Buying / Search: Browse API ────────────────────────────────

  /**
   * Search eBay listings using the Browse API.
   * Uses application-level token (no user auth needed).
   */
  async searchListings(query: string, filters?: EbaySearchFilters): Promise<ExternalListing[]> {
    const token = await this.getAppToken();

    const params = new URLSearchParams({ q: query });

    if (filters?.categoryId) params.set('category_ids', filters.categoryId);
    if (filters?.limit) params.set('limit', String(Math.min(filters.limit, 200)));
    if (filters?.offset) params.set('offset', String(filters.offset));
    if (filters?.sort) {
      const sortMap: Record<string, string> = {
        'price': 'price', '-price': '-price',
        'date': 'newlyListed', '-date': '-newlyListed',
        'distance': 'distance', 'match': 'bestMatch',
      };
      params.set('sort', sortMap[filters.sort] || 'bestMatch');
    }

    // Build filter string
    const filterParts: string[] = [];
    if (filters?.minPrice !== undefined) filterParts.push(`price:[${filters.minPrice}]`);
    if (filters?.maxPrice !== undefined) filterParts.push(`price:[..${filters.maxPrice}]`);
    if (filters?.condition) filterParts.push(`conditions:{${filters.condition}}`);
    if (filters?.buyingOptions?.length) filterParts.push(`buyingOptions:{${filters.buyingOptions.join('|')}}`);
    if (filters?.deliveryCountry) filterParts.push(`deliveryCountry:${filters.deliveryCountry}`);

    if (filterParts.length > 0) params.set('filter', filterParts.join(','));

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/buy/browse/v1/item_summary/search?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      },
      'buy-browse',
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error('eBay search failed', { status: response.status, body: err, query });
      throw new Error(`eBay search failed: ${response.status}`);
    }

    const data = await response.json() as { itemSummaries?: EbaySearchResult[] };
    const items: EbaySearchResult[] = data.itemSummaries || [];

    return items.map(ebaySearchToExternal);
  }

  /**
   * Get detailed info about a specific eBay item.
   */
  async getListingDetails(itemId: string): Promise<EbayItemDetail> {
    const token = await this.getAppToken();

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      },
      'buy-browse',
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`eBay getItem failed: ${response.status} ${err}`);
    }

    return response.json() as Promise<EbayItemDetail>;
  }

  // ─── Orders: Fulfillment API ────────────────────────────────────

  /**
   * Get recent orders from eBay.
   */
  async getOrders(creds: EbayCredentials, since?: Date): Promise<ExternalOrder[]> {
    const accessToken = await this.ensureValidToken(creds);

    const params = new URLSearchParams({ limit: '50' });
    if (since) {
      params.set('filter', `creationdate:[${since.toISOString()}]`);
    }

    const response = await this.fetchWithRateLimit(
      `${this.apiBase}/sell/fulfillment/v1/order?${params.toString()}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      },
      'sell-fulfillment',
    );

    if (!response.ok) {
      const err = await response.text();
      logger.error('eBay getOrders failed', { status: response.status, body: err });
      throw new Error(`eBay getOrders failed: ${response.status}`);
    }

    const data = await response.json() as { orders?: EbayOrder[] };
    const orders: EbayOrder[] = data.orders || [];

    return orders.map(ebayOrderToExternal);
  }

  // ─── Token Management ───────────────────────────────────────────

  /**
   * Ensure we have a valid access token, refreshing if needed.
   */
  private async ensureValidToken(creds: EbayCredentials): Promise<string> {
    // If token has an expiry and it's still valid, use it
    if (creds.expiresAt && new Date(creds.expiresAt) > new Date(Date.now() + 60_000)) {
      return creds.accessToken;
    }

    // Try to refresh
    if (creds.refreshToken) {
      try {
        const refreshed = await this.refreshUserToken(creds.refreshToken);
        creds.accessToken = refreshed.accessToken;
        creds.expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
        return creds.accessToken;
      } catch (err) {
        logger.warn('eBay token refresh failed, using existing token', {
          error: (err as Error).message,
        });
      }
    }

    return creds.accessToken;
  }

  // ─── Rate Limit Handling ────────────────────────────────────────

  /**
   * Wrapper around fetch that respects eBay rate limit headers.
   * If rate limited (429), waits and retries once.
   */
  private async fetchWithRateLimit(
    url: string,
    options: RequestInit,
    apiGroup: string,
  ): Promise<Response> {
    // Check if we're rate limited for this API group
    const state = rateLimits.get(apiGroup);
    if (state && state.remaining <= 0 && Date.now() < state.resetTime) {
      const waitMs = state.resetTime - Date.now();
      logger.warn('eBay rate limit reached, waiting', { apiGroup, waitMs });
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
    }

    let response = await fetch(url, options);

    // Parse rate limit headers
    this.updateRateLimits(response, apiGroup);

    // If 429, wait and retry once
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5_000;
      logger.warn('eBay 429 rate limited, retrying', { apiGroup, waitMs });
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));

      response = await fetch(url, options);
      this.updateRateLimits(response, apiGroup);
    }

    return response;
  }

  private updateRateLimits(response: Response, apiGroup: string): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining !== null || limit !== null) {
      rateLimits.set(apiGroup, {
        remaining: remaining ? parseInt(remaining, 10) : 999,
        limit: limit ? parseInt(limit, 10) : 999,
        resetTime: reset ? Date.now() + parseInt(reset, 10) * 1000 : Date.now() + 60_000,
      });
    }
  }
}

// ─── MarketplaceConnector Adapter ───────────────────────────────────

/**
 * Wraps EbayService to conform to the MarketplaceConnector interface.
 * Requires user credentials to be set before use.
 */
export class EbayMarketplaceConnector implements MarketplaceConnector {
  readonly name = 'ebay';
  private service: EbayService;
  private credentials: EbayCredentials | null = null;

  constructor(ebayConfig?: Partial<EbayConfig>) {
    this.service = new EbayService(ebayConfig);
  }

  /** Set user credentials for sell/order operations. */
  setCredentials(creds: EbayCredentials): void {
    this.credentials = creds;
  }

  private requireCredentials(): EbayCredentials {
    if (!this.credentials) {
      throw new Error('eBay credentials not set. Call setCredentials() first.');
    }
    return this.credentials;
  }

  async createListing(listing: AgoraListing): Promise<SyndicationResult> {
    return this.service.createListing(listing, this.requireCredentials());
  }

  async updateListing(externalId: string, updates: Partial<AgoraListing>): Promise<void> {
    return this.service.updateListing(externalId, updates, this.requireCredentials());
  }

  async delistItem(externalId: string): Promise<void> {
    return this.service.delistItem(externalId, this.requireCredentials());
  }

  async searchListings(query: string, filters?: Record<string, unknown>): Promise<ExternalListing[]> {
    return this.service.searchListings(query, filters as EbaySearchFilters);
  }

  async syncOrders(): Promise<ExternalOrder[]> {
    // Sync orders from last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return this.service.getOrders(this.requireCredentials(), since);
  }
}

// ─── Credential Encryption Helpers ──────────────────────────────────

/**
 * Encrypt eBay credentials for storage in the database.
 * Uses the same AES-256-GCM as wallet key encryption.
 */
export function encryptEbayCredentials(creds: EbayCredentials): string {
  return encrypt(JSON.stringify(creds));
}

/**
 * Decrypt stored eBay credentials.
 */
export function decryptEbayCredentials(encrypted: string): EbayCredentials {
  return JSON.parse(decrypt(encrypted));
}

// ─── Singleton ──────────────────────────────────────────────────────

let defaultEbayService: EbayService | null = null;

export function getEbayService(): EbayService {
  if (!defaultEbayService) {
    defaultEbayService = new EbayService();
  }
  return defaultEbayService;
}
