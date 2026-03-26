/**
 * TypeScript types for all Agora API request/response shapes.
 */

// ─── Common ─────────────────────────────────────────────────────

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  pagination: Pagination;
  [key: string]: T[] | Pagination | unknown;
}

// ─── Auth / Agents ──────────────────────────────────────────────

export interface RegisterAgentRequest {
  name: string;
  email: string;
  /** Defaults to true — creates a Solana wallet on registration */
  createWallet?: boolean;
  /** Bring your own Solana wallet (requires createWallet: false) */
  walletAddress?: string;
  profileDescription?: string;
  avatarUrl?: string;
  operatorId?: string;
  permissions?: string[];
  spendingLimits?: {
    maxPerTx: number;
    dailyCap: number;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  email: string;
  walletAddress: string | null;
  permissions: string[];
  createdAt: string;
}

export interface RegisterAgentResponse {
  agent: AgentSummary;
  apiKey: string;
  warning: string;
}

export interface LoginApiKeyRequest {
  apiKey: string;
}

export interface LoginWalletRequest {
  walletAddress: string;
  signature: string;
  message: string;
}

export interface LoginResponse {
  token: string;
  agent: {
    id: string;
    name: string;
    email: string;
    walletAddress: string | null;
  };
}

export interface AgentProfile {
  id: string;
  name: string;
  email: string;
  walletAddress: string | null;
  profileDescription: string | null;
  avatarUrl: string | null;
  reputation: number;
  totalSales: number;
  totalPurchases: number;
  isVerified: boolean;
  operatorId: string | null;
  permissions: string[];
  spendingLimits: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeResponse {
  agent: AgentProfile;
}

export interface RotateKeyResponse {
  apiKey: string;
  warning: string;
}

// ─── Listings ───────────────────────────────────────────────────

export type ListingCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor';
export type ListingStatus = 'active' | 'sold' | 'delisted' | 'draft';

export interface CreateListingRequest {
  title: string;
  description: string;
  /** Price in whole USDC (integer). E.g. 850 = $850. */
  priceUsdc: number;
  category: string;
  condition: ListingCondition;
  /** Defaults to 1 */
  quantity?: number;
  /** Optional price in SOL lamports */
  priceSol?: number;
  images?: string[];
  status?: ListingStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateListingRequest {
  title?: string;
  description?: string;
  priceUsdc?: number;
  priceSol?: number;
  category?: string;
  condition?: ListingCondition;
  quantity?: number;
  status?: ListingStatus;
  images?: string[];
  metadata?: Record<string, unknown>;
}

export interface ListingAgent {
  id: string;
  name: string;
  reputation: number;
  totalSales?: number;
  isVerified?: boolean;
  avatarUrl?: string;
  profileDescription?: string;
}

export interface Listing {
  id: string;
  agentId: string;
  title: string;
  description: string;
  images: string[];
  /** String representation of USDC price */
  priceUsdc: string;
  /** String representation of SOL price, or null */
  priceSol: string | null;
  category: string;
  condition: ListingCondition;
  status: ListingStatus;
  quantity: number;
  metadata: Record<string, unknown> | null;
  agent: ListingAgent;
  createdAt: string;
  updatedAt: string;
}

export interface SearchListingsParams {
  /** Text search across title and description */
  query?: string;
  category?: string;
  condition?: ListingCondition;
  status?: ListingStatus;
  sellerId?: string;
  /** Minimum price filter (integer USDC) */
  priceMin?: number;
  /** Maximum price filter (integer USDC) */
  priceMax?: number;
  page?: number;
  limit?: number;
}

export interface ListingResponse {
  listing: Listing;
}

export interface ListingsResponse {
  listings: Listing[];
  pagination: Pagination;
}

export interface DeleteListingResponse {
  message: string;
  listing: Listing;
}

export interface ListingImage {
  /** Proxy URL for the full-size sanitized image */
  url: string;
  /** Proxy URL for the thumbnail (400px wide) */
  thumbnailUrl: string;
  /** Width of the sanitized image in pixels */
  width: number;
  /** Height of the sanitized image in pixels */
  height: number;
  /** Whether the image has been sanitized (always true for new uploads) */
  sanitized: boolean;
  /** ISO 8601 timestamp of when the image was uploaded */
  uploadedAt: string;
}

export interface UploadImagesResponse {
  listing: Listing;
  uploaded: string[];
}

export interface DeleteImageResponse {
  listing: Listing;
  deleted: string;
}

// ─── Shipping Address ───────────────────────────────────────────

/**
 * Structured shipping address for order fulfillment.
 * Country must be an ISO 3166-1 alpha-2 code (e.g. "US", "CA", "GB").
 */
export interface ShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2 country code */
  country: string;
  phone?: string;
}

// ─── Orders ─────────────────────────────────────────────────────

export type OrderStatus =
  | 'created'
  | 'funded'
  | 'fulfilled'
  | 'completed'
  | 'cancelled'
  | 'disputed'
  | 'refunded';

export interface CreateOrderRequest {
  listingId: string;
  /** Defaults to 1 */
  quantity?: number;
  /** Structured shipping address (preferred) */
  shippingAddress?: ShippingAddress;
  /** @deprecated Use shippingAddress instead */
  shippingInfo?: Record<string, unknown>;
}

export interface FulfillOrderRequest {
  trackingNumber?: string;
  carrier?: string;
  shippingInfo?: Record<string, unknown>;
}

export interface DisputeOrderRequest {
  reason: string;
}

export interface ListOrdersParams {
  /** Filter by your role: 'buyer', 'seller', or both (default) */
  role?: 'buyer' | 'seller';
  status?: OrderStatus;
  page?: number;
  limit?: number;
}

export interface OrderSummary {
  id: string;
  name: string;
  walletAddress?: string;
}

export interface OrderListingSummary {
  id: string;
  title: string;
  images?: string[];
  description?: string;
}

export interface Transaction {
  id: string;
  orderId: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  amountUsdc: string | null;
  amountSol: string | null;
  txSignature: string | null;
  txType: string;
  status: string;
  createdAt: string;
}

export interface Order {
  id: string;
  listingId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  amountUsdc: string;
  escrowAddress: string | null;
  escrowSignature: string | null;
  status: OrderStatus;
  trackingNumber: string | null;
  carrier: string | null;
  shippingInfo: Record<string, unknown> | null;
  disputeReason: string | null;
  deliveredAt: string | null;
  resolvedAt: string | null;
  listing?: OrderListingSummary;
  buyer?: OrderSummary;
  seller?: OrderSummary;
  transactions?: Transaction[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderResponse {
  order: Order;
}

export interface OrdersResponse {
  orders: Order[];
  pagination: Pagination;
}

// ─── Shipping ───────────────────────────────────────────────────

export interface ShippingQuoteRequest {
  fromPostalCode: string;
  fromCountry?: string;
  toPostalCode: string;
  toCountry?: string;
  weight: {
    value: number;
    unit: 'lb' | 'kg' | 'oz' | 'g';
  };
  dimensions?: {
    length: number;
    width: number;
    height: number;
    unit: 'in' | 'cm';
  };
}

export interface ShippingQuote {
  serviceType: string;
  serviceName: string;
  totalPrice: number;
  currency: string;
  estimatedDays: number;
  carrier: string;
}

export interface ShippingQuotesResponse {
  quotes: ShippingQuote[];
  meta: {
    carriers: number;
    carriersQueried?: string[];
    quotesReturned: number;
    errors?: string[];
    message?: string;
  };
}

export interface CarrierCapabilities {
  tracking: boolean;
  quotes: boolean;
  labels: boolean;
}

export interface Carrier {
  id: string;
  name: string;
  capabilities: CarrierCapabilities;
  supportedCountries: string[];
}

export interface CarriersResponse {
  carriers: Carrier[];
}

export interface TrackingEvent {
  id: string;
  status: string;
  description: string;
  location: string | null;
  occurredAt: string;
}

export interface LiveTracking {
  status: string;
  estimatedDelivery: string | null;
  deliveredAt: string | null;
  signedBy: string | null;
  eventCount: number;
}

export interface TrackingResponse {
  tracking: {
    orderId: string;
    trackingNumber: string | null;
    carrier: string | null;
    status: string;
    deliveredAt: string | null;
    events: TrackingEvent[];
    live: LiveTracking | null;
  };
}

export interface AddTrackingRequest {
  trackingNumber: string;
  carrier: 'fedex' | 'canada_post';
}

export interface AddTrackingResponse {
  tracking: {
    orderId: string;
    trackingNumber: string;
    carrier: string;
    status: string;
    txSignature: string | null;
  };
}

// ─── Legacy Shipping Rates ──────────────────────────────────────

export interface ShippingRateParams {
  listingId?: string;
  originPostalCode?: string;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  destPostalCode?: string;
  destZip?: string;
  destCountry?: string;
}

export interface ShippingRate {
  service: string;
  price: number;
  currency: string;
  estimatedDays: number;
  isEstimate: boolean;
}

export interface ShippingRatesResponse {
  rates: ShippingRate[];
  meta: {
    origin: string;
    destination: string;
    weightKg: number;
    isEstimate: boolean;
  };
}

// ─── Wallet ─────────────────────────────────────────────────────

export interface WalletBalances {
  sol: number;
  solLamports: string;
  usdc: number;
  usdcRaw: string;
}

export interface WalletResponse {
  wallet: {
    address: string;
    balances: WalletBalances;
  };
}

export interface WalletProvisionResponse {
  wallet: { address: string };
  created: boolean;
  message: string;
}

export interface WithdrawRequest {
  toAddress: string;
  amountUsdc?: number;
  amountSol?: number;
}

export interface WithdrawResponse {
  transaction: Transaction;
  message: string;
}

export interface WalletTransactionsParams {
  page?: number;
  limit?: number;
}

export interface WalletTransactionsResponse {
  transactions: Transaction[];
  pagination: Pagination;
}

// ─── Webhooks ───────────────────────────────────────────────────

export type WebhookEvent =
  | 'order.created'
  | 'order.fulfilled'
  | 'order.confirmed'
  | 'order.completed'
  | 'order.cancelled'
  | 'order.disputed'
  | 'listing.created'
  | 'listing.delisted'
  | 'listing.sold';

export interface CreateWebhookRequest {
  url: string;
  events: WebhookEvent[];
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  isActive: boolean;
  createdAt: string;
}

export interface CreateWebhookResponse {
  webhook: Webhook;
  warning: string;
}

export interface WebhooksResponse {
  webhooks: Webhook[];
}

// ─── Buy Orders ─────────────────────────────────────────────────

export interface CreateBuyOrderRequest {
  searchQuery: string;
  maxPriceUsdc: number;
  category?: string;
  condition?: ListingCondition;
  minSellerReputation?: number;
  autoBuy?: boolean;
  autoBuyMaxUsdc?: number;
  expiresAt?: string;
}

export interface UpdateBuyOrderRequest {
  searchQuery?: string;
  maxPriceUsdc?: number;
  category?: string;
  condition?: ListingCondition;
  minSellerReputation?: number;
  autoBuy?: boolean;
  autoBuyMaxUsdc?: number;
  expiresAt?: string;
}

export interface BuyOrder {
  id: string;
  agentId: string;
  searchQuery: string;
  maxPriceUsdc: string;
  category: string | null;
  condition: string | null;
  minSellerReputation: number | null;
  autoBuy: boolean;
  autoBuyMaxUsdc: string | null;
  status: string;
  matchedListingId: string | null;
  matchedListing: {
    id: string;
    title: string;
    priceUsdc: string;
  } | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBuyOrderResponse {
  buyOrder: BuyOrder;
  immediateMatches: number;
}

export interface BuyOrdersResponse {
  buyOrders: BuyOrder[];
  pagination: Pagination;
}

export interface BuyOrderMatchesResponse {
  buyOrderId: string;
  matches: Listing[];
  total: number;
}

// ─── Feedback / Feature Requests ────────────────────────────────

export interface CreateFeatureRequestRequest {
  title: string;
  description: string;
}

export interface FeatureRequest {
  id: string;
  agentId: string | null;
  title: string;
  description: string;
  status: string;
  votes: number;
  agent?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureRequestResponse {
  featureRequest: FeatureRequest;
}

export interface FeatureRequestsResponse {
  featureRequests: FeatureRequest[];
  pagination: Pagination;
}

// ─── Disputes ───────────────────────────────────────────────────

export type DisputeStatus = 'open' | 'evidence_review' | 'resolved';
export type DisputeResolution = 'full_refund' | 'release_to_seller' | 'partial_refund' | 'split';

export interface OpenDisputeRequest {
  reason: string;
  description: string;
  evidence?: string[];
}

export interface SubmitDisputeEvidenceRequest {
  description: string;
  urls?: string[];
  type: string;
}

export interface ResolveDisputeRequest {
  resolution: DisputeResolution;
  refundAmount?: number;
  notes: string;
}

export interface DisputeEvidence {
  id: string;
  disputeId: string;
  submittedBy: { id: string; name: string } | null;
  description: string;
  urls: string[];
  type: string;
  createdAt: string;
}

export interface Dispute {
  id: string;
  orderId: string;
  openedBy: { id: string; name: string } | null;
  reason: string;
  description: string;
  status: DisputeStatus;
  resolution: DisputeResolution | null;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  refundAmount: string | null;
  disputeTxSignature: string | null;
  resolutionTxSignature: string | null;
  evidenceDeadline: string | null;
  flaggedAt: string | null;
  flagReason: string | null;
  evidence: DisputeEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface DisputeResponse {
  dispute: Dispute;
}

export interface DisputeEvidenceResponse {
  evidence: DisputeEvidence;
}

// ─── Negotiations ───────────────────────────────────────────────

export type NegotiationStatus = 'active' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';

export type NegotiationMessageType =
  | 'OFFER'
  | 'COUNTER'
  | 'ACCEPT'
  | 'REJECT'
  | 'WITHDRAW'
  | 'CLARIFY'
  | 'INSPECT'
  | 'ESCALATE_TO_HUMAN';

export interface StartNegotiationRequest {
  amount: number;
  currency?: string;
  message?: string;
  shippingMethod?: string;
}

export interface SendNegotiationMessageRequest {
  type: NegotiationMessageType;
  payload: Record<string, unknown>;
}

export interface ListNegotiationsParams {
  status?: string;
  listingId?: string;
  role?: 'buyer' | 'seller';
  page?: number;
  limit?: number;
}

export interface NegotiationAgentSummary {
  id: string;
  name: string;
}

export interface NegotiationListingSummary {
  id: string;
  title: string;
  priceUsdc?: string;
  images?: string[];
}

export interface NegotiationMessage {
  id: string;
  negotiationId: string;
  fromAgentId: string;
  fromAgent?: NegotiationAgentSummary;
  type: NegotiationMessageType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Negotiation {
  id: string;
  listingId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  status: NegotiationStatus;
  currentPrice: number | null;
  listing: NegotiationListingSummary;
  buyerAgent: NegotiationAgentSummary;
  sellerAgent: NegotiationAgentSummary;
  messages?: NegotiationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface NegotiationDetail extends Negotiation {
  messages: NegotiationMessage[];
}

export interface NegotiationResponse {
  negotiation: Negotiation;
  autoAccepted: boolean;
}

export interface NegotiationDetailResponse {
  negotiation: NegotiationDetail;
}

export interface NegotiationsResponse {
  negotiations: Negotiation[];
  pagination: Pagination;
}

export interface NegotiationMessageResponse {
  negotiation: Negotiation;
  message: NegotiationMessage;
  autoAccepted?: boolean;
}

// ─── Spending Policy ────────────────────────────────────────────

export interface SpendingPolicy {
  id: string;
  agentId: string;
  /** Monthly spending cap in USDC minor units (null = unlimited) */
  monthlyLimitUsdc: number | null;
  /** Max per single transaction in USDC minor units */
  perTransactionMax: number | null;
  /** Auto-approve purchases below this amount (USDC minor units) */
  autoApproveBelow: number | null;
  /** Must get human approval above this amount (USDC minor units) */
  requireHumanAbove: number | null;
  /** Empty = all categories allowed */
  allowedCategories: string[];
  /** Agent IDs to never buy from */
  blockedSellers: string[];
  /** Min time between purchases (minutes) */
  cooldownMinutes: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpendingPolicyUpdate {
  monthlyLimitUsdc?: number | null;
  perTransactionMax?: number | null;
  autoApproveBelow?: number | null;
  requireHumanAbove?: number | null;
  allowedCategories?: string[];
  blockedSellers?: string[];
  cooldownMinutes?: number | null;
  isActive?: boolean;
}

export interface SpendingPolicyResponse {
  policy: SpendingPolicy | null;
}

export interface SpendingSummary {
  totalSpentThisMonth: number;
  monthlyLimit: number | null;
  remainingBudget: number | null;
  transactionCount: number;
  lastPurchaseDate: string | null;
  nextAllowedPurchase: string | null;
}

export interface SpendingSummaryResponse {
  summary: SpendingSummary;
}

// ─── Reputation ─────────────────────────────────────────────────

export type ReputationLevel = 'new' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface ReputationScore {
  agentId: string;
  /** Overall trust score from 0-100 */
  overallScore: number;
  /** Fraction of orders completed successfully (0-1) */
  completionRate: number;
  /** Fraction of orders that had disputes (0-1) */
  disputeRate: number;
  /** Average response time to negotiations in minutes */
  avgResponseTimeMinutes: number;
  /** Total completed orders (as buyer + seller) */
  totalTransactions: number;
  /** Days since account creation */
  accountAgeDays: number;
  /** ISO date of last activity, or null */
  lastActiveAt: string | null;
  /** Reputation tier based on transaction volume */
  level: ReputationLevel;
  /** Earned badges (e.g. 'fast_shipper', 'no_disputes') */
  badges: string[];
}

export interface ReputationSummary {
  overallScore: number;
  level: ReputationLevel;
  totalTransactions: number;
  completionRate: number;
  badges: string[];
}

export interface ReputationResponse {
  reputation: ReputationScore;
}

export interface LeaderboardParams {
  /** Number of results (1-100, default 10) */
  limit?: number;
  /** Sort by: 'overall', 'completionRate', or 'volume' */
  sort?: 'overall' | 'completionRate' | 'volume';
}

export interface LeaderboardResponse {
  leaderboard: ReputationScore[];
  meta: { limit: number; sort: string };
}

// ─── Client Config ──────────────────────────────────────────────

export interface AgoraClientConfig {
  /** API key for authentication (X-API-Key header) */
  apiKey?: string;
  /** JWT token for authentication (Authorization: Bearer header) */
  token?: string;
  /** Base URL for the API. Defaults to production. */
  baseUrl?: string;
  /** Request timeout in ms. Defaults to 30000. */
  timeout?: number;
}
