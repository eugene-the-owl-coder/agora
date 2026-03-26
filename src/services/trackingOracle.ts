/**
 * Tracking Oracle Service
 *
 * Polls carrier APIs for active orders with tracking numbers.
 * When delivery is confirmed → validates postal code, calls Solana escrow mark_delivered instruction.
 * After grace period expires with no dispute → calls release_escrow instruction.
 * Stores attestation data (carrier response hash, timestamps, destination match).
 * Logs all tracking events to the database.
 */

import { createHash } from 'crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { createCarrierRegistry, CarrierRegistry, TrackingResult } from './carriers';
import { markDeliveredOnChain, releaseEscrow } from './escrow';
import { logger } from '../utils/logger';
import { emitOrderDelivered, emitOrderCompleted } from './events';
import { config } from '../config';

// ── Types ──────────────────────────────────────────────────────────────────

export interface OracleAttestation {
  /** SHA-256 hash of the raw carrier response */
  carrierResponseHash: string;
  /** When the carrier reported delivery */
  carrierDeliveredAt: string;
  /** When the oracle processed the delivery */
  oracleProcessedAt: string;
  /** Whether destination postal code matched buyer's registered postal code */
  postalCodeMatch: boolean;
  /** Buyer's postal code (normalized) */
  buyerPostalCode: string | null;
  /** Carrier-reported delivery postal code (normalized) */
  carrierPostalCode: string | null;
  /** On-chain transaction signature from markDelivered */
  txSignature: string | null;
  /** Whether the attestation was successful */
  attested: boolean;
  /** If attestation failed, why */
  failureReason: string | null;
}

export interface OracleStatus {
  isRunning: boolean;
  activePollCount: number;
  lastPollTime: string | null;
  pollIntervalMs: number;
  carriers: string[];
  gracePeriodHours: number;
}

