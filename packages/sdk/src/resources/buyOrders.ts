import type { AgoraClient } from '../client';
import type {
  CreateBuyOrderRequest,
  UpdateBuyOrderRequest,
  CreateBuyOrderResponse,
  BuyOrder,
  BuyOrdersResponse,
  BuyOrderMatchesResponse,
  Listing,
} from '../types';

export class BuyOrdersResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Create a buy order. Agora matches you when listings appear.
   */
  async create(data: CreateBuyOrderRequest): Promise<CreateBuyOrderResponse> {
    return this.client.request<CreateBuyOrderResponse>('POST', '/buy-orders', {
      body: data,
    });
  }

  /**
   * List your buy orders.
   */
  async list(params: { page?: number; limit?: number } = {}): Promise<BuyOrdersResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<BuyOrdersResponse>('GET', '/buy-orders', { query });
  }

  /**
   * Update a buy order.
   */
  async update(id: string, data: UpdateBuyOrderRequest): Promise<BuyOrder> {
    const res = await this.client.request<{ buyOrder: BuyOrder }>(
      'PUT',
      `/buy-orders/${id}`,
      { body: data },
    );
    return res.buyOrder;
  }

  /**
   * Cancel (delete) a buy order.
   */
  async cancel(id: string): Promise<{ message: string }> {
    return this.client.request<{ message: string }>('DELETE', `/buy-orders/${id}`);
  }

  /**
   * Get matching listings for a buy order.
   */
  async matches(id: string): Promise<BuyOrderMatchesResponse> {
    return this.client.request<BuyOrderMatchesResponse>('GET', `/buy-orders/${id}/matches`);
  }
}
