/**
 * Tracking Oracle Service
 *
 * Polls carrier APIs for active orders with tracking numbers.
 * When delivery is confirmed → calls Solana escrow mark_delivered instruction.
 * When dispute window expires → calls release_escrow instruction.
 * Logs all tracking events to the database.
 */

import { PrismaClient } from '@prisma/client';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { createCarrierRegistry, CarrierRegistry, TrackingResult } from './carriers';
import { logger } from '../utils/logger';
import { config } from '../config';

const prisma = new PrismaClient();

export class TrackingOracle {
  private registry: CarrierRegistry;
  private connection: Connection;
  private platformKeypair: Keypair;
  private pollInterval: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    this.registry = createCarrierRegistry();
    this.connection = new Connection(config.solana.clusterUrl, 'confirmed');
    this.pollInterval = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '1800000', 10);

    // Load platform authority keypair
    const keypairStr = process.env.PLATFORM_AUTHORITY_KEYPAIR;
    if (keypairStr) {
      try {
        // Support both base58 and JSON array formats
        const bytes = JSON.parse(keypairStr);
        this.platformKeypair = Keypair.fromSecretKey(new Uint8Array(bytes));
      } catch {
        // Try base58 decode
        const bs58 = require('bs58');
        this.platformKeypair = Keypair.fromSecretKey(bs58.decode(keypairStr));
      }
    } else {
      // Generate a temporary keypair for development
      this.platformKeypair = Keypair.generate();
      logger.warn('No PLATFORM_AUTHORITY_KEYPAIR set — using temporary keypair for oracle');
    }
  }

  /** Start the polling loop */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Tracking Oracle started', {
      pollIntervalMs: this.pollInterval,
      carriers: this.registry.list(),
    });

    // Run immediately, then on interval
    this.poll().catch((err) => {
      logger.error('Initial tracking poll failed', { error: (err as Error).message });
    });

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error('Tracking poll failed', { error: (err as Error).message });
      });
    }, this.pollInterval);
  }

  /** Stop the polling loop */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    logger.info('Tracking Oracle stopped');
  }

  /** Single poll cycle: check all active orders with tracking */
  async poll(): Promise<void> {
    logger.info('Tracking Oracle: starting poll cycle');

    // Find orders that are shipped (have tracking) but not yet delivered/completed
    const activeOrders = await prisma.order.findMany({
      where: {
        status: { in: ['fulfilled'] },
        trackingNumber: { not: null },
      },
      include: {
        buyer: { select: { walletAddress: true } },
        seller: { select: { walletAddress: true } },
      },
    });

    logger.info(`Found ${activeOrders.length} orders to track`);

    for (const order of activeOrders) {
      try {
        await this.trackOrder(order);
      } catch (err) {
        logger.error('Error tracking order', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }

    // Check for expired dispute windows → auto-release
    await this.checkDisputeWindows();
  }

  /** Track a single order and update state */
  private async trackOrder(order: any): Promise<void> {
    const trackingNumber = order.trackingNumber;
    if (!trackingNumber) return;

    // Determine carrier from shipping info or escrow metadata
    const shippingInfo = order.shippingInfo as any;
    const carrierName = shippingInfo?.carrier || this.inferCarrier(trackingNumber);

    if (!carrierName) {
      logger.warn('Cannot determine carrier for order', {
        orderId: order.id,
        trackingNumber,
      });
      return;
    }

    const tracker = this.registry.get(carrierName);
    if (!tracker) {
      logger.warn('No tracker registered for carrier', { carrier: carrierName });
      return;
    }

    const result = await tracker.track(trackingNumber);

    // Log tracking events to database
    await this.logTrackingEvents(order.id, carrierName, result);

    // If delivered, update escrow on-chain
    if (result.status === 'delivered' && result.deliveredAt) {
      logger.info('Delivery confirmed — updating escrow', {
        orderId: order.id,
        deliveredAt: result.deliveredAt,
      });

      try {
        await this.markDeliveredOnChain(order);

        // Update DB status
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'completed' },
        });
      } catch (err) {
        logger.error('Failed to mark delivered on-chain', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Log tracking events to the TrackingEvent table */
  private async logTrackingEvents(
    orderId: string,
    carrier: string,
    result: TrackingResult,
  ): Promise<void> {
    for (const event of result.events) {
      // Upsert to avoid duplicate events
      const eventId = `${orderId}-${carrier}-${event.timestamp.toISOString()}-${event.status}`;

      try {
        await prisma.trackingEvent.upsert({
          where: { id: eventId },
          create: {
            id: eventId,
            orderId,
            carrier,
            status: event.status,
            description: event.description,
            location: event.location || null,
            occurredAt: event.timestamp,
            rawData: (event.rawData || {}) as any,
          },
          update: {
            status: event.status,
            description: event.description,
          },
        });
      } catch (err) {
        // Ignore duplicate key errors
        logger.debug('Tracking event upsert error (likely duplicate)', {
          eventId,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Call Solana escrow program's mark_delivered instruction */
  private async markDeliveredOnChain(order: any): Promise<void> {
    if (!order.escrowAddress) {
      logger.warn('No escrow address for order — skipping on-chain update', {
        orderId: order.id,
      });
      return;
    }

    // In production, this would use the actual Anchor program client
    // to call the mark_delivered instruction with the platform authority keypair.
    // For now, log the intent — the actual integration happens via the escrow service.
    logger.info('Would call mark_delivered on-chain', {
      orderId: order.id,
      escrowAddress: order.escrowAddress,
      platformAuthority: this.platformKeypair.publicKey.toBase58(),
    });

    // TODO: Wire up actual Anchor program call when deployed to devnet
    // const program = getEscrowProgram(this.connection, this.platformKeypair);
    // await program.methods.markDelivered()
    //   .accounts({ ... })
    //   .rpc();
  }

  /** Check orders where dispute window has expired → auto-release */
  private async checkDisputeWindows(): Promise<void> {
    // Find orders marked as delivered where dispute window has passed
    // These would be orders in "delivered" status in the DB with
    // delivered_at + dispute_window < now
    //
    // For MVP, we track this via order metadata. In production,
    // the on-chain timer handles auto-release (trustless).
    logger.debug('Checking dispute windows for auto-release');

    // The actual auto-release is handled by the platform calling
    // release_escrow on the Solana program after the window expires.
    // This is implemented in the escrow service integration (Part C).
  }

  /** Infer carrier from tracking number format */
  private inferCarrier(trackingNumber: string): string | null {
    // FedEx: 12 digits, 15 digits, or 20+ digits
    if (/^\d{12,15}$/.test(trackingNumber) || /^\d{20,}$/.test(trackingNumber)) {
      return 'fedex';
    }

    // Canada Post: 16 digits or starts with specific prefixes
    if (/^\d{16}$/.test(trackingNumber) || /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(trackingNumber)) {
      return 'canada_post';
    }

    return null;
  }
}

/** Singleton oracle instance */
let oracleInstance: TrackingOracle | null = null;

export function getTrackingOracle(): TrackingOracle {
  if (!oracleInstance) {
    oracleInstance = new TrackingOracle();
  }
  return oracleInstance;
}
