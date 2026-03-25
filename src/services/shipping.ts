/**
 * Shipping Rate Service — FedEx Rate API (primary) + Canada Post fallback
 *
 * FedEx Sandbox: https://apis-sandbox.fedex.com/rate/v1/rates/quotes
 * FedEx Production: https://apis.fedex.com/rate/v1/rates/quotes
 * Auth: OAuth2 client_credentials → Bearer token
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────

export interface ShippingRateParams {
  originPostalCode: string;
  originCountry?: string;          // ISO 2-letter, defaults to CA
  destinationPostalCode?: string;
  destinationZip?: string;
  destinationCountry?: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface ShippingOption {
  serviceCode: string;
  serviceName: string;
  priceCAD: number;
  priceUSDC: number;
  transitDays: number | null;
  expectedDelivery: string | null;
  guaranteed: boolean;
  isEstimate: boolean;
  carrier: 'fedex' | 'canadapost' | 'estimate';
}

// ─── FedEx OAuth Token Cache ────────────────────────────────────

let fedexToken: string | null = null;
let fedexTokenExpiry = 0;

async function getFedExToken(): Promise<string> {
  if (fedexToken && Date.now() < fedexTokenExpiry - 60_000) {
    return fedexToken;
  }

  const { clientId, clientSecret, sandbox } = config.fedex;
  const url = sandbox
    ? 'https://apis-sandbox.fedex.com/oauth/token'
    : 'https://apis.fedex.com/oauth/token';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FedEx OAuth failed ${res.status}: ${body.substring(0, 200)}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  fedexToken = data.access_token;
  fedexTokenExpiry = Date.now() + data.expires_in * 1000;
  logger.info('FedEx: OAuth token acquired', { expiresIn: data.expires_in });
  return fedexToken;
}

// ─── FedEx Rate Quote ───────────────────────────────────────────

async function getFedExRates(params: ShippingRateParams): Promise<ShippingOption[]> {
  const token = await getFedExToken();
  const { sandbox, accountNumber } = config.fedex;
  const cadToUsdc = config.shipping.cadToUsdcRate;

  const url = sandbox
    ? 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes'
    : 'https://apis.fedex.com/rate/v1/rates/quotes';

  // Determine destination
  const destCountry = params.destinationCountry?.toUpperCase() ||
    (params.destinationZip ? 'US' : 'CA');
  const destPostal = params.destinationPostalCode || params.destinationZip || '';
  const originCountry = params.originCountry?.toUpperCase() || 'CA';

  // Convert cm → inches, kg → lbs for FedEx (imperial)
  const weightLbs = Math.max(params.weightKg * 2.20462, 0.1);
  const lengthIn = Math.max(Math.round(params.lengthCm / 2.54), 1);
  const widthIn = Math.max(Math.round(params.widthCm / 2.54), 1);
  const heightIn = Math.max(Math.round(params.heightCm / 2.54), 1);

  const body: any = {
    accountNumber: { value: accountNumber },
    requestedShipment: {
      shipper: {
        address: {
          postalCode: params.originPostalCode.replace(/\s/g, '').toUpperCase(),
          countryCode: originCountry,
        },
      },
      recipient: {
        address: {
          postalCode: destPostal.replace(/\s/g, '').toUpperCase(),
          countryCode: destCountry,
        },
      },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['LIST', 'ACCOUNT'],
      requestedPackageLineItems: [
        {
          weight: {
            units: 'LB',
            value: parseFloat(weightLbs.toFixed(1)),
          },
          dimensions: {
            length: lengthIn,
            width: widthIn,
            height: heightIn,
            units: 'IN',
          },
        },
      ],
    },
  };

  logger.debug('FedEx rate request', { url, destCountry, destPostal });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-locale': 'en_CA',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;

  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.message || JSON.stringify(data).substring(0, 200);
    throw new Error(`FedEx rate API ${res.status}: ${errMsg}`);
  }

  // Parse rate reply
  const rateDetails = data?.output?.rateReplyDetails;
  if (!rateDetails || !Array.isArray(rateDetails)) {
    logger.warn('FedEx: no rateReplyDetails', { alerts: data?.output?.alerts });
    return [];
  }

  return rateDetails.map((rd: any): ShippingOption => {
    const serviceCode = rd.serviceType || '';
    const serviceName = rd.serviceName || serviceCode.replace(/_/g, ' ');

    // Get the best rate (account rate if available, otherwise list)
    const rates = rd.ratedShipmentDetails || [];
    const accountRate = rates.find((r: any) => r.rateType === 'ACCOUNT');
    const listRate = rates.find((r: any) => r.rateType === 'LIST');
    const bestRate = accountRate || listRate || rates[0];

    const totalCharge = bestRate?.totalNetCharge ?? bestRate?.totalNetFedExCharge ?? 0;
    const currency = bestRate?.currency || 'CAD';

    // Convert to CAD if needed
    let priceCAD = parseFloat(totalCharge);
    if (currency === 'USD') {
      priceCAD = priceCAD / cadToUsdc; // USD → CAD approximate
    }

    const transitDays = rd.operationalDetail?.transitDays
      ? parseInt(rd.operationalDetail.transitDays, 10)
      : (rd.commit?.transitDays?.amount ? parseInt(rd.commit.transitDays.amount, 10) : null);

    const deliveryDate = rd.commit?.dateDetail?.dayFormat || rd.operationalDetail?.deliveryDate || null;

    return {
      serviceCode,
      serviceName,
      priceCAD: parseFloat(priceCAD.toFixed(2)),
      priceUSDC: parseFloat((priceCAD * cadToUsdc).toFixed(2)),
      transitDays,
      expectedDelivery: deliveryDate,
      guaranteed: rd.commit?.guaranteed === true,
      isEstimate: false,
      carrier: 'fedex',
    };
  }).filter((opt: ShippingOption) => opt.priceCAD > 0);
}

// ─── Fallback Estimated Rates ───────────────────────────────────

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

function getFallbackRates(params: ShippingRateParams): ShippingOption[] {
  const destType = getDestinationType(params);
  const weight = params.weightKg;
  const cadToUsdc = config.shipping.cadToUsdcRate;

  const makeOption = (code: string, name: string, cad: number, transit: number): ShippingOption => ({
    serviceCode: code,
    serviceName: name,
    priceCAD: cad,
    priceUSDC: parseFloat((cad * cadToUsdc).toFixed(2)),
    transitDays: transit,
    expectedDelivery: null,
    guaranteed: false,
    isEstimate: true,
    carrier: 'estimate',
  });

  if (destType === 'domestic') {
    return [
      makeOption('GROUND', 'FedEx Ground (Estimated)', weight <= 0.5 ? 14 : weight <= 2 ? 18 : weight <= 5 ? 24 : 32, 5),
      makeOption('EXPRESS_SAVER', 'FedEx Express Saver (Estimated)', weight <= 0.5 ? 20 : weight <= 2 ? 26 : weight <= 5 ? 34 : 48, 3),
      makeOption('PRIORITY_OVERNIGHT', 'FedEx Priority (Estimated)', weight <= 0.5 ? 30 : weight <= 2 ? 38 : weight <= 5 ? 50 : 70, 1),
    ];
  }

  if (destType === 'us') {
    return [
      makeOption('FEDEX_GROUND', 'FedEx Ground US (Estimated)', weight <= 0.5 ? 18 : weight <= 2 ? 28 : weight <= 5 ? 38 : 52, 7),
      makeOption('FEDEX_EXPRESS_SAVER', 'FedEx Express Saver US (Estimated)', weight <= 0.5 ? 30 : weight <= 2 ? 40 : weight <= 5 ? 55 : 75, 4),
      makeOption('FEDEX_2_DAY', 'FedEx 2Day US (Estimated)', weight <= 0.5 ? 40 : weight <= 2 ? 52 : weight <= 5 ? 68 : 95, 2),
    ];
  }

  return [
    makeOption('INTERNATIONAL_ECONOMY', 'FedEx Intl Economy (Estimated)', weight <= 0.5 ? 35 : weight <= 2 ? 55 : weight <= 5 ? 75 : 100, 8),
    makeOption('INTERNATIONAL_PRIORITY', 'FedEx Intl Priority (Estimated)', weight <= 0.5 ? 55 : weight <= 2 ? 75 : weight <= 5 ? 100 : 140, 4),
  ];
}

// ─── Main Entry Point ───────────────────────────────────────────

export async function getShippingRates(params: ShippingRateParams): Promise<ShippingOption[]> {
  const { clientId, clientSecret } = config.fedex;

  // If no FedEx credentials, return fallback estimates
  if (!clientId || !clientSecret) {
    logger.info('Shipping: no FedEx credentials, returning estimated rates');
    return getFallbackRates(params);
  }

  try {
    logger.debug('Shipping: calling FedEx Rate API', { origin: params.originPostalCode });
    const options = await getFedExRates(params);

    if (options.length === 0) {
      logger.warn('Shipping: FedEx returned no quotes, falling back to estimates');
      return getFallbackRates(params);
    }

    logger.info('Shipping: got FedEx quotes', { count: options.length });
    return options;
  } catch (err) {
    logger.error('Shipping rate fetch failed', { error: (err as Error).message });
    return getFallbackRates(params);
  }
}
