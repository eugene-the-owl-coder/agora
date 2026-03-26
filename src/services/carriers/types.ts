/**
 * Carrier Tracking & Shipping — Common Types & Interfaces
 *
 * Two tiers:
 *   1. CarrierTracker — tracking only (e.g. Canada Post)
 *   2. CarrierPlugin  — full shipping: quotes + labels + tracking (e.g. FedEx)
 *
 * Adding a new carrier = one new file implementing either interface.
 */

// ─── Tracking Types ─────────────────────────────────────────────

export type TrackingStatus =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_attempted'
  | 'exception'
  | 'unknown';

export interface TrackingEvent {
  timestamp: Date;
  status: TrackingStatus;
  description: string;
  location?: string;
  rawData?: Record<string, unknown>;
}

export interface TrackingResult {
  status: TrackingStatus;
  estimatedDelivery?: Date;
  deliveredAt?: Date;
  signedBy?: string;
  events: TrackingEvent[];
  carrier: string;
  trackingNumber: string;
}

// ─── CarrierTracker (tracking-only) ─────────────────────────────

export interface CarrierTracker {
  /** Carrier identifier (e.g., 'fedex', 'canada_post') */
  name: string;

  /** Track a package by tracking number */
  track(trackingNumber: string): Promise<TrackingResult>;
}

// ─── Shipping Address ───────────────────────────────────────────

export interface ShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

// ─── Quote Types ────────────────────────────────────────────────

export interface QuoteRequest {
  fromPostalCode: string;
  fromCountry: string;
  toPostalCode: string;
  toCountry: string;
  weight: { value: number; unit: 'lb' | 'kg' | 'oz' | 'g' };
  dimensions?: { length: number; width: number; height: number; unit: 'in' | 'cm' };
}

export interface QuoteResponse {
  serviceType: string;
  serviceName: string;
  totalPrice: number;
  currency: string;
  estimatedDays: number;
  carrier: string;
}

// ─── Label Types ────────────────────────────────────────────────

export interface LabelRequest {
  serviceType: string;
  from: ShippingAddress;
  to: ShippingAddress;
  weight: { value: number; unit: 'lb' | 'kg' | 'oz' | 'g' };
  dimensions?: { length: number; width: number; height: number; unit: 'in' | 'cm' };
  reference?: string;
}

export interface LabelResponse {
  trackingNumber: string;
  labelFormat: 'pdf' | 'png' | 'zpl';
  labelData: Buffer;
  estimatedDelivery?: Date;
  cost: number;
  currency: string;
}

// ─── CarrierPlugin (full shipping) ──────────────────────────────

export interface CarrierPlugin extends CarrierTracker {
  readonly carrierId: string;            // e.g. "fedex", "ups"
  readonly displayName: string;          // "FedEx", "UPS"
  readonly supportedCountries: string[]; // ISO 3166-1 alpha-2

  /** Get shipping rate quotes */
  getQuotes(params: QuoteRequest): Promise<QuoteResponse[]>;

  /** Purchase a shipping label (optional — not all plugins support this) */
  purchaseLabel?(params: LabelRequest): Promise<LabelResponse>;

  /** Validate tracking number format */
  validateTrackingNumber(trackingNumber: string): boolean;
}

// ─── Type guard ─────────────────────────────────────────────────

export function isCarrierPlugin(tracker: CarrierTracker): tracker is CarrierPlugin {
  return (
    'carrierId' in tracker &&
    'displayName' in tracker &&
    'supportedCountries' in tracker &&
    'getQuotes' in tracker &&
    'validateTrackingNumber' in tracker
  );
}

// ─── Registry ───────────────────────────────────────────────────

/**
 * Carrier registry — maps carrier name to tracker instance.
 * Supports both CarrierTracker (tracking-only) and CarrierPlugin (full shipping).
 * Used by the tracking oracle and shipping routes.
 */
export class CarrierRegistry {
  private carriers = new Map<string, CarrierTracker>();

  register(tracker: CarrierTracker): void {
    this.carriers.set(tracker.name, tracker);
  }

  get(name: string): CarrierTracker | undefined {
    return this.carriers.get(name);
  }

  has(name: string): boolean {
    return this.carriers.has(name);
  }

  /** List all carrier names (both trackers and plugins) */
  list(): string[] {
    return Array.from(this.carriers.keys());
  }

  /** List only full CarrierPlugin instances (quotes + labels + tracking) */
  listPlugins(): CarrierPlugin[] {
    const plugins: CarrierPlugin[] = [];
    for (const tracker of this.carriers.values()) {
      if (isCarrierPlugin(tracker)) {
        plugins.push(tracker);
      }
    }
    return plugins;
  }

  /** List only tracking-only carriers (not full plugins) */
  listTrackers(): CarrierTracker[] {
    const trackers: CarrierTracker[] = [];
    for (const tracker of this.carriers.values()) {
      if (!isCarrierPlugin(tracker)) {
        trackers.push(tracker);
      }
    }
    return trackers;
  }

  /** Get a carrier as a CarrierPlugin (returns undefined if it's only a tracker) */
  getPlugin(name: string): CarrierPlugin | undefined {
    const tracker = this.carriers.get(name);
    if (tracker && isCarrierPlugin(tracker)) {
      return tracker;
    }
    return undefined;
  }
}
