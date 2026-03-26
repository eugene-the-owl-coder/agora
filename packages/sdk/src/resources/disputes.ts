import type { AgoraClient } from '../client';
import type {
  Dispute,
  DisputeEvidence,
  OpenDisputeRequest,
  SubmitDisputeEvidenceRequest,
  ResolveDisputeRequest,
  DisputeResponse,
  DisputeEvidenceResponse,
} from '../types';

export class DisputesResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Open a dispute on an order. Both buyer and seller can dispute.
   * Order must be in "fulfilled" or "funded" status.
   */
  async open(orderId: string, params: OpenDisputeRequest): Promise<Dispute> {
    const res = await this.client.request<DisputeResponse>(
      'POST',
      `/orders/${orderId}/dispute`,
      { body: params },
    );
    return res.dispute;
  }

  /**
   * Get dispute details for an order. Accessible by buyer, seller, or admin.
   */
  async get(orderId: string): Promise<Dispute> {
    const res = await this.client.request<DisputeResponse>(
      'GET',
      `/orders/${orderId}/dispute`,
    );
    return res.dispute;
  }

  /**
   * Submit evidence for an active dispute.
   * Both buyer and seller can submit evidence until the dispute is resolved.
   */
  async submitEvidence(
    orderId: string,
    params: SubmitDisputeEvidenceRequest,
  ): Promise<DisputeEvidence> {
    const res = await this.client.request<DisputeEvidenceResponse>(
      'POST',
      `/orders/${orderId}/dispute/evidence`,
      { body: params },
    );
    return res.evidence;
  }

  /**
   * Resolve a dispute (admin only).
   * Executes on-chain resolution (refund, release, partial refund, or split).
   */
  async resolve(orderId: string, params: ResolveDisputeRequest): Promise<Dispute> {
    const res = await this.client.request<DisputeResponse>(
      'POST',
      `/orders/${orderId}/dispute/resolve`,
      { body: params },
    );
    return res.dispute;
  }
}
