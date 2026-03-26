/**
 * UPS Carrier Plugin — Full shipping: tracking + quotes
 *
 * Auth: OAuth2 client credentials flow
 * Rating API: https://onlinetools.ups.com/api/rating/v1/Rate
 * Track API:  https://onlinetools.ups.com/api/track/v1/details/{trackingNumber}
 * Docs: https://developer.ups.com/api/reference
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

const UPS_AUTH_URL_PROD = 'https://onlinetools.ups.com/security/v1/oauth/token';
const UPS_AUTH_URL_SANDBOX = 'https://wwwcie.ups.com/security/v1/oauth/token';

const UPS_RATE_URL_PROD = 'https://onlinetools.ups.com/api/rating/v1/Rate';
const UPS_RATE_URL_SANDBOX = 'https://wwwcie.ups.com/api/rating/v1/Rate';

const UPS_TRACK_URL_PROD = 'https://onlinetools.ups.com/api/track/v1/details';
const UPS_TRACK_URL_SANDBOX = 'https://wwwcie.ups.com/api/track/v1/details';

/** UPS service code → human-readable name */
const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '14': 'UPS Next Day Air Early',
  '65': 'UPS Saver',
};

/** Map UPS status type codes to our internal TrackingStatus */
const UPS_STATUS_MAP: Record<string, TrackingStatus> = {
  M: 'pre_transit',        // Manifest / billing info received
  P: 'pre_transit',        // Pickup
  I: 'in_transit',         // In transit
  X: 'in_transit',         // Exception (UPS uses X for in-transit exceptions too)
  O: 'out_for_delivery',   // Out for delivery
  D: 'delivered',          // Delivered
  RS: 'exception',         // Return to sender
  MV: 'in_transit',        // Moved
  NA: 'unknown',           // Not available
};

/** Countries UPS serves (major markets) */
const UPS_SUPPORTED_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE',
  'AT', 'CH', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'IE', 'PT',
  'AU', 'NZ', 'JP', 'KR', 'CN', 'HK', 'SG', 'TW', 'IN', 'TH',
  'MY', 'PH', 'BR', 'CL', 'CO', 'AE', 'SA', 'IL', 'ZA',
];

// ─── Token Cache ────────────────────────────────────────────────

interface UPSToken {
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

// ─── UPS Carrier Plugin ─────────────────────────────────────────

export class UPSTracker implements CarrierPlugin {
  // CarrierTracker
  readonly name = 'ups';

  // CarrierPlugin
  readonly carrierId = 'ups';
  readonly displayName = 'UPS';
  readonly supportedCountries = UPS_SUPPORTED_COUNTRIES;

  private clientId: string;
  private clientSecret: string;
  private accountNumber: string;
  private token: UPSToken | null = null;

  constructor(clientId: string, clientSecret: string, accountNumber: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accountNumber = accountNumber;
  }

  // ─── Auth ───────────────────────────────────────────────────

  /** Get OAuth2 bearer token (cached until expiry) */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }

