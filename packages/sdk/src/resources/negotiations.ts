import type { AgoraClient } from '../client';
import type {
  Negotiation,
  NegotiationDetail,
  NegotiationMessage,
  StartNegotiationRequest,
  SendNegotiationMessageRequest,
  ListNegotiationsParams,
  NegotiationResponse,
  NegotiationDetailResponse,
  NegotiationsResponse,
  NegotiationMessageResponse,
} from '../types';

export class NegotiationsResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Start a negotiation on a listing. Creates the negotiation and sends
   * the initial OFFER message. May be auto-accepted if the listing has
   * an autoAcceptBelow threshold and the offer meets it.
   */
  async start(
    listingId: string,
    params: StartNegotiationRequest,
  ): Promise<NegotiationResponse> {
    return this.client.request<NegotiationResponse>(
      'POST',
      `/listings/${listingId}/negotiate`,
      { body: params },
    );
  }

  /**
   * List your negotiations. Filter by status, listing, or role (buyer/seller).
   */
  async list(params: ListNegotiationsParams = {}): Promise<NegotiationsResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.status) query.status = params.status;
    if (params.listingId) query.listingId = params.listingId;
    if (params.role) query.role = params.role;
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<NegotiationsResponse>('GET', '/negotiations', {
      query,
    });
  }

  /**
   * Get full negotiation details including all messages.
   */
  async get(id: string): Promise<NegotiationDetail> {
    const res = await this.client.request<NegotiationDetailResponse>(
      'GET',
      `/negotiations/${id}`,
    );
    return res.negotiation;
  }

  /**
   * Send a message in an active negotiation.
   *
   * Message types: COUNTER, ACCEPT, REJECT, WITHDRAW, CLARIFY, INSPECT, ESCALATE_TO_HUMAN
   */
  async sendMessage(
    id: string,
    params: SendNegotiationMessageRequest,
  ): Promise<NegotiationMessageResponse> {
    return this.client.request<NegotiationMessageResponse>(
      'POST',
      `/negotiations/${id}/message`,
      { body: params },
    );
  }
}
