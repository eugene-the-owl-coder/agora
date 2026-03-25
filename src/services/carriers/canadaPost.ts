/**
 * Canada Post Tracking — REST API
 *
 * Auth: Basic auth (username:password base64 encoded)
 * Endpoint: https://soa-gw.canadapost.ca/vis/track/pin/{trackingNumber}/summary
 * Docs: https://www.canadapost-postescanada.ca/info/mc/developer/services/tracking.jsf
 */

import { CarrierTracker, TrackingResult, TrackingEvent, TrackingStatus } from './types';
import { logger } from '../../utils/logger';

const CP_BASE_URL = 'https://soa-gw.canadapost.ca/vis/track/pin';

/** Map Canada Post status descriptions to our internal status */
const CP_STATUS_MAP: Record<string, TrackingStatus> = {
  // Item-level statuses
  'Item accepted': 'in_transit',
  'Item processed': 'in_transit',
  'Item in transit': 'in_transit',
  'Item out for delivery': 'out_for_delivery',
  'Item delivered': 'delivered',
  'Delivery attempt': 'delivery_attempted',
  'Item held': 'exception',
  'Item returned': 'exception',
  'Item disposed': 'exception',
  'Notice left': 'delivery_attempted',
  'Available for pickup': 'delivery_attempted',
  // Simplified code-based mapping
  'Shipping label created': 'pre_transit',
  'Electronic information submitted': 'pre_transit',
};

/** Try to match status from description keywords */
function inferStatus(description: string): TrackingStatus {
  const desc = description.toLowerCase();

  if (desc.includes('delivered')) return 'delivered';
  if (desc.includes('out for delivery')) return 'out_for_delivery';
  if (desc.includes('delivery attempt') || desc.includes('notice left') || desc.includes('available for pickup')) {
    return 'delivery_attempted';
  }
  if (desc.includes('in transit') || desc.includes('processed') || desc.includes('accepted') || desc.includes('departed')) {
    return 'in_transit';
  }
  if (desc.includes('label created') || desc.includes('electronic information')) {
    return 'pre_transit';
  }
  if (desc.includes('returned') || desc.includes('held') || desc.includes('disposed')) {
    return 'exception';
  }

  return 'unknown';
}

export class CanadaPostTracker implements CarrierTracker {
  readonly name = 'canada_post';
  private username: string;
  private password: string;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  private get authHeader(): string {
    const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const result: TrackingResult = {
      status: 'unknown',
      events: [],
      carrier: this.name,
      trackingNumber,
    };

    try {
      // Get tracking summary
      const summaryRes = await fetch(`${CP_BASE_URL}/${trackingNumber}/summary`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authHeader,
        },
      });

      if (!summaryRes.ok) {
        const text = await summaryRes.text();
        logger.error('Canada Post summary failed', { status: summaryRes.status, trackingNumber, body: text });
        throw new Error(`Canada Post tracking failed: ${summaryRes.status}`);
      }

      const summaryData = await summaryRes.json();
      this.parseSummary(summaryData, result);

      // Get detailed tracking events
      const detailRes = await fetch(`${CP_BASE_URL}/${trackingNumber}/detail`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authHeader,
        },
      });

      if (detailRes.ok) {
        const detailData = await detailRes.json();
        this.parseDetail(detailData, result);
      }
    } catch (err) {
      logger.error('Canada Post tracking error', { error: (err as Error).message, trackingNumber });
      throw err;
    }

    return result;
  }

  private parseSummary(data: any, result: TrackingResult): void {
    try {
      const summary = data?.['tracking-summary']?.['pin-summary']?.[0];
      if (!summary) return;

      // Current status
      const eventDesc = summary['event-description'] || '';
      result.status = CP_STATUS_MAP[eventDesc] || inferStatus(eventDesc);

      // Delivery date
      if (summary['actual-delivery-date']) {
        result.deliveredAt = new Date(summary['actual-delivery-date']);
        result.status = 'delivered';
      }

      if (summary['expected-delivery-date']) {
        result.estimatedDelivery = new Date(summary['expected-delivery-date']);
      }

      // Signed by
      if (summary['signed-by-name']) {
        result.signedBy = summary['signed-by-name'];
      }
    } catch (err) {
      logger.error('Canada Post summary parse error', { error: (err as Error).message });
    }
  }

  private parseDetail(data: any, result: TrackingResult): void {
    try {
      const details = data?.['tracking-detail']?.['significant-events']?.['occurrence'] || [];

      result.events = details.map((event: any): TrackingEvent => {
        const description = event['event-description'] || '';
        const location = [
          event['event-site'],
          event['event-province'],
        ]
          .filter(Boolean)
          .join(', ');

        // Combine date + time
        let timestamp: Date;
        if (event['event-date'] && event['event-time']) {
          timestamp = new Date(`${event['event-date']}T${event['event-time']}`);
        } else if (event['event-date']) {
          timestamp = new Date(event['event-date']);
        } else {
          timestamp = new Date();
        }

        return {
          timestamp,
          status: CP_STATUS_MAP[description] || inferStatus(description),
          description,
          location: location || undefined,
          rawData: event,
        };
      });

      // Sort events newest first
      result.events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (err) {
      logger.error('Canada Post detail parse error', { error: (err as Error).message });
    }
  }
}