    const url = config.ups.sandbox ? UPS_AUTH_URL_SANDBOX : UPS_AUTH_URL_PROD;

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('UPS auth failed', { status: res.status, body: text });
      throw new Error(`UPS auth failed: ${res.status}`);
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
    const baseUrl = config.ups.sandbox ? UPS_TRACK_URL_SANDBOX : UPS_TRACK_URL_PROD;
    const url = `${baseUrl}/${encodeURIComponent(trackingNumber)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        transId: `agora-${Date.now()}`,
        transactionSrc: 'agora',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('UPS track failed', { status: res.status, trackingNumber, body: text });
      throw new Error(`UPS tracking failed: ${res.status}`);
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
      const trackResponse = data?.trackResponse;
      const shipment = trackResponse?.shipment?.[0];
      if (!shipment) return result;

      const pkg = shipment.package?.[0];
      if (!pkg) return result;

      // Current status
      const currentStatus = pkg.currentStatus;
      if (currentStatus) {
        const typeCode = currentStatus.type || '';
        result.status = UPS_STATUS_MAP[typeCode] || 'unknown';
      }

      // Delivery details
      if (pkg.deliveryDate?.[0]?.date) {
        const dateStr = pkg.deliveryDate[0].date;
        // UPS returns date as YYYYMMDD
        const formatted = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
        if (result.status === 'delivered') {
          result.deliveredAt = new Date(formatted);
        } else {
          result.estimatedDelivery = new Date(formatted);
        }
      }

      // Estimated delivery from deliveryTime
      if (pkg.deliveryTime?.startTime && !result.estimatedDelivery && !result.deliveredAt) {
        result.estimatedDelivery = new Date(pkg.deliveryTime.startTime);
      }

      // Signed by
      if (pkg.deliveryInformation?.receivedBy) {
        result.signedBy = pkg.deliveryInformation.receivedBy;
      }

      // Activity/events
      const activities = pkg.activity || [];
      result.events = activities.map((activity: any): TrackingEvent => {
        const statusType = activity.status?.type || '';
        const description = activity.status?.description || '';

        // Build location string
        const loc = activity.location?.address;
        const location = loc
          ? [loc.city, loc.stateProvince, loc.countryCode]
              .filter(Boolean)
              .join(', ')
          : undefined;

        // Parse UPS date (YYYYMMDD) and time (HHmmss)
        let timestamp: Date;
        if (activity.date && activity.time) {
          const d = activity.date;
          const t = activity.time;
          const isoStr = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
          timestamp = new Date(isoStr);
        } else if (activity.date) {
          const d = activity.date;
          timestamp = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
        } else {
          timestamp = new Date();
        }

        return {
          timestamp,
          status: UPS_STATUS_MAP[statusType] || 'in_transit',
          description,
          location,
          rawData: activity,
        };
      });

      // Sort events newest first
      result.events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (err) {
      logger.error('UPS parse error', { error: (err as Error).message, trackingNumber });
    }

    return result;
  }

  // ─── Quotes ─────────────────────────────────────────────────

  async getQuotes(params: QuoteRequest): Promise<QuoteResponse[]> {
    const token = await this.getToken();
    const url = config.ups.sandbox ? UPS_RATE_URL_SANDBOX : UPS_RATE_URL_PROD;

    // Convert to UPS units (imperial)
    const weightLbs = Math.max(convertToLbs(params.weight.value, params.weight.unit), 0.1);

    const packageDetails: any = {
      PackagingType: {
        Code: '02',         // Customer Supplied Package
        Description: 'Package',
      },
      PackageWeight: {
        UnitOfMeasurement: {
          Code: 'LBS',
          Description: 'Pounds',
        },
        Weight: weightLbs.toFixed(1),
      },
    };

    // Add dimensions if provided
    if (params.dimensions) {
      const lengthIn = Math.max(Math.round(convertToInches(params.dimensions.length, params.dimensions.unit)), 1);
      const widthIn = Math.max(Math.round(convertToInches(params.dimensions.width, params.dimensions.unit)), 1);
      const heightIn = Math.max(Math.round(convertToInches(params.dimensions.height, params.dimensions.unit)), 1);

      packageDetails.Dimensions = {
        UnitOfMeasurement: {
          Code: 'IN',
          Description: 'Inches',
        },
        Length: String(lengthIn),
        Width: String(widthIn),
        Height: String(heightIn),
      };
    }

    const requestBody = {
      RateRequest: {
        Request: {
          SubVersion: '1801',
          TransactionReference: {
            CustomerContext: 'agora-rate-quote',
          },
        },
        Shipment: {
          Shipper: {
            ShipperNumber: this.accountNumber,
            Address: {
              PostalCode: params.fromPostalCode.replace(/\s/g, '').toUpperCase(),
              CountryCode: params.fromCountry.toUpperCase(),
            },
          },
          ShipTo: {
            Address: {
              PostalCode: params.toPostalCode.replace(/\s/g, '').toUpperCase(),
              CountryCode: params.toCountry.toUpperCase(),
            },
          },
          ShipFrom: {
            Address: {
              PostalCode: params.fromPostalCode.replace(/\s/g, '').toUpperCase(),
              CountryCode: params.fromCountry.toUpperCase(),
            },
          },
          Package: packageDetails,
        },
      },
    };

    logger.debug('UPS rate request', {
      url,
      from: `${params.fromCountry} ${params.fromPostalCode}`,
      to: `${params.toCountry} ${params.toPostalCode}`,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        transId: `agora-rate-${Date.now()}`,
        transactionSrc: 'agora',
      },
      body: JSON.stringify(requestBody),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      const errMsg = data?.response?.errors?.[0]?.message || JSON.stringify(data).substring(0, 200);
      throw new Error(`UPS rate API ${res.status}: ${errMsg}`);
    }

    return this.parseRateResponse(data);
  }

  private parseRateResponse(data: any): QuoteResponse[] {
    const ratedShipments = data?.RateResponse?.RatedShipment;
    if (!ratedShipments || !Array.isArray(ratedShipments)) {
      logger.warn('UPS: no RatedShipment in response', { alerts: data?.RateResponse?.Response?.Alert });
      return [];
    }

    return ratedShipments
      .map((rs: any): QuoteResponse | null => {
        const serviceCode = rs.Service?.Code || '';
        const serviceName = UPS_SERVICE_NAMES[serviceCode] || `UPS Service ${serviceCode}`;

        const totalCharge = rs.TotalCharges?.MonetaryValue;
        const currency = rs.TotalCharges?.CurrencyCode || 'USD';
        const totalPrice = parseFloat(totalCharge);

        if (!totalCharge || totalPrice <= 0) return null;

        // Parse transit days from GuaranteedDelivery or TimeInTransit
        let estimatedDays = 0;
        if (rs.GuaranteedDelivery?.BusinessDaysInTransit) {
          estimatedDays = parseInt(rs.GuaranteedDelivery.BusinessDaysInTransit, 10);
        } else if (rs.TimeInTransit?.ServiceSummary?.EstimatedArrival?.BusinessDaysInTransit) {
          estimatedDays = parseInt(rs.TimeInTransit.ServiceSummary.EstimatedArrival.BusinessDaysInTransit, 10);
        }

        return {
          serviceType: serviceCode,
          serviceName,
          totalPrice: parseFloat(totalPrice.toFixed(2)),
          currency,
          estimatedDays,
          carrier: this.carrierId,
        };
      })
      .filter((q): q is QuoteResponse => q !== null);
  }

  // ─── Validation ─────────────────────────────────────────────

  validateTrackingNumber(trackingNumber: string): boolean {
    const cleaned = trackingNumber.replace(/\s/g, '').toUpperCase();

    // 1Z tracking numbers: 1Z + 6 alphanumeric + 2 numeric + 8 numeric = 18 chars
    if (/^1Z[A-Z0-9]{6}\d{10}$/.test(cleaned)) return true;

    // T-numbers (UPS freight/truckload)
    if (/^T\d{10}$/.test(cleaned)) return true;

    // UPS Mail Innovations (starts with MI or digits, 22-34 chars)
    if (/^(MI|mi)?\d{22,34}$/.test(cleaned)) return true;

    return false;
  }
}
