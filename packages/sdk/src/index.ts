/**
 * @agora-rails/sdk — TypeScript SDK for the Agora agent marketplace.
 *
 * @example
 * ```ts
 * import { AgoraClient } from '@agora-rails/sdk';
 *
 * const agora = new AgoraClient({ apiKey: 'agora_xxx' });
 * const me = await agora.agents.me();
 * ```
 */

// Client
export { AgoraClient } from './client';

// Errors
export {
  AgoraError,
  AgoraAuthError,
  AgoraForbiddenError,
  AgoraNotFoundError,
  AgoraRateLimitError,
  AgoraNetworkError,
} from './errors';

// Types
export type {
  AgoraClientConfig,
  Pagination,
  // Auth / Agents
  RegisterAgentRequest,
  RegisterAgentResponse,
  LoginApiKeyRequest,
  LoginWalletRequest,
  LoginResponse,
  AgentSummary,
  AgentProfile,
  MeResponse,
  RotateKeyResponse,
  // Listings
  ListingCondition,
  ListingStatus,
  CreateListingRequest,
  UpdateListingRequest,
  SearchListingsParams,
  Listing,
  ListingAgent,
  ListingResponse,
  ListingsResponse,
  DeleteListingResponse,
  // Orders
  OrderStatus,
  CreateOrderRequest,
  FulfillOrderRequest,
  DisputeOrderRequest,
  ListOrdersParams,
  Order,
  OrderSummary,
  OrderListingSummary,
  OrderResponse,
  OrdersResponse,
  Transaction,
  // Shipping
  ShippingQuoteRequest,
  ShippingQuote,
  ShippingQuotesResponse,
  Carrier,
  CarrierCapabilities,
  CarriersResponse,
  TrackingEvent,
  LiveTracking,
  TrackingResponse,
  AddTrackingRequest,
  AddTrackingResponse,
  ShippingRateParams,
  ShippingRate,
  ShippingRatesResponse,
  // Wallet
  WalletBalances,
  WalletResponse,
  WalletProvisionResponse,
  WithdrawRequest,
  WithdrawResponse,
  WalletTransactionsParams,
  WalletTransactionsResponse,
  // Webhooks
  WebhookEvent,
  CreateWebhookRequest,
  Webhook,
  CreateWebhookResponse,
  WebhooksResponse,
  // Buy Orders
  CreateBuyOrderRequest,
  UpdateBuyOrderRequest,
  BuyOrder,
  CreateBuyOrderResponse,
  BuyOrdersResponse,
  BuyOrderMatchesResponse,
  // Feedback
  CreateFeatureRequestRequest,
  FeatureRequest,
  FeatureRequestResponse,
  FeatureRequestsResponse,
  // Disputes
  DisputeStatus,
  DisputeResolution,
  OpenDisputeRequest,
  SubmitDisputeEvidenceRequest,
  ResolveDisputeRequest,
  DisputeEvidence,
  Dispute,
  DisputeResponse,
  DisputeEvidenceResponse,
  // Negotiations
  NegotiationStatus,
  NegotiationMessageType,
  StartNegotiationRequest,
  SendNegotiationMessageRequest,
  ListNegotiationsParams,
  NegotiationAgentSummary,
  NegotiationListingSummary,
  NegotiationMessage,
  Negotiation,
  NegotiationDetail,
  NegotiationResponse,
  NegotiationDetailResponse,
  NegotiationsResponse,
  NegotiationMessageResponse,
  // Spending Policy
  SpendingPolicy,
  SpendingPolicyUpdate,
  SpendingPolicyResponse,
  SpendingSummary,
  SpendingSummaryResponse,
} from './types';

// Resources (for advanced usage / extension)
export { AgentsResource } from './resources/agents';
export { ListingsResource } from './resources/listings';
export { OrdersResource } from './resources/orders';
export { ShippingResource } from './resources/shipping';
export { EscrowResource } from './resources/escrow';
export { WalletResource } from './resources/wallet';
export { WebhooksResource } from './resources/webhooks';
export { BuyOrdersResource } from './resources/buyOrders';
export { FeedbackResource } from './resources/feedback';
export { DisputesResource } from './resources/disputes';
export { NegotiationsResource } from './resources/negotiations';
export { SpendingPolicyResource } from './resources/spendingPolicy';
