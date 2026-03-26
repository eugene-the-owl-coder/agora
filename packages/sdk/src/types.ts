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
