/**
 * Shipping Rate Service — Canada Post Rating API
 *
 * Calls Canada Post REST API for real shipping quotes.
 * Falls back to estimated rates when credentials aren't configured.
 *
 * API: POST https://ct.soa-gw.canadapost.ca/rs/ship/price (sandbox)
 *      POST https://soa-gw.canadapost.ca/rs/ship/price (production)
 * Auth: Basic {Base64(user:password)}
 * Format: XML (application/vnd.cpc.ship.rate-v4+xml)
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { XMLParser } from 'fast-xml-parser';

// ─── Types ──────────────────────────────────────────────────────

export interface ShippingRateParams {
  originPostalCode: string;       // Seller's postal code (Canadian format, e.g. "V5K1A1")
  destinationPostalCode?: string;  // Canadian postal code (domestic)
  destinationZip?: string;         // US ZIP code
  destinationCountry?: string;     // ISO country code (CA, US, GB, etc.)
  weightKg: number;                // Package weight in kg
  lengthCm: number;                // Package length in cm
  widthCm: number;                 // Package width in cm
  heightCm: number;                // Package height in cm
}

export interface ShippingOption {
  serviceCode: string;
  serviceName: string;
  priceCAD: number;
  priceUSDC: number;
  transitDays: number | null;
  expectedDelivery: string | null;
  guaranteed: boolean;
  isEstimate: boolean;            // true = fallback rate, false = real API quote
}

// ─── Constants ──────────────────────────────────────────────────

const SANDBOX_URL = 'https://ct.soa-gw.canadapost.ca/rs/ship/price';
const PRODUCTION_URL = 'https://soa-gw.canadapost.ca/rs/ship/price';

const SERVICE_NAMES: Record<string, string> = {
  'DOM.RP': 'Regular Parcel',
  'DOM.EP': 'Expedited Parcel',
  'DOM.XP': 'Xpresspost',
  'DOM.PC': 'Priority',
  'USA.EP': 'Expedited Parcel USA',
  'USA.TP': 'Tracked Packet USA',
  'USA.XP': 'Xpresspost USA',
  'INT.XP': 'Xpresspost International',
  'INT.IP.AIR': 'International Parcel Air',
  'INT.SP.AIR': 'Small Packet Air International',
};

// ─── Helpers ────────────────────────────────────────────────────

/** Normalize a Canadian postal code: uppercase, no spaces */
function normalizePostalCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

/** Determine destination type from params */
function getDestinationType(params: ShippingRateParams): 'domestic' | 'us' | 'international' {
  const country = params.destinationCountry?.toUpperCase();

  if (country === 'CA' || (!country && params.destinationPostalCode && !params.destinationZip)) {
    return 'domestic';
  }
  if (country === 'US' || (!country && params.destinationZip)) {
    return 'us';
  }
  return 'international';
}

