/**
 * FedEx Carrier Plugin — Full shipping: tracking + quotes + labels
 *
 * Auth: OAuth2 client credentials flow
 * Track API: https://apis.fedex.com/track/v1/trackingnumbers
 * Rate API:  https://apis.fedex.com/rate/v1/rates/quotes
 * Docs: https://developer.fedex.com/api/en-us/catalog.html
 */

import {
  CarrierPlugin,
  TrackingResult,
  TrackingEvent,
  TrackingStatus,
  QuoteRequest,
  QuoteResponse,
} from './types';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// ─── Constants ──────────────────────────────────────────────────

const FEDEX_AUTH_URL_PROD = 'https://apis.fedex.com/oauth/token';
const FEDEX_AUTH_URL_SANDBOX = 'https://apis-sandbox.fedex.com/oauth/token';
const FEDEX_TRACK_URL = 'https://apis.fedex.com/track/v1/trackingnumbers';
const FEDEX_RATE_URL_PROD = 'https://apis.fedex.com/rate/v1/rates/quotes';
const FEDEX_RATE_URL_SANDBOX = 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes';

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

/** Countries FedEx serves (major markets) */
const FEDEX_SUPPORTED_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
  'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'AU', 'NZ',
  'JP', 'KR', 'CN', 'HK', 'SG', 'IN', 'BR', 'CL', 'CO', 'AE',
  'SA', 'IL', 'ZA', 'TH', 'MY', 'PH', 'TW', 'IE', 'PT',
];

// ─── Token Cache ────────────────────────────────────────────────

interface FedExToken {
  accessToken: string;
  expiresAt: number;
}

// ─── Weight Conversion Helpers ──────────────────────────────────

function convertToLbs(value: number, unit: 'lb' | 'kg' | 'oz' | 'g'): number {
  switch (unit) {
    case 'lb': return value;
    case 'kg': return value * 2.20462;
    case 'oz': return value / 16;
    case 'g':  return value / 453.592;
  }
}

function convertToInches(value: number, unit: 'in' | 'cm'): number {
  return unit === 'in' ? value : value / 2.54;
}

// ─── FedEx Carrier Plugin ───────────────────────────────────────

export class FedExTracker implements CarrierPlugin {
  // CarrierTracker
  readonly name = 'fedex';

  // CarrierPlugin
  readonly carrierId = 'fedex';
  readonly displayName = 'FedEx';
  readonly supportedCountries = FEDEX_SUPPORTED_COUNTRIES;

  private clientId: string;
  private clientSecret: string;
  private token: FedExToken | null = null;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  // ─── Auth ───────────────────────────────────────────────────

  /** Get OAuth2 bearer token (cached until expiry) */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }

    const url = config.fedex.sandbox ? FEDEX_AUTH_URL_SANDBOX : FEDEX_AUTH_URL_PROD;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(url, {
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

  // ─── Tracking ───────────────────────────────────────────────

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
    return this.parseTrackResponse(data, trackingNumber);
  }

  private parseTrackResponse(data: any, trackingNumber: string): TrackingResult {
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

  // ─── Quotes ─────────────────────────────────────────────────

  async getQuotes(params: QuoteRequest): Promise<QuoteResponse[]> {
    const token = await this.getToken();
    const { sandbox, accountNumber } = config.fedex;

    const url = sandbox ? FEDEX_RATE_URL_SANDBOX : FEDEX_RATE_URL_PROD;

    // Convert to FedEx units (imperial)
    const weightLbs = Math.max(convertToLbs(params.weight.value, params.weight.unit), 0.1);

    const requestedPackageLineItems: any[] = [
      {
        weight: {
          units: 'LB',
          value: parseFloat(weightLbs.toFixed(1)),
        },
      },
    ];

    // Add dimensions if provided
    if (params.dimensions) {
      const lengthIn = Math.max(Math.round(convertToInches(params.dimensions.length, params.dimensions.unit)), 1);
      const widthIn = Math.max(Math.round(convertToInches(params.dimensions.width, params.dimensions.unit)), 1);
      const heightIn = Math.max(Math.round(convertToInches(params.dimensions.height, params.dimensions.unit)), 1);

      requestedPackageLineItems[0].dimensions = {
        length: lengthIn,
        width: widthIn,
        height: heightIn,
        units: 'IN',
      };
    }

    const body = {
      accountNumber: { value: accountNumber },
      requestedShipment: {
        shipper: {
          address: {
            postalCode: params.fromPostalCode.replace(/\s/g, '').toUpperCase(),
            countryCode: params.fromCountry.toUpperCase(),
          },
        },
        recipient: {
          address: {
            postalCode: params.toPostalCode.replace(/\s/g, '').toUpperCase(),
            countryCode: params.toCountry.toUpperCase(),
          },
        },
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        rateRequestType: ['LIST', 'ACCOUNT'],
        requestedPackageLineItems,
      },
    };

    logger.debug('FedEx rate request', {
      url,
      from: `${params.fromCountry} ${params.fromPostalCode}`,
      to: `${params.toCountry} ${params.toPostalCode}`,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-locale': 'en_CA',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      const errMsg = data?.errors?.[0]?.message || JSON.stringify(data).substring(0, 200);
      throw new Error(`FedEx rate API ${res.status}: ${errMsg}`);
    }

    return this.parseRateResponse(data);
  }

  private parseRateResponse(data: any): QuoteResponse[] {
    const rateDetails = data?.output?.rateReplyDetails;
    if (!rateDetails || !Array.isArray(rateDetails)) {
      logger.warn('FedEx: no rateReplyDetails', { alerts: data?.output?.alerts });
      return [];
    }

    return rateDetails
      .map((rd: any): QuoteResponse | null => {
        const serviceType = rd.serviceType || '';
        const serviceName = rd.serviceName || serviceType.replace(/_/g, ' ');

        // Get the best rate (account rate if available, otherwise list)
        const rates = rd.ratedShipmentDetails || [];
        const accountRate = rates.find((r: any) => r.rateType === 'ACCOUNT');
        const listRate = rates.find((r: any) => r.rateType === 'LIST');
        const bestRate = accountRate || listRate || rates[0];

        const totalCharge = bestRate?.totalNetCharge ?? bestRate?.totalNetFedExCharge ?? 0;
        const currency = bestRate?.currency || 'CAD';
        const totalPrice = parseFloat(totalCharge);

        if (totalPrice <= 0) return null;

        const transitDays = rd.operationalDetail?.transitDays
          ? parseInt(rd.operationalDetail.transitDays, 10)
          : (rd.commit?.transitDays?.amount ? parseInt(rd.commit.transitDays.amount, 10) : 0);

        return {
          serviceType,
          serviceName,
          totalPrice: parseFloat(totalPrice.toFixed(2)),
          currency,
          estimatedDays: transitDays,
          carrier: this.carrierId,
        };
      })
      .filter((q): q is QuoteResponse => q !== null);
  }

  // ─── Validation ─────────────────────────────────────────────

  validateTrackingNumber(trackingNumber: string): boolean {
    // FedEx tracking numbers are 12-22 digits
    const cleaned = trackingNumber.replace(/\s/g, '');
    return /^\d{12,22}$/.test(cleaned);
  }
}
