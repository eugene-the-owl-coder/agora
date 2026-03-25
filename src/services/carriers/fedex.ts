/**
 * FedEx Tracking — Track API v1 (REST)
 *
 * Auth: OAuth2 client credentials flow
 * Endpoint: https://apis.fedex.com/track/v1/trackingnumbers
 * Docs: https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
 */

import { CarrierTracker, TrackingResult, TrackingEvent, TrackingStatus } from './types';
import { logger } from '../../utils/logger';

const FEDEX_AUTH_URL = 'https://apis.fedex.com/oauth/token';
const FEDEX_TRACK_URL = 'https://apis.fedex.com/track/v1/trackingnumbers';

/** Map FedEx status codes to our internal status */
const FEDEX_STATUS_MAP: Record<string, TrackingStatus> = {
  // Pre-shipment
  PU: 'in_transit',      // Picked up
  OC: 'pre_transit',     // Order created
  // In transit
  IT: 'in_transit',      // In transit
  IX: 'in_transit',      // In transit
  AR: 'in_transit',      // Arrived at facility
  DP: 'in_transit',      // Departed facility
  OD: 'out_for_delivery', // Out for delivery
  // Delivered
  DL: 'delivered',       // Delivered
  // Exceptions
  DE: 'delivery_attempted', // Delivery exception
  CA: 'exception',       // Shipment cancelled
  SE: 'exception',       // Shipment exception
  CD: 'delivery_attempted', // Customer delay
};

interface FedExToken {
  accessToken: string;
  expiresAt: number;
}

export class FedExTracker implements CarrierTracker {
  readonly name = 'fedex';
  private clientId: string;
  private clientSecret: string;
  private token: FedExToken | null = null;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /** Get OAuth2 bearer token (cached until expiry) */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(FEDEX_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('FedEx auth failed', { status: res.status, body: text });
      throw new Error(`FedEx auth failed: ${res.status}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    this.token = {
      accessToken: data.access_token,
      // Expire 5 minutes early to avoid race conditions
      expiresAt: Date.now() + (data.expires_in - 300) * 1000,
    };

    return this.token.accessToken;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const token = await this.getToken();

    const requestBody = {
      includeDetailedScans: true,
      trackingInfo: [
        {
          trackingNumberInfo: {
            trackingNumber,
          },
        },
      ],
    };

    const res = await fetch(FEDEX_TRACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('FedEx track failed', { status: res.status, trackingNumber, body: text });
      throw new Error(`FedEx tracking failed: ${res.status}`);
    }

    const data = await res.json();
    return this.parseResponse(data, trackingNumber);
  }

  private parseResponse(data: any, trackingNumber: string): TrackingResult {
    const result: TrackingResult = {
      status: 'unknown',
      events: [],
      carrier: this.name,
      trackingNumber,
    };

    try {
      const trackResult = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
      if (!trackResult) return result;

      // Latest status
      const latestStatus = trackResult.latestStatusDetail;
      if (latestStatus) {
        const code = latestStatus.code || '';
        result.status = FEDEX_STATUS_MAP[code] || 'unknown';
      }

      // Estimated delivery
      if (trackResult.estimatedDeliveryTimeWindow?.window?.ends) {
        result.estimatedDelivery = new Date(trackResult.estimatedDeliveryTimeWindow.window.ends);
      } else if (trackResult.standardTransitTimeWindow?.window?.ends) {
        result.estimatedDelivery = new Date(trackResult.standardTransitTimeWindow.window.ends);
      }

      // Delivery details
      if (trackResult.deliveryDetails) {
        const dd = trackResult.deliveryDetails;
        if (dd.actualDeliveryTimestamp) {
          result.deliveredAt = new Date(dd.actualDeliveryTimestamp);
        }
        if (dd.receivedByName) {
          result.signedBy = dd.receivedByName;
        }
      }

      // Scan events
      const scanEvents = trackResult.scanEvents || [];
      result.events = scanEvents.map((event: any): TrackingEvent => {
        const code = event.derivedStatusCode || event.eventType || '';
        const location = event.scanLocation
          ? [event.scanLocation.city, event.scanLocation.stateOrProvinceCode, event.scanLocation.countryCode]
              .filter(Boolean)
              .join(', ')
          : undefined;

        return {
          timestamp: new Date(event.date),
          status: FEDEX_STATUS_MAP[code] || 'in_transit',
          description: event.eventDescription || event.derivedStatus || code,
          location,
          rawData: event,
        };
      });

      // Sort events newest first
      result.events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (err) {
      logger.error('FedEx parse error', { error: (err as Error).message, trackingNumber });
    }

    return result;
  }
}
