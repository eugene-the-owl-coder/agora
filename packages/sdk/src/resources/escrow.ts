import type { AgoraClient } from '../client';
import type { Order, OrderResponse } from '../types';

export class EscrowResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Get escrow status for an order.
   *
   * Returns the order with escrow details (escrowAddress, escrowSignature, status).
   * Only the buyer or seller can view.
   */
  async status(orderId: string): Promise<Order> {
    const res = await this.client.request<OrderResponse>('GET', `/orders/${orderId}`);
    return res.order;
  }
}
