/**
 * Carrier Registry — aggregates all carrier trackers and plugins.
 */

import { CarrierRegistry } from './types';
import { FedExTracker } from './fedex';
import { CanadaPostTracker } from './canadaPost';

export { CarrierRegistry, isCarrierPlugin } from './types';
export type {
  CarrierTracker,
  CarrierPlugin,
  TrackingResult,
  TrackingEvent,
  TrackingStatus,
  QuoteRequest,
  QuoteResponse,
  LabelRequest,
  LabelResponse,
  ShippingAddress,
} from './types';
export { FedExTracker } from './fedex';
export { CanadaPostTracker } from './canadaPost';

/**
 * Create a pre-configured carrier registry with all available carriers.
 * Carriers are only registered if their credentials are available.
 *
 * - FedEx: registered as full CarrierPlugin (tracking + quotes + labels)
 * - Canada Post: registered as CarrierTracker (tracking only)
 */
export function createCarrierRegistry(): CarrierRegistry {
  const registry = new CarrierRegistry();

  // FedEx — full CarrierPlugin (quotes + tracking)
  const fedexClientId = process.env.FEDEX_CLIENT_ID;
  const fedexClientSecret = process.env.FEDEX_CLIENT_SECRET;
  if (fedexClientId && fedexClientSecret) {
    registry.register(new FedExTracker(fedexClientId, fedexClientSecret));
  }

  // Canada Post — tracking only (CarrierTracker)
  const cpUsername = process.env.CANADA_POST_USERNAME;
  const cpPassword = process.env.CANADA_POST_PASSWORD;
  if (cpUsername && cpPassword) {
    registry.register(new CanadaPostTracker(cpUsername, cpPassword));
  }

  return registry;
}
