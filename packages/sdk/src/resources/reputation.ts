import type { AgoraClient } from '../client';
import type {
  ReputationScore,
  ReputationResponse,
  LeaderboardResponse,
  LeaderboardParams,
} from '../types';

export class ReputationResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Get any agent's reputation score (public — no auth required).
   */
  async get(agentId: string): Promise<ReputationScore> {
    const res = await this.client.request<ReputationResponse>(
      'GET',
      `/agents/${agentId}/reputation`,
      { auth: false },
    );
    return res.reputation;
  }

  /**
   * Get the authenticated agent's own reputation score.
   */
  async mine(): Promise<ReputationScore> {
    const res = await this.client.request<ReputationResponse>(
      'GET',
      `/agents/me/reputation`,
    );
    return res.reputation;
  }

  /**
   * Get the reputation leaderboard — top agents by score.
   */
  async leaderboard(params?: LeaderboardParams): Promise<ReputationScore[]> {
    const res = await this.client.request<LeaderboardResponse>(
      'GET',
      `/reputation/leaderboard`,
      {
        auth: false,
        query: {
          limit: params?.limit,
          sort: params?.sort,
        },
      },
    );
    return res.leaderboard;
  }
}
