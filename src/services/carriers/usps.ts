/**
 * USPS Carrier Tracker — Tracking only (MVP)
 *
 * Auth: User ID in XML request
 * Track API: https://secure.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=...
 * Docs: https://www.usps.com/business/web-tools-apis/track-and-confirm-api.htm
 *
 * Note: USPS rates/labels require a separate registration (USPS Web Tools eVS).
 * This MVP implementation covers tracking only.
 */

import { CarrierTracker, TrackingResult, TrackingEvent, TrackingStatus } from './types';
import { logger } from '../../utils/logger';

// ─── Constants ──────────────────────────────────────────────────

const USPS_API_URL = 'https://secure.shippingapis.com/ShippingAPI.dll';

/** Map USPS event descriptions to our internal TrackingStatus */
function inferStatusFromEvent(description: string): TrackingStatus {
  const desc = description.toLowerCase();

  if (desc.includes('delivered')) return 'delivered';
  if (desc.includes('out for delivery')) return 'out_for_delivery';
  if (desc.includes('delivery attempt') || desc.includes('notice left') || desc.includes('available for pickup')) {
    return 'delivery_attempted';
  }
  if (
    desc.includes('in transit') ||
    desc.includes('arrived') ||
    desc.includes('departed') ||
    desc.includes('processed') ||
    desc.includes('accepted') ||
    desc.includes('origin')
  ) {
    return 'in_transit';
  }
  if (
    desc.includes('shipping label created') ||
    desc.includes('pre-shipment') ||
    desc.includes('electronic shipping info received')
  ) {
    return 'pre_transit';
  }
  if (
    desc.includes('return') ||
    desc.includes('undeliverable') ||
    desc.includes('alert') ||
    desc.includes('held')
  ) {
    return 'exception';
  }

  return 'unknown';
}

/**
 * Minimal XML parser for USPS responses.
 * Extracts text content and child elements from simple XML structures.
 * Avoids external XML parsing dependencies.
 */
function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractAllXmlTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/** Escape XML special characters for safe inclusion in XML body */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── USPS Carrier Tracker ───────────────────────────────────────

export class USPSTracker implements CarrierTracker {
  readonly name = 'usps';
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const result: TrackingResult = {
      status: 'unknown',
      events: [],
      carrier: this.name,
      trackingNumber,
    };

    const xml = `<TrackFieldRequest USERID="${escapeXml(this.userId)}"><TrackID ID="${escapeXml(trackingNumber)}"></TrackID></TrackFieldRequest>`;
    const url = `${USPS_API_URL}?API=TrackV2&XML=${encodeURIComponent(xml)}`;

    try {
      const res = await fetch(url, { method: 'GET' });

      if (!res.ok) {
        const text = await res.text();
        logger.error('USPS track failed', { status: res.status, trackingNumber, body: text });
        throw new Error(`USPS tracking failed: ${res.status}`);
      }

      const responseXml = await res.text();

      // Check for USPS error response
      const errorDesc = extractXmlTag(responseXml, 'Description');
      const errorNumber = extractXmlTag(responseXml, 'Number');
      if (errorNumber && errorDesc) {
        logger.error('USPS API error', { errorNumber, errorDesc, trackingNumber });
        throw new Error(`USPS API error ${errorNumber}: ${errorDesc}`);
      }

      this.parseTrackResponse(responseXml, result);
    } catch (err) {
      if ((err as Error).message.startsWith('USPS')) throw err;
      logger.error('USPS tracking error', { error: (err as Error).message, trackingNumber });
      throw err;
    }

    return result;
  }

  private parseTrackResponse(xml: string, result: TrackingResult): void {
    try {
      // Extract TrackInfo block
      const trackInfo = extractXmlTag(xml, 'TrackInfo');
      if (!trackInfo) return;

      // Check for error within TrackInfo
      const errorInTrack = extractXmlTag(trackInfo, 'Error');
      if (errorInTrack) {
        const errDesc = extractXmlTag(errorInTrack, 'Description') || 'Unknown USPS error';
        logger.warn('USPS track info error', { error: errDesc, trackingNumber: result.trackingNumber });
        return;
      }

      // Extract summary (latest status)
      const statusSummary = extractXmlTag(trackInfo, 'StatusSummary');
      if (statusSummary) {
        result.status = inferStatusFromEvent(statusSummary);
      }

      // Expected delivery date
      const expectedDelivery = extractXmlTag(trackInfo, 'ExpectedDeliveryDate');
      if (expectedDelivery) {
        const parsed = new Date(expectedDelivery);
        if (!isNaN(parsed.getTime())) {
          result.estimatedDelivery = parsed;
        }
      }

      // Parse TrackDetail events (detailed scan history)
      const trackDetails = extractAllXmlTags(trackInfo, 'TrackDetail');

      // Also parse TrackSummary as the most recent event
      const trackSummary = extractXmlTag(trackInfo, 'TrackSummary');

      const allEventXmls: string[] = [];
      if (trackSummary) allEventXmls.push(trackSummary);
      allEventXmls.push(...trackDetails);

      result.events = allEventXmls.map((eventXml): TrackingEvent => {
        // Extract event fields from TrackFieldRequest response format
        const eventDate = extractXmlTag(eventXml, 'EventDate') || '';
        const eventTime = extractXmlTag(eventXml, 'EventTime') || '';
        const eventCity = extractXmlTag(eventXml, 'EventCity') || '';
        const eventState = extractXmlTag(eventXml, 'EventState') || '';
        const eventZip = extractXmlTag(eventXml, 'EventZIPCode') || '';
        const event = extractXmlTag(eventXml, 'Event') || eventXml;

        // Build timestamp
        let timestamp: Date;
        if (eventDate && eventTime) {
          timestamp = new Date(`${eventDate} ${eventTime}`);
        } else if (eventDate) {
          timestamp = new Date(eventDate);
        } else {
          timestamp = new Date();
        }

        if (isNaN(timestamp.getTime())) {
          timestamp = new Date();
        }

        // Build location
        const locationParts = [eventCity, eventState, eventZip].filter(Boolean);
        const location = locationParts.length > 0 ? locationParts.join(', ') : undefined;

        return {
          timestamp,
          status: inferStatusFromEvent(event),
          description: event,
          location,
        };
      });

      // Sort events newest first
      result.events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      // If we got events, derive top-level status from the most recent
      if (result.events.length > 0 && result.status === 'unknown') {
        result.status = result.events[0].status;
      }

      // If status is delivered, try to set deliveredAt
      if (result.status === 'delivered' && result.events.length > 0) {
        const deliveredEvent = result.events.find(e => e.status === 'delivered');
        if (deliveredEvent) {
          result.deliveredAt = deliveredEvent.timestamp;
        }
      }
    } catch (err) {
      logger.error('USPS parse error', { error: (err as Error).message, trackingNumber: result.trackingNumber });
    }
  }
}
