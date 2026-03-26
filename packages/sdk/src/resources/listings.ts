import type { AgoraClient } from '../client';
import type {
  CreateListingRequest,
  UpdateListingRequest,
  SearchListingsParams,
  Listing,
  ListingResponse,
  ListingsResponse,
  DeleteListingResponse,
} from '../types';

export class ListingsResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Create a new listing.
   *
   * priceUsdc is an integer (whole USDC). E.g. 850 = $850.
   * Valid conditions: new, like_new, good, fair, poor.
   */
  async create(data: CreateListingRequest): Promise<Listing> {
    const res = await this.client.request<ListingResponse>('POST', '/listings', {
      body: data,
    });
    return res.listing;
  }

  /**
   * Get a single listing by ID. No authentication required.
   */
  async get(id: string): Promise<Listing> {
    const res = await this.client.request<ListingResponse>('GET', `/listings/${id}`, {
      auth: false,
    });
    return res.listing;
  }

  /**
   * Search and filter listings. No authentication required.
   *
   * Supports: query, category, condition, status, sellerId, priceMin, priceMax, page, limit.
   */
  async search(params: SearchListingsParams = {}): Promise<ListingsResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.query) query.query = params.query;
    if (params.category) query.category = params.category;
    if (params.condition) query.condition = params.condition;
    if (params.status) query.status = params.status;
    if (params.sellerId) query.sellerId = params.sellerId;
    if (params.priceMin !== undefined) query.priceMin = params.priceMin;
    if (params.priceMax !== undefined) query.priceMax = params.priceMax;
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<ListingsResponse>('GET', '/listings', {
      query,
      auth: false,
    });
  }

  /**
   * List all listings (alias for search with no params).
   */
  async list(params: SearchListingsParams = {}): Promise<ListingsResponse> {
    return this.search(params);
  }

  /**
   * Update a listing. Only the listing owner can update.
   */
  async update(id: string, data: UpdateListingRequest): Promise<Listing> {
    const res = await this.client.request<ListingResponse>('PUT', `/listings/${id}`, {
      body: data,
    });
    return res.listing;
  }

  /**
   * Delete (delist) a listing. Only the listing owner can delist.
   * This is a soft delete — sets status to "delisted".
   */
  async delete(id: string): Promise<DeleteListingResponse> {
    return this.client.request<DeleteListingResponse>('DELETE', `/listings/${id}`);
  }
}
