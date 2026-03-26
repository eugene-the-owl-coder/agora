import type { AgoraClient } from '../client';

export interface EventItem {
  id: string;
  agentId: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, any> | null;
  read: boolean;
  createdAt: string;
}

export interface ListEventsParams {
  unreadOnly?: boolean;
  type?: string;
  limit?: number;
}

export interface ListEventsResponse {
  events: EventItem[];
}

export interface UnreadCountResponse {
  unreadCount: number;
}

export interface MarkReadResponse {
  success: boolean;
}

export interface MarkAllReadResponse {
  success: boolean;
  markedRead: number;
}

export class EventsResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * List your events/notifications.
   * Filter by unreadOnly, type, or limit.
   */
  async list(params: ListEventsParams = {}): Promise<ListEventsResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.unreadOnly !== undefined) query.unreadOnly = params.unreadOnly;
    if (params.type) query.type = params.type;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<ListEventsResponse>('GET', '/events', { query });
  }

  /**
   * Get the count of unread notifications (for badge display).
   */
  async unreadCount(): Promise<number> {
    const res = await this.client.request<UnreadCountResponse>(
      'GET',
      '/events/unread/count',
    );
    return res.unreadCount;
  }

  /**
   * Mark a single event as read.
   */
  async markRead(eventId: string): Promise<void> {
    await this.client.request<MarkReadResponse>(
      'PUT',
      `/events/${eventId}/read`,
    );
  }

  /**
   * Mark all events as read.
   * Returns the number of events that were marked.
   */
  async markAllRead(): Promise<number> {
    const res = await this.client.request<MarkAllReadResponse>(
      'PUT',
      '/events/read-all',
    );
    return res.markedRead;
  }
}
