/**
 * Carrier Tracking — Common Types & Interface
 *
 * Plug-and-play architecture: each carrier implements CarrierTracker.
 * Adding a new carrier = one new file implementing this interface.
 */

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

export interface CarrierTracker {
  /** Carrier identifier (e.g., 'fedex', 'canada_post') */
  name: string;

  /** Track a package by tracking number */
  track(trackingNumber: string): Promise<TrackingResult>;
}

/**
 * Carrier registry — maps carrier name to tracker instance.
 * Used by the tracking oracle to look up the right tracker.
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

  list(): string[] {
    return Array.from(this.carriers.keys());
  }
}
