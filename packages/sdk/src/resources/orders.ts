import type { AgoraClient } from '../client';
import type {
  CreateOrderRequest,
  FulfillOrderRequest,
  DisputeOrderRequest,
  ListOrdersParams,
  Order,
  OrderResponse,
  OrdersResponse,
} from '../types';

export class OrdersResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Create (place) an order to buy a listing.
   * Escrow is created automatically on the Solana blockchain.
   */
  async create(data: CreateOrderRequest): Promise<Order> {
    const res = await this.client.request<OrderResponse>('POST', '/orders', {
      body: data,
    });
    return res.order;
  }

  /**
   * Get a single order by ID. Only the buyer or seller can view.
   */
  async get(id: string): Promise<Order> {
    const res = await this.client.request<OrderResponse>('GET', `/orders/${id}`);
    return res.order;
  }

  /**
   * List your orders. Filter by role (buyer/seller) and status.
   */
  async list(params: ListOrdersParams = {}): Promise<OrdersResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.role) query.role = params.role;
    if (params.status) query.status = params.status;
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<OrdersResponse>('GET', '/orders', { query });
  }

  /**
   * Fulfill an order (seller marks as shipped).
   * Optionally include tracking number and carrier.
   */
  async fulfill(id: string, data: FulfillOrderRequest = {}): Promise<Order> {
    const res = await this.client.request<OrderResponse>('POST', `/orders/${id}/fulfill`, {
      body: data,
    });
    return res.order;
  }

  /**
   * Confirm receipt of an order (buyer).
   * Triggers escrow release to the seller.
   */
  async confirm(id: string): Promise<Order> {
    const res = await this.client.request<OrderResponse>('POST', `/orders/${id}/confirm`);
    return res.order;
  }

  /**
   * Cancel an order. Only possible when status is "created" or "funded".
   * If funded, escrow is refunded to the buyer.
   */
  async cancel(id: string): Promise<Order> {
    const res = await this.client.request<OrderResponse>('POST', `/orders/${id}/cancel`);
    return res.order;
  }

  /**
   * Open a dispute on an order. Both buyer and seller can dispute.
   */
  async dispute(id: string, data: DisputeOrderRequest): Promise<Order> {
    const res = await this.client.request<OrderResponse>('POST', `/orders/${id}/dispute`, {
      body: data,
    });
    return res.order;
  }
}
