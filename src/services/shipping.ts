/**
 * Shipping Rate Service — Multi-carrier with FedEx fallback estimates
 *
 * Now delegates to CarrierPlugin.getQuotes() when available.
 * Keeps the original ShippingRateParams/ShippingOption interface for backward compat.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { createCarrierRegistry, CarrierRegistry, QuoteRequest } from './carriers';

// ─── Types (backward compat) ────────────────────────────────────

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

// ─── Singleton registry ─────────────────────────────────────────

let _registry: CarrierRegistry | null = null;
function getRegistry(): CarrierRegistry {
  if (!_registry) {
    _registry = createCarrierRegistry();
  }
  return _registry;
}

// ─── Convert legacy params to QuoteRequest ──────────────────────

function toQuoteRequest(params: ShippingRateParams): QuoteRequest {
  const destCountry = params.destinationCountry?.toUpperCase() ||
    (params.destinationZip ? 'US' : 'CA');
  const destPostal = params.destinationPostalCode || params.destinationZip || '';
  const originCountry = params.originCountry?.toUpperCase() || 'CA';

  return {
    fromPostalCode: params.originPostalCode,
    fromCountry: originCountry,
    toPostalCode: destPostal,
    toCountry: destCountry,
    weight: { value: params.weightKg, unit: 'kg' },
    dimensions: {
      length: params.lengthCm,
      width: params.widthCm,
      height: params.heightCm,
      unit: 'cm',
    },
  };
}

// ─── Convert QuoteResponse → ShippingOption (backward compat) ───

function quoteToShippingOption(
  quote: { serviceType: string; serviceName: string; totalPrice: number; currency: string; estimatedDays: number; carrier: string },
): ShippingOption {
  const cadToUsdc = config.shipping.cadToUsdcRate;

  // Normalize price to CAD
  let priceCAD = quote.totalPrice;
  if (quote.currency === 'USD') {
    priceCAD = priceCAD / cadToUsdc;
  }

  return {
    serviceCode: quote.serviceType,
    serviceName: quote.serviceName,
    priceCAD: parseFloat(priceCAD.toFixed(2)),
    priceUSDC: parseFloat((priceCAD * cadToUsdc).toFixed(2)),
    transitDays: quote.estimatedDays || null,
    expectedDelivery: null,
    guaranteed: false,
    isEstimate: false,
    carrier: (quote.carrier === 'fedex' ? 'fedex' : 'estimate') as ShippingOption['carrier'],
  };
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

// ─── Main Entry Point (backward compat) ─────────────────────────

export async function getShippingRates(params: ShippingRateParams): Promise<ShippingOption[]> {
  const registry = getRegistry();
  const plugins = registry.listPlugins();

  // If no plugins with credentials, return fallback estimates
  if (plugins.length === 0) {
    logger.info('Shipping: no carrier plugins available, returning estimated rates');
    return getFallbackRates(params);
  }

  try {
    const quoteRequest = toQuoteRequest(params);

    // Gather quotes from all carrier plugins
    const allQuotes: ShippingOption[] = [];
    const errors: string[] = [];

    for (const plugin of plugins) {
      try {
        logger.debug('Shipping: getting quotes from carrier', { carrier: plugin.carrierId });
        const quotes = await plugin.getQuotes(quoteRequest);
        allQuotes.push(...quotes.map(quoteToShippingOption));
      } catch (err) {
        errors.push(`${plugin.carrierId}: ${(err as Error).message}`);
        logger.error('Shipping: carrier quote failed', {
          carrier: plugin.carrierId,
          error: (err as Error).message,
        });
      }
    }

    if (allQuotes.length === 0) {
      if (errors.length > 0) {
        logger.warn('Shipping: all carriers failed, falling back to estimates', { errors });
      } else {
        logger.warn('Shipping: no quotes returned, falling back to estimates');
      }
      return getFallbackRates(params);
    }

    // Sort by price ascending
    allQuotes.sort((a, b) => a.priceCAD - b.priceCAD);

    logger.info('Shipping: got multi-carrier quotes', { count: allQuotes.length });
    return allQuotes;
  } catch (err) {
    logger.error('Shipping rate fetch failed', { error: (err as Error).message });
    return getFallbackRates(params);
  }
}
