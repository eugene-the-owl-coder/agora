import type { AgoraClient } from '../client';
import type {
  ShippingQuoteRequest,
  ShippingQuotesResponse,
  CarriersResponse,
  Carrier,
  ShippingQuote,
  TrackingResponse,
  AddTrackingRequest,
  AddTrackingResponse,
  ShippingRateParams,
  ShippingRatesResponse,
} from '../types';

export class ShippingResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Get multi-carrier shipping quotes.
   * No authentication required.
   */
  async quotes(data: ShippingQuoteRequest): Promise<ShippingQuotesResponse> {
    return this.client.request<ShippingQuotesResponse>('POST', '/shipping/quotes', {
      body: data,
      auth: false,
    });
  }

  /**
   * List available carrier plugins.
   * No authentication required.
   */
  async carriers(): Promise<Carrier[]> {
    const res = await this.client.request<CarriersResponse>('GET', '/shipping/carriers', {
      auth: false,
    });
    return res.carriers;
  }

  /**
   * Get tracking info for an order.
   * Requires authentication. Only buyer or seller can view.
   */
  async tracking(orderId: string): Promise<TrackingResponse['tracking']> {
    const res = await this.client.request<TrackingResponse>(
      'GET',
      `/orders/${orderId}/tracking`,
    );
    return res.tracking;
  }

  /**
   * Add tracking info to an order (seller only).
   * This also marks the order as fulfilled and records on-chain.
   */
  async addTracking(orderId: string, data: AddTrackingRequest): Promise<AddTrackingResponse['tracking']> {
    const res = await this.client.request<AddTrackingResponse>(
      'POST',
      `/orders/${orderId}/tracking`,
      { body: data },
    );
    return res.tracking;
  }

  /**
   * Legacy: Get FedEx-style shipping rates.
   * No authentication required.
   */
  async rates(params: ShippingRateParams): Promise<ShippingRatesResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.listingId) query.listingId = params.listingId;
    if (params.originPostalCode) query.originPostalCode = params.originPostalCode;
    if (params.weight !== undefined) query.weight = params.weight;
    if (params.length !== undefined) query.length = params.length;
    if (params.width !== undefined) query.width = params.width;
    if (params.height !== undefined) query.height = params.height;
    if (params.destPostalCode) query.destPostalCode = params.destPostalCode;
    if (params.destZip) query.destZip = params.destZip;
    if (params.destCountry) query.destCountry = params.destCountry;

    return this.client.request<ShippingRatesResponse>('GET', '/shipping/rates', {
      query,
      auth: false,
    });
  }
}