export interface OracleOrderView {
  orderId: string;
  trackingNumber: string | null;
  carrier: string | null;
  status: string;
  deliveredAt: string | null;
  attestation: OracleAttestation | null;
  lastCarrierResult: TrackingResult | null;
  validationChecks: {
    postalCodeValidated: boolean;
    postalCodeMatch: boolean | null;
    carrierResponseVerified: boolean;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_GRACE_PERIOD_HOURS = 24;
const GRACE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DISPUTE_STALE_DAYS = 7;          // Flag disputes open 7+ days with no resolution
const EVIDENCE_DEADLINE_HOURS = 72;    // Note if no evidence within 72 hours

// ── Oracle Class ───────────────────────────────────────────────────────────

export class TrackingOracle {
  private registry: CarrierRegistry;
  private connection: Connection;
  private platformKeypair: Keypair;
  private pollInterval: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastPollTime: Date | null = null;
  private activePollCount = 0;
  private gracePeriodHours: number;

  constructor() {
    this.registry = createCarrierRegistry();
    this.connection = new Connection(config.solana.clusterUrl, 'confirmed');
    this.pollInterval = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '1800000', 10);
    this.gracePeriodHours = parseInt(
      process.env.ESCROW_GRACE_PERIOD_HOURS || String(DEFAULT_GRACE_PERIOD_HOURS),
      10,
    );

    // Load platform authority keypair
    const keypairStr = process.env.PLATFORM_AUTHORITY_KEYPAIR;
    if (keypairStr) {
      try {
        // Support both base58 and JSON array formats
        const bytes = JSON.parse(keypairStr);
        this.platformKeypair = Keypair.fromSecretKey(new Uint8Array(bytes));
      } catch {
        // Try base58 decode
        const bs58Module = require('bs58'); const bs58 = bs58Module.default || bs58Module;
        this.platformKeypair = Keypair.fromSecretKey(bs58.decode(keypairStr));
      }
    } else {
      // Generate a temporary keypair for development
      this.platformKeypair = Keypair.generate();
      logger.warn('No PLATFORM_AUTHORITY_KEYPAIR set — using temporary keypair for oracle');
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the polling loop and grace period scheduler */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Tracking Oracle started', {
      pollIntervalMs: this.pollInterval,
      gracePeriodHours: this.gracePeriodHours,
      graceCheckIntervalMs: GRACE_CHECK_INTERVAL_MS,
      carriers: this.registry.list(),
    });

    // Run tracking poll immediately, then on interval
    this.poll().catch((err) => {
      logger.error('Initial tracking poll failed', { error: (err as Error).message });
    });

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        logger.error('Tracking poll failed', { error: (err as Error).message });
      });
    }, this.pollInterval);

    // Start grace period auto-release scheduler (every 5 minutes)
    this.graceTimer = setInterval(() => {
      this.processGracePeriodReleases().catch((err) => {
        logger.error('Grace period release check failed', { error: (err as Error).message });
      });
      this.processDisputeTimeouts().catch((err) => {
        logger.error('Dispute timeout check failed', { error: (err as Error).message });
      });
      this.processBuyerTimeoutReleases().catch((err) => {
        logger.error('Buyer timeout release check failed', { error: (err as Error).message });
      });
    }, GRACE_CHECK_INTERVAL_MS);

    // Also run grace period check immediately
    this.processGracePeriodReleases().catch((err) => {
      logger.error('Initial grace period release check failed', { error: (err as Error).message });
    });

    // Run dispute timeout check immediately too
    this.processDisputeTimeouts().catch((err) => {
      logger.error('Initial dispute timeout check failed', { error: (err as Error).message });
    });

    // Run buyer timeout check immediately too
    this.processBuyerTimeoutReleases().catch((err) => {
      logger.error('Initial buyer timeout release check failed', { error: (err as Error).message });
    });
  }

  /** Stop the polling loop and grace period scheduler */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.graceTimer) {
      clearInterval(this.graceTimer);
      this.graceTimer = null;
    }
    this.isRunning = false;
    logger.info('Tracking Oracle stopped');
  }

  // ── Status & Introspection ─────────────────────────────────────────────

  /** Get oracle health/status */
  getStatus(): OracleStatus {
    return {
      isRunning: this.isRunning,
      activePollCount: this.activePollCount,
      lastPollTime: this.lastPollTime?.toISOString() || null,
      pollIntervalMs: this.pollInterval,
      carriers: this.registry.list(),
      gracePeriodHours: this.gracePeriodHours,
    };
  }

  /** Get oracle's view of a specific order's tracking */
  async getOrderView(orderId: string): Promise<OracleOrderView | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        trackingEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!order) return null;

    // Try to get live carrier data
    let lastCarrierResult: TrackingResult | null = null;
    if (order.trackingNumber && order.carrier) {
      try {
        const tracker = this.registry.get(order.carrier);
        if (tracker) {
          lastCarrierResult = await tracker.track(order.trackingNumber);
        }
      } catch (err) {
        logger.warn('Failed to fetch live tracking for oracle view', {
          orderId,
          error: (err as Error).message,
        });
      }
    }

    // Extract attestation from shippingInfo
    const shippingInfo = order.shippingInfo as any;
    const attestation: OracleAttestation | null = shippingInfo?.oracleAttestation || null;

    // Determine validation state
    const postalCodeValidated = attestation !== null;
    const postalCodeMatch = attestation?.postalCodeMatch ?? null;
    const carrierResponseVerified = attestation?.attested ?? false;

    return {
      orderId: order.id,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      status: order.status,
      deliveredAt: order.deliveredAt?.toISOString() || null,
      attestation,
      lastCarrierResult,
      validationChecks: {
        postalCodeValidated,
        postalCodeMatch,
        carrierResponseVerified,
      },
    };
  }

  // ── Polling ────────────────────────────────────────────────────────────

  /** Single poll cycle: check all active orders with tracking */
  async poll(): Promise<void> {
    logger.info('Tracking Oracle: starting poll cycle');
    this.activePollCount++;

    try {
      // Find orders that are shipped (have tracking) but not yet delivered/completed
      const activeOrders = await prisma.order.findMany({
        where: {
          status: { in: ['fulfilled'] },
          trackingNumber: { not: null },
          deliveredAt: null, // Not yet marked as delivered
        },
        include: {
          buyer: { select: { walletAddress: true } },
          seller: { select: { walletAddress: true } },
          listing: { select: { id: true, title: true } },
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

      this.lastPollTime = new Date();
    } finally {
      this.activePollCount--;
    }
  }

  /** Manually trigger a poll for a single order (admin/debug) */
  async pollSingleOrder(orderId: string): Promise<OracleOrderView | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        buyer: { select: { walletAddress: true } },
        seller: { select: { walletAddress: true } },
      },
    });

    if (!order) return null;

    if (order.trackingNumber) {
      await this.trackOrder(order);
    }

    return this.getOrderView(orderId);
  }

  // ── Tracking Logic ─────────────────────────────────────────────────────

  /** Track a single order and update state */
  private async trackOrder(order: any): Promise<void> {
    const trackingNumber = order.trackingNumber;
    if (!trackingNumber) return;

    // Determine carrier from shipping info or escrow metadata
    const shippingInfo = order.shippingInfo as any;
    const carrierName = order.carrier || shippingInfo?.carrier || this.inferCarrier(trackingNumber);

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

    // If delivered, validate and update escrow on-chain
    if (result.status === 'delivered' && result.deliveredAt) {
      logger.info('Delivery confirmed by carrier — validating and attesting', {
        orderId: order.id,
        deliveredAt: result.deliveredAt,
      });

      await this.attestDelivery(order, result);
    }
  }

  // ── Delivery Attestation ───────────────────────────────────────────────

  /**
   * Validate delivery and attest on-chain.
   * 1. Validate destination postal code matches buyer's registered postal code
   * 2. Hash the carrier response for attestation
   * 3. Call markDeliveredOnChain via escrow service
   * 4. Store attestation data in the order
   */
  private async attestDelivery(order: any, result: TrackingResult): Promise<void> {
    const shippingInfo = order.shippingInfo as any;

    // --- Postal Code Validation ---
    const buyerPostalCode = normalizePostalCode(shippingInfo?.zip || shippingInfo?.postalCode || null);
    const carrierPostalCode = this.extractDeliveryPostalCode(result);
    const postalCodeMatch = this.validatePostalCodes(buyerPostalCode, carrierPostalCode);

    // Compute carrier response hash (SHA-256) for attestation
    const carrierResponseHash = createHash('sha256')
      .update(JSON.stringify(result))
      .digest('hex');

    // If postal codes don't match and we have both values, flag and do NOT attest
    if (buyerPostalCode && carrierPostalCode && !postalCodeMatch) {
      const attestation: OracleAttestation = {
        carrierResponseHash,
        carrierDeliveredAt: result.deliveredAt!.toISOString(),
        oracleProcessedAt: new Date().toISOString(),
        postalCodeMatch: false,
        buyerPostalCode,
        carrierPostalCode,
        txSignature: null,
        attested: false,
        failureReason: `Postal code mismatch: buyer=${buyerPostalCode}, carrier=${carrierPostalCode}`,
      };

      logger.warn('Postal code mismatch — delivery NOT attested', {
        orderId: order.id,
        buyerPostalCode,
        carrierPostalCode,
      });

      // Store attestation (failed) in shippingInfo
      await prisma.order.update({
        where: { id: order.id },
        data: {
          shippingInfo: {
            ...(shippingInfo || {}),
            oracleAttestation: attestation,
            oracleFlag: 'POSTAL_CODE_MISMATCH',
          },
        },
      });

      return; // Do NOT attest delivery
    }

    // --- On-Chain Attestation ---
    let txSignature: string | null = null;

    try {
      // Use the order ID for PDA derivation (the escrow service resolves PDA internally)
      txSignature = await markDeliveredOnChain(order.id);

      logger.info('Delivery attested on-chain', {
        orderId: order.id,
        txSignature,
      });
    } catch (err) {
      logger.error('Failed to mark delivered on-chain', {
        orderId: order.id,
        error: (err as Error).message,
      });
      // Continue to update DB even if on-chain call fails —
      // the grace period scheduler will handle release separately
    }

    const attestation: OracleAttestation = {
      carrierResponseHash,
      carrierDeliveredAt: result.deliveredAt!.toISOString(),
      oracleProcessedAt: new Date().toISOString(),
      postalCodeMatch: postalCodeMatch,
      buyerPostalCode,
      carrierPostalCode,
      txSignature,
      attested: true,
      failureReason: null,
    };

    // Update order: set deliveredAt, store attestation, keep status as 'fulfilled'
    // (status changes to 'completed' only after grace period expires)
    await prisma.order.update({
      where: { id: order.id },
      data: {
        deliveredAt: result.deliveredAt,
        shippingInfo: {
          ...(shippingInfo || {}),
          oracleAttestation: attestation,
        },
      },
    });

    // Notify buyer that the order was delivered
    emitOrderDelivered({
      buyerId: order.buyerAgentId,
      listingTitle: order.listing?.title || 'your item',
      orderId: order.id,
    });

    logger.info('Delivery attestation stored', {
      orderId: order.id,
      postalCodeMatch,
      txSignature,
    });
  }

  // ── Postal Code Validation ─────────────────────────────────────────────

  /**
   * Extract delivery destination postal code from carrier tracking result.
   * Looks at the last delivered event's rawData for destination postal info.
   */
  private extractDeliveryPostalCode(result: TrackingResult): string | null {
    // Find the delivery event (last event with status 'delivered')
    const deliveryEvent = result.events.find((e) => e.status === 'delivered');
    if (!deliveryEvent) return null;

    // Try to extract postal code from rawData
    const rawData = deliveryEvent.rawData as any;
    if (!rawData) return null;

    // FedEx: scanLocation has postalCode
    if (rawData.scanLocation?.postalCode) {
      return normalizePostalCode(rawData.scanLocation.postalCode);
    }

    // Canada Post: destination postal code in event data
    if (rawData.destinationPostalCode) {
      return normalizePostalCode(rawData.destinationPostalCode);
    }

    // Try location string — some carriers include postal code in location
    if (deliveryEvent.location) {
      const postalMatch = deliveryEvent.location.match(
        /([A-Z]\d[A-Z]\s?\d[A-Z]\d|\d{5}(-\d{4})?)/i,
      );
      if (postalMatch) {
        return normalizePostalCode(postalMatch[0]);
      }
    }

    return null;
  }

  /**
   * Compare buyer's postal code with carrier's reported delivery postal code.
   * Returns true if they match (or if either is missing — can't validate).
   */
  private validatePostalCodes(
    buyerPostal: string | null,
    carrierPostal: string | null,
  ): boolean {
    // If either is missing, we can't validate — allow delivery
    if (!buyerPostal || !carrierPostal) return true;

    return buyerPostal === carrierPostal;
  }

  // ── Grace Period Auto-Release ──────────────────────────────────────────

  /**
   * Process grace period releases.
   * Finds all orders where:
   *   - status = 'fulfilled' (delivered but grace period not expired)
   *   - deliveredAt is set
   *   - deliveredAt + gracePeriodHours has passed
   *   - no active dispute
   * For each: release escrow → mark completed.
   */
  async processGracePeriodReleases(): Promise<void> {
    const gracePeriodMs = this.gracePeriodHours * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - gracePeriodMs);

    logger.debug('Checking for grace period releases', {
      gracePeriodHours: this.gracePeriodHours,
      cutoffTime: cutoffTime.toISOString(),
    });

    // Find orders eligible for auto-release
    // Exclude orders with ANY dispute (open, evidence_review, or resolved)
    const eligibleOrders = await prisma.order.findMany({
      where: {
        status: 'fulfilled',
        deliveredAt: {
          not: null,
          lte: cutoffTime,
        },
        // Exclude disputed orders — check both the legacy field and the Dispute relation
        disputeReason: null,
        dispute: null,
      },
      include: {
        seller: { select: { walletAddress: true } },
        listing: { select: { id: true, title: true } },
      },
    });

    if (eligibleOrders.length === 0) {
      logger.debug('No orders eligible for grace period release');
      return;
    }

    logger.info(`Processing ${eligibleOrders.length} orders for grace period release`);

    for (const order of eligibleOrders) {
      try {
        await this.releaseOrderEscrow(order);
      } catch (err) {
        logger.error('Failed to release escrow for order', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Release escrow for a single order after grace period.
   */
  private async releaseOrderEscrow(order: any): Promise<void> {
    const sellerWallet = order.seller?.walletAddress;
    if (!sellerWallet) {
      logger.warn('No seller wallet for order — cannot release escrow', {
        orderId: order.id,
      });
      return;
    }

    if (!order.escrowAddress) {
      logger.warn('No escrow address for order — marking completed without on-chain release', {
        orderId: order.id,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'completed',
          resolvedAt: new Date(),
        },
      });
      return;
    }

    logger.info('Releasing escrow after grace period', {
      orderId: order.id,
      escrowAddress: order.escrowAddress,
      deliveredAt: order.deliveredAt?.toISOString(),
    });

    try {
      const txSignature = await releaseEscrow(
        order.escrowAddress,
        sellerWallet,
        order.id, // orderId for PDA derivation
      );

      // Update order to completed
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'completed',
          resolvedAt: new Date(),
          shippingInfo: {
            ...((order.shippingInfo as any) || {}),
            escrowReleaseTx: txSignature,
            escrowReleasedAt: new Date().toISOString(),
          },
        },
      });

      // Record transaction
      if (txSignature && !txSignature.startsWith('RELEASE_STUB_')) {
        await prisma.transaction.create({
          data: {
            orderId: order.id,
            fromAgentId: null,
            toAgentId: order.sellerAgentId,
            txSignature,
            txType: 'escrow_release',
            status: 'confirmed',
          },
        });
      }

      // Notify both parties that transaction is complete
      emitOrderCompleted({
        buyerId: order.buyerAgentId,
        sellerId: order.sellerAgentId,
        listingTitle: order.listing?.title || 'your item',
        orderId: order.id,
      });

      logger.info('Escrow released — order completed', {
        orderId: order.id,
        txSignature,
      });
    } catch (err) {
      logger.error('On-chain escrow release failed', {
        orderId: order.id,
        escrowAddress: order.escrowAddress,
        error: (err as Error).message,
      });
      // Don't update status — will retry on next cycle
    }
  }

  // ── Dispute Timeout Processing ───────────────────────────────────────────

  /**
   * Process dispute timeouts:
   * 1. Flag disputes open 7+ days with no resolution for admin attention
   * 2. Note in the dispute record if no evidence submitted within 72 hours
   */
  async processDisputeTimeouts(): Promise<void> {
    logger.debug('Checking for dispute timeouts');

    const now = new Date();

    // 1. Flag stale disputes (open 7+ days, not yet flagged)
    const staleCutoff = new Date(now.getTime() - DISPUTE_STALE_DAYS * 24 * 60 * 60 * 1000);
    const staleDisputes = await prisma.dispute.findMany({
      where: {
        status: { in: ['open', 'evidence_review'] },
        createdAt: { lte: staleCutoff },
        flaggedAt: null,
      },
    });

    for (const dispute of staleDisputes) {
      try {
        await prisma.dispute.update({
          where: { id: dispute.id },
          data: {
            flaggedAt: now,
            flagReason: `Dispute open for ${DISPUTE_STALE_DAYS}+ days without resolution — requires admin attention`,
          },
        });

        logger.warn('Dispute flagged as stale', {
          disputeId: dispute.id,
          orderId: dispute.orderId,
          openedAt: dispute.createdAt.toISOString(),
          daysOpen: Math.floor((now.getTime() - dispute.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
        });
      } catch (err) {
        logger.error('Failed to flag stale dispute', {
          disputeId: dispute.id,
          error: (err as Error).message,
        });
      }
    }

    // 2. Check evidence deadlines — disputes where the deadline passed with no evidence
    const disputesPastDeadline = await prisma.dispute.findMany({
      where: {
        status: { in: ['open'] },
        evidenceDeadline: { not: null, lte: now },
        flaggedAt: null,
      },
      include: {
        evidence: { select: { id: true } },
      },
    });

    for (const dispute of disputesPastDeadline) {
      if (dispute.evidence.length === 0) {
        try {
          await prisma.dispute.update({
            where: { id: dispute.id },
            data: {
              flaggedAt: now,
              flagReason: `No evidence submitted within ${EVIDENCE_DEADLINE_HOURS} hours of dispute opening`,
            },
          });

          logger.warn('Dispute flagged — no evidence submitted before deadline', {
            disputeId: dispute.id,
            orderId: dispute.orderId,
            evidenceDeadline: dispute.evidenceDeadline?.toISOString(),
          });
        } catch (err) {
          logger.error('Failed to flag evidence-less dispute', {
            disputeId: dispute.id,
            error: (err as Error).message,
          });
        }
      }
    }

    if (staleDisputes.length > 0 || disputesPastDeadline.length > 0) {
      logger.info('Dispute timeout check complete', {
        staleFlagged: staleDisputes.length,
        evidenceDeadlineFlagged: disputesPastDeadline.filter((d) => d.evidence.length === 0).length,
      });
    }
  }

  // ── Tracking Event Logging ─────────────────────────────────────────────

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

  // ── Carrier Inference ──────────────────────────────────────────────────

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

  /**
   * Process buyer non-engagement timeout.
   * If an order has been delivered (tracking confirmed) for 14+ days
   * and buyer hasn't confirmed or disputed, auto-release to seller.
   * This prevents griefing where buyer receives item but never acts.
   */
  async processBuyerTimeoutReleases(): Promise<void> {
    const BUYER_TIMEOUT_DAYS = 14;
    const timeoutMs = BUYER_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = new Date(Date.now() - timeoutMs);

    const timedOutOrders = await prisma.order.findMany({
      where: {
        status: { in: ['fulfilled', 'funded'] },
        deliveredAt: {
          not: null,
          lte: cutoffTime,
        },
        disputeReason: null,
        dispute: null,
      },
      include: {
        seller: { select: { walletAddress: true } },
      },
    });

    if (timedOutOrders.length === 0) return;

    logger.info(`Processing ${timedOutOrders.length} orders for buyer timeout release (14-day non-engagement)`);

    for (const order of timedOutOrders) {
      try {
        logger.info('Buyer timeout - auto-releasing escrow', {
          orderId: order.id,
          deliveredAt: order.deliveredAt,
          daysSinceDelivery: Math.floor((Date.now() - new Date(order.deliveredAt!).getTime()) / (24 * 60 * 60 * 1000)),
        });
        await this.releaseOrderEscrow(order);
      } catch (err) {
        logger.error('Failed buyer timeout release', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }
  }
}

// ── Utility Functions ──────────────────────────────────────────────────────

/** Normalize a postal code for comparison: strip spaces, uppercase */
function normalizePostalCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code.replace(/\s+/g, '').toUpperCase();
}

// ── Singleton ──────────────────────────────────────────────────────────────

/** Singleton oracle instance */
let oracleInstance: TrackingOracle | null = null;

export function getTrackingOracle(): TrackingOracle {
  if (!oracleInstance) {
    oracleInstance = new TrackingOracle();
  }
  return oracleInstance;
}
