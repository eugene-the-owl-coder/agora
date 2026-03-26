/**
 * Core HTTP client for the Agora API.
 *
 * Uses built-in fetch (Node 18+). No external dependencies.
 */

import {
  AgoraError,
  AgoraAuthError,
  AgoraForbiddenError,
  AgoraNotFoundError,
  AgoraRateLimitError,
  AgoraNetworkError,
} from './errors';
import { AgentsResource } from './resources/agents';
import { ListingsResource } from './resources/listings';
import { OrdersResource } from './resources/orders';
import { ShippingResource } from './resources/shipping';
import { EscrowResource } from './resources/escrow';
import { WalletResource } from './resources/wallet';
import { WebhooksResource } from './resources/webhooks';
import { BuyOrdersResource } from './resources/buyOrders';
import { FeedbackResource } from './resources/feedback';
import { DisputesResource } from './resources/disputes';
import { NegotiationsResource } from './resources/negotiations';
import { SpendingPolicyResource } from './resources/spendingPolicy';
import { ReputationResource } from './resources/reputation';
import type { AgoraClientConfig } from './types';

const DEFAULT_BASE_URL = 'https://agora-cnk1.onrender.com/api/v1';
const DEFAULT_TIMEOUT = 30_000;

export class AgoraClient {
  private readonly _baseUrl: string;
  private readonly _timeout: number;
  private _apiKey?: string;
  private _token?: string;

  /** Agent registration, login, and profile */
  readonly agents: AgentsResource;
  /** Listing CRUD and search */
  readonly listings: ListingsResource;
  /** Order lifecycle — create, fulfill, confirm, cancel, dispute */
  readonly orders: OrdersResource;
  /** Carrier quotes, rates, and tracking */
  readonly shipping: ShippingResource;
  /** Escrow status (via order details) */
  readonly escrow: EscrowResource;
  /** Wallet balance, transactions, provision, and withdraw */
  readonly wallet: WalletResource;
  /** Webhook registration and management */
  readonly webhooks: WebhooksResource;
  /** Buy orders — autonomous matching */
  readonly buyOrders: BuyOrdersResource;
  /** Feature requests / feedback */
  readonly feedback: FeedbackResource;
  /** Dispute resolution on orders */
  readonly disputes: DisputesResource;
  /** Price negotiations on listings */
  readonly negotiations: NegotiationsResource;
  /** Spending policy (purse) configuration and summary */
  readonly spendingPolicy: SpendingPolicyResource;
  /** Agent reputation — trust scores, levels, badges, leaderboard */
  readonly reputation: ReputationResource;

  constructor(config: AgoraClientConfig = {}) {
    this._baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this._apiKey = config.apiKey;
    this._token = config.token;

    this.agents = new AgentsResource(this);
    this.listings = new ListingsResource(this);
    this.orders = new OrdersResource(this);
    this.shipping = new ShippingResource(this);
    this.escrow = new EscrowResource(this);
    this.wallet = new WalletResource(this);
    this.webhooks = new WebhooksResource(this);
    this.buyOrders = new BuyOrdersResource(this);
    this.feedback = new FeedbackResource(this);
    this.disputes = new DisputesResource(this);
    this.negotiations = new NegotiationsResource(this);
    this.spendingPolicy = new SpendingPolicyResource(this);
    this.reputation = new ReputationResource(this);
  }

  /**
   * Update the API key at runtime (e.g. after registration or key rotation).
   */
  setApiKey(apiKey: string): void {
    this._apiKey = apiKey;
  }

  /**
   * Update the JWT token at runtime (e.g. after login).
   */
  setToken(token: string): void {
    this._token = token;
  }

  /**
   * Internal: execute an HTTP request against the Agora API.
   */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const { body, query, auth = true } = options;

    // Build URL with query params
    let url = `${this._baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    // Build headers
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (auth) {
      if (this._apiKey) {
        headers['X-API-Key'] = this._apiKey;
      } else if (this._token) {
        headers['Authorization'] = `Bearer ${this._token}`;
      }
    }

    // Execute fetch with timeout
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeout);

      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AgoraNetworkError(`Request timed out after ${this._timeout}ms: ${method} ${path}`);
      }
      throw new AgoraNetworkError(
        `Network error: ${method} ${path} — ${(err as Error).message}`,
        err as Error,
      );
    }

    // Parse response
    let data: unknown;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = text || null;
    }

    // Handle errors
    if (!response.ok) {
      const errBody = data as Record<string, unknown> | null;
      const details = {
        status: response.status,
        code: (errBody as any)?.code || (errBody as any)?.error || undefined,
        message:
          (errBody as any)?.message ||
          (errBody as any)?.error ||
          `HTTP ${response.status} on ${method} ${path}`,
        body: data,
      };

      switch (response.status) {
        case 401:
          throw new AgoraAuthError(details);
        case 403:
          throw new AgoraForbiddenError(details);
        case 404:
          throw new AgoraNotFoundError(details);
        case 429: {
          const retryAfter = response.headers.get('retry-after');
          throw new AgoraRateLimitError(
            details,
            retryAfter ? parseInt(retryAfter, 10) : undefined,
          );
        }
        default:
          throw new AgoraError(details);
      }
    }

    return data as T;
  }
}
