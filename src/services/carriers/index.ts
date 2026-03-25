/**
 * Carrier Registry — aggregates all carrier trackers.
 */

import { CarrierRegistry } from './types';
import { FedExTracker } from './fedex';
import { CanadaPostTracker } from './canadaPost';

export { CarrierRegistry } from './types';
export type { CarrierTracker, TrackingResult, TrackingEvent, TrackingStatus } from './types';
export { FedExTracker } from './fedex';
export { CanadaPostTracker } from './canadaPost';

/**
 * Create a pre-configured carrier registry with all available carriers.
 * Carriers are only registered if their credentials are available.
 */
export function createCarrierRegistry(): CarrierRegistry {
  const registry = new CarrierRegistry();

  // FedEx
  const fedexClientId = process.env.FEDEX_CLIENT_ID;
  const fedexClientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (fedexClientId && fedexClientSecret) {
    registry.register(new FedExTracker(fedexClientId, fedexClientSecret));
  }

  // Canada Post
  const cpUsername = process.env.CANADA_POST_USERNAME;
  const cpPassword = process.env.CANADA_POST_PASSWORD;
  if (cpUsername && cpPassword) {
    registry.register(new CanadaPostTracker(cpUsername, cpPassword));
  }

  return registry;
}