/** Build Canada Post rating request XML */
function buildRatingXml(params: ShippingRateParams): string {
  const origin = normalizePostalCode(params.originPostalCode);
  const destType = getDestinationType(params);

  // Ensure dimensions meet minimums (Canada Post requires > 0)
  const weight = Math.max(params.weightKg, 0.01);
  const length = Math.max(params.lengthCm, 1);
  const width = Math.max(params.widthCm, 1);
  const height = Math.max(params.heightCm, 1);

  let destinationXml: string;
  if (destType === 'domestic') {
    const destPC = normalizePostalCode(params.destinationPostalCode || '');
    destinationXml = `<destination><domestic><postal-code>${destPC}</postal-code></domestic></destination>`;
  } else if (destType === 'us') {
    const zip = (params.destinationZip || '').replace(/\s+/g, '');
    destinationXml = `<destination><united-states><zip-code>${zip}</zip-code></united-states></destination>`;
  } else {
    const countryCode = (params.destinationCountry || 'US').toUpperCase();
    destinationXml = `<destination><international><country-code>${countryCode}</country-code></international></destination>`;
  }

  const customerNumberAttr = config.canadaPost.customerNumber
    ? ` customer-number="${config.canadaPost.customerNumber}"`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<mailing-scenario xmlns="http://www.canadapost.ca/ws/ship/rate-v4">
  ${customerNumberAttr ? `<customer-number>${config.canadaPost.customerNumber}</customer-number>` : ''}
  <parcel-characteristics>
    <weight>${weight.toFixed(3)}</weight>
    <dimensions>
      <length>${length.toFixed(1)}</length>
      <width>${width.toFixed(1)}</width>
      <height>${height.toFixed(1)}</height>
    </dimensions>
  </parcel-characteristics>
  <origin-postal-code>${origin}</origin-postal-code>
  ${destinationXml}
</mailing-scenario>`;
}

/** Parse Canada Post rating response XML */
function parseRatingResponse(xml: string, cadToUsdcRate: number): ShippingOption[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });

  const parsed = parser.parse(xml);

  // Handle errors
  if (parsed.messages?.message) {
    const msg = parsed.messages.message;
    const errCode = msg.code || msg['@_code'] || 'UNKNOWN';
    const errDesc = msg.description || 'Unknown error';
    throw new Error(`Canada Post API error ${errCode}: ${errDesc}`);
  }

  // Navigate to price-quotes
  const priceQuotes = parsed['price-quotes'];
  if (!priceQuotes) {
    logger.warn('Canada Post: no price-quotes in response');
    return [];
  }

  // Normalize to array
  let quotes = priceQuotes['price-quote'];
  if (!quotes) return [];
  if (!Array.isArray(quotes)) quotes = [quotes];

  return quotes.map((q: any): ShippingOption => {
    const serviceCode = q['service-code'] || '';
    const serviceName = q['service-name'] || SERVICE_NAMES[serviceCode] || serviceCode;

    // Price
    const priceDetails = q['price-details'] || {};
    const priceCAD = parseFloat(priceDetails.due || q.due || '0');
    const priceUSDC = parseFloat((priceCAD * cadToUsdcRate).toFixed(2));

    // Transit
    const serviceStandard = q['service-standard'] || {};
    const transitDays = serviceStandard['expected-transit-time']
      ? parseInt(serviceStandard['expected-transit-time'], 10)
      : null;
    const expectedDelivery = serviceStandard['expected-delivery-date'] || null;
    const guaranteed = serviceStandard['guaranteed-delivery'] === 'true' ||
                       serviceStandard['guaranteed-delivery'] === true;

    return {
      serviceCode,
      serviceName,
      priceCAD,
      priceUSDC,
      transitDays,
      expectedDelivery,
      guaranteed,
      isEstimate: false,
    };
  });
}

// ─── Fallback Estimated Rates ───────────────────────────────────

function getFallbackRates(params: ShippingRateParams): ShippingOption[] {
  const destType = getDestinationType(params);
  const weight = params.weightKg;
  const cadToUsdcRate = config.shipping.cadToUsdcRate;

  if (destType === 'domestic') {
    const baseRates = [
      { code: 'DOM.RP', name: 'Regular Parcel (Estimated)', cad: weight <= 0.5 ? 15 : weight <= 2 ? 20 : weight <= 5 ? 25 : 35, transit: 7 },
      { code: 'DOM.EP', name: 'Expedited Parcel (Estimated)', cad: weight <= 0.5 ? 18 : weight <= 2 ? 24 : weight <= 5 ? 30 : 42, transit: 5 },
      { code: 'DOM.XP', name: 'Xpresspost (Estimated)', cad: weight <= 0.5 ? 22 : weight <= 2 ? 30 : weight <= 5 ? 38 : 55, transit: 2 },
    ];
    return baseRates.map(r => ({
      serviceCode: r.code,
      serviceName: r.name,
      priceCAD: r.cad,
      priceUSDC: parseFloat((r.cad * cadToUsdcRate).toFixed(2)),
      transitDays: r.transit,
      expectedDelivery: null,
      guaranteed: false,
      isEstimate: true,
    }));
  }

  if (destType === 'us') {
    const baseRates = [
      { code: 'USA.TP', name: 'Tracked Packet USA (Estimated)', cad: weight <= 0.5 ? 20 : weight <= 2 ? 30 : weight <= 5 ? 40 : 55, transit: 8 },
      { code: 'USA.EP', name: 'Expedited Parcel USA (Estimated)', cad: weight <= 0.5 ? 25 : weight <= 2 ? 35 : weight <= 5 ? 50 : 70, transit: 6 },
      { code: 'USA.XP', name: 'Xpresspost USA (Estimated)', cad: weight <= 0.5 ? 35 : weight <= 2 ? 45 : weight <= 5 ? 60 : 85, transit: 3 },
    ];
    return baseRates.map(r => ({
      serviceCode: r.code,
      serviceName: r.name,
      priceCAD: r.cad,
      priceUSDC: parseFloat((r.cad * cadToUsdcRate).toFixed(2)),
      transitDays: r.transit,
      expectedDelivery: null,
      guaranteed: false,
      isEstimate: true,
    }));
  }

  // International
  const baseRates = [
    { code: 'INT.SP.AIR', name: 'Small Packet Air (Estimated)', cad: weight <= 0.5 ? 25 : weight <= 2 ? 40 : 60, transit: 12 },
    { code: 'INT.IP.AIR', name: 'International Parcel Air (Estimated)', cad: weight <= 0.5 ? 40 : weight <= 2 ? 55 : weight <= 5 ? 75 : 100, transit: 10 },
    { code: 'INT.XP', name: 'Xpresspost International (Estimated)', cad: weight <= 0.5 ? 55 : weight <= 2 ? 70 : weight <= 5 ? 95 : 130, transit: 5 },
  ];
  return baseRates.map(r => ({
    serviceCode: r.code,
    serviceName: r.name,
    priceCAD: r.cad,
    priceUSDC: parseFloat((r.cad * cadToUsdcRate).toFixed(2)),
    transitDays: r.transit,
    expectedDelivery: null,
    guaranteed: false,
    isEstimate: true,
  }));
}

// ─── Main Entry Point ───────────────────────────────────────────

export async function getShippingRates(params: ShippingRateParams): Promise<ShippingOption[]> {
  const { apiUser, apiPassword, sandbox } = config.canadaPost;
  const cadToUsdcRate = config.shipping.cadToUsdcRate;

  // If no credentials, return fallback estimates
  if (!apiUser || !apiPassword) {
    logger.info('Shipping: no Canada Post credentials, returning estimated rates');
    return getFallbackRates(params);
  }

  const url = sandbox ? SANDBOX_URL : PRODUCTION_URL;
  const xmlBody = buildRatingXml(params);
  const auth = Buffer.from(`${apiUser}:${apiPassword}`).toString('base64');

  try {
    logger.debug('Shipping: calling Canada Post rating API', { url, origin: params.originPostalCode });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.cpc.ship.rate-v4+xml',
        'Accept': 'application/vnd.cpc.ship.rate-v4+xml',
        'Authorization': `Basic ${auth}`,
      },
      body: xmlBody,
    });

    const responseXml = await response.text();

    if (!response.ok) {
      logger.error('Canada Post rating API error', {
        status: response.status,
        body: responseXml.substring(0, 500),
      });

      // Fall back to estimates on API error
      logger.info('Shipping: falling back to estimated rates due to API error');
      return getFallbackRates(params);
    }

    const options = parseRatingResponse(responseXml, cadToUsdcRate);

    if (options.length === 0) {
      logger.warn('Shipping: API returned no quotes, falling back to estimates');
      return getFallbackRates(params);
    }

    logger.info('Shipping: got Canada Post quotes', { count: options.length });
    return options;
  } catch (err) {
    logger.error('Shipping rate fetch failed', { error: (err as Error).message });
    // Always fall back gracefully
    return getFallbackRates(params);
  }
}
