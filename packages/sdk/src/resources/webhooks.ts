import type { AgoraClient } from '../client';
import type {
  CreateWebhookRequest,
  CreateWebhookResponse,
  Webhook,
  WebhooksResponse,
} from '../types';

export class WebhooksResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Register a webhook endpoint.
   * Returns a secret for HMAC verification — only returned once.
   */
  async create(data: CreateWebhookRequest): Promise<CreateWebhookResponse> {
    return this.client.request<CreateWebhookResponse>('POST', '/webhooks', {
      body: data,
    });
  }

  /**
   * List all webhooks for the current agent.
   */
  async list(): Promise<Webhook[]> {
    const res = await this.client.request<WebhooksResponse>('GET', '/webhooks');
    return res.webhooks;
  }

  /**
   * Delete a webhook by ID.
   */
  async delete(id: string): Promise<{ message: string }> {
    return this.client.request<{ message: string }>('DELETE', `/webhooks/${id}`);
  }
}
