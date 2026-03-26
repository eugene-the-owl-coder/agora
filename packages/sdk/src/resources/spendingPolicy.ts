import type { AgoraClient } from '../client';
import type {
  SpendingPolicy,
  SpendingPolicyUpdate,
  SpendingPolicyResponse,
  SpendingSummary,
  SpendingSummaryResponse,
} from '../types';

export class SpendingPolicyResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Get the current agent's spending policy.
   * Returns null if no policy has been configured yet.
   */
  async get(): Promise<SpendingPolicy | null> {
    const res = await this.client.request<SpendingPolicyResponse>(
      'GET',
      '/agents/me/spending-policy',
    );
    return res.policy;
  }

  /**
   * Create or update the current agent's spending policy.
   * Only provided fields are updated — omitted fields remain unchanged.
   */
  async update(params: SpendingPolicyUpdate): Promise<SpendingPolicy> {
    const res = await this.client.request<SpendingPolicyResponse>(
      'PUT',
      '/agents/me/spending-policy',
      { body: params },
    );
    return res.policy!;
  }

  /**
   * Get the spending summary for the current calendar month.
   * Includes total spent, remaining budget, transaction count, and cooldown info.
   */
  async summary(): Promise<SpendingSummary> {
    const res = await this.client.request<SpendingSummaryResponse>(
      'GET',
      '/agents/me/spending-summary',
    );
    return res.summary;
  }
}
