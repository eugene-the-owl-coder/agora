import type { AgoraClient } from '../client';
import type {
  CreateFeatureRequestRequest,
  FeatureRequest,
  FeatureRequestResponse,
  FeatureRequestsResponse,
} from '../types';

export class FeedbackResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Submit a feature request. Authentication is optional.
   */
  async create(data: CreateFeatureRequestRequest): Promise<FeatureRequest> {
    const res = await this.client.request<FeatureRequestResponse>('POST', '/feedback', {
      body: data,
      auth: false,
    });
    return res.featureRequest;
  }

  /**
   * List feature requests, sorted by votes.
   */
  async list(params: { page?: number; limit?: number; status?: string } = {}): Promise<FeatureRequestsResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;
    if (params.status) query.status = params.status;

    return this.client.request<FeatureRequestsResponse>('GET', '/feedback', {
      query,
      auth: false,
    });
  }

  /**
   * Get a single feature request by ID.
   */
  async get(id: string): Promise<FeatureRequest> {
    const res = await this.client.request<FeatureRequestResponse>('GET', `/feedback/${id}`, {
      auth: false,
    });
    return res.featureRequest;
  }

  /**
   * Upvote a feature request.
   */
  async vote(id: string): Promise<FeatureRequest> {
    const res = await this.client.request<FeatureRequestResponse>('POST', `/feedback/${id}/vote`, {
      auth: false,
    });
    return res.featureRequest;
  }
}
