/**
 * Event Notification Service
 *
 * Creates in-app events/notifications for agents when significant
 * things happen: orders, shipments, negotiations, disputes, ratings.
 *
 * Events are fire-and-forget side effects — failures are logged but
 * never block the main operation.
 */

import { Event } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

// ─── Core CRUD ──────────────────────────────────────────────────

export async function createEvent(params: {
  agentId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
}): Promise<Event> {
  const event = await prisma.event.create({
    data: {
      agentId: params.agentId,
      type: params.type,
      title: params.title,
      message: params.message,
      data: params.data ?? undefined,
    },
  });

  logger.info('Event created', {
    eventId: event.id,
    agentId: params.agentId,
    type: params.type,
  });

  return event;
}

export async function getEvents(
  agentId: string,
  params?: {
    unreadOnly?: boolean;
    type?: string;
    limit?: number;
  },
): Promise<Event[]> {
  const where: any = { agentId };

  if (params?.unreadOnly) {
    where.read = false;
  }

  if (params?.type) {
    where.type = params.type;
  }

  return prisma.event.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: params?.limit ?? 50,
  });
}

export async function markRead(eventId: string, agentId: string): Promise<void> {
  await prisma.event.updateMany({
    where: { id: eventId, agentId },
    data: { read: true },
  });
}

export async function markAllRead(agentId: string): Promise<number> {
  const result = await prisma.event.updateMany({
    where: { agentId, read: false },
    data: { read: true },
  });
  return result.count;
}

export async function getUnreadCount(agentId: string): Promise<number> {
  return prisma.event.count({
    where: { agentId, read: false },
  });
}

// ─── Helpers ────────────────────────────────────────────────────

/** Format USDC minor units (BigInt or number) as "$X.XX" display string */
function formatUsdc(amount: bigint | number | string): string {
  const cents = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Fire-and-forget event creation. Logs errors but never throws.
 * Use this for all side-effect event emission in transaction flows.
 */
export function emitEvent(params: {
  agentId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, any>;
}): void {
  createEvent(params).catch((err) => {
    logger.error('Failed to create event', {
      type: params.type,
      agentId: params.agentId,
      error: (err as Error).message,
    });
  });
}

// ─── Order Events ───────────────────────────────────────────────

export function emitOrderCreated(params: {
  sellerId: string;
  buyerName: string;
  listingTitle: string;
  amountUsdc: bigint | number;
  orderId: string;
  listingId: string;
}): void {
  emitEvent({
    agentId: params.sellerId,
    type: 'order.created',
    title: `New order for ${params.listingTitle}`,
    message: `${params.buyerName} purchased your listing for ${formatUsdc(params.amountUsdc)}.`,
    data: {
      orderId: params.orderId,
      listingId: params.listingId,
    },
  });
}

export function emitOrderFunded(params: {
  sellerId: string;
  listingTitle: string;
  amountUsdc: bigint | number;
  orderId: string;
  listingId: string;
}): void {
  emitEvent({
    agentId: params.sellerId,
    type: 'order.funded',
    title: `Payment received for ${params.listingTitle}`,
    message: `Escrow funded with ${formatUsdc(params.amountUsdc)}. Ship the item to proceed.`,
    data: {
      orderId: params.orderId,
      listingId: params.listingId,
    },
  });
}

export function emitOrderShipped(params: {
  buyerId: string;
  listingTitle: string;
  trackingNumber?: string;
  carrier?: string;
  orderId: string;
}): void {
  const trackingInfo = params.trackingNumber
    ? ` Tracking: ${params.trackingNumber}${params.carrier ? ` (${params.carrier})` : ''}`
    : '';
  emitEvent({
    agentId: params.buyerId,
    type: 'order.shipped',
    title: `Your order has shipped!`,
    message: `${params.listingTitle} is on its way.${trackingInfo}`,
    data: {
      orderId: params.orderId,
      trackingNumber: params.trackingNumber,
      carrier: params.carrier,
    },
  });
}

export function emitOrderDelivered(params: {
  buyerId: string;
  listingTitle: string;
  orderId: string;
}): void {
  emitEvent({
    agentId: params.buyerId,
    type: 'order.delivered',
    title: `Your order was delivered`,
    message: `${params.listingTitle} has been delivered. Confirm receipt to release payment.`,
    data: {
      orderId: params.orderId,
    },
  });
}

export function emitOrderCompleted(params: {
  buyerId: string;
  sellerId: string;
  listingTitle: string;
  orderId: string;
}): void {
  const msg = `Transaction complete for ${params.listingTitle}. Collateral returned.`;
  emitEvent({
    agentId: params.buyerId,
    type: 'order.completed',
    title: `Transaction complete`,
    message: msg,
    data: { orderId: params.orderId },
  });
  emitEvent({
    agentId: params.sellerId,
    type: 'order.completed',
    title: `Transaction complete`,
    message: msg,
    data: { orderId: params.orderId },
  });
}

// ─── Meetup Events ──────────────────────────────────────────────

export function emitMeetupScheduled(params: {
  sellerId: string;
  buyerName: string;
  listingTitle: string;
  meetupArea: string;
  meetupTime?: string;
  orderId: string;
  listingId: string;
}): void {
  const timeInfo = params.meetupTime ? ` at ${params.meetupTime}` : '';
  emitEvent({
    agentId: params.sellerId,
    type: 'order.meetup_scheduled',
    title: `Local meetup scheduled for ${params.listingTitle}`,
    message: `${params.buyerName} scheduled a local meetup in ${params.meetupArea}${timeInfo}.`,
    data: {
      orderId: params.orderId,
      listingId: params.listingId,
      meetupArea: params.meetupArea,
      meetupTime: params.meetupTime,
    },
  });
}

export function emitItemHandedOver(params: {
  buyerId: string;
  listingTitle: string;
  orderId: string;
  coolingPeriodEndsAt: string;
}): void {
  emitEvent({
    agentId: params.buyerId,
    type: 'order.handed_over',
    title: `Item handed over — confirm receipt`,
    message: `The seller marked ${params.listingTitle} as handed over. Confirm receipt to release payment. Cooling period ends at ${params.coolingPeriodEndsAt}.`,
    data: {
      orderId: params.orderId,
      coolingPeriodEndsAt: params.coolingPeriodEndsAt,
    },
  });
}

// ─── Negotiation Events ─────────────────────────────────────────

export function emitNegotiationOffer(params: {
  sellerId: string;
  buyerName: string;
  listingTitle: string;
  amountUsdc: number;
  negotiationId: string;
  listingId: string;
}): void {
  emitEvent({
    agentId: params.sellerId,
    type: 'negotiation.offer',
    title: `New offer on ${params.listingTitle}`,
    message: `${params.buyerName} offered ${formatUsdc(params.amountUsdc)} for ${params.listingTitle}.`,
    data: {
      negotiationId: params.negotiationId,
      listingId: params.listingId,
      amount: params.amountUsdc,
    },
  });
}

export function emitNegotiationCounter(params: {
  buyerId: string;
  sellerName: string;
  listingTitle: string;
  amountUsdc: number;
  negotiationId: string;
  listingId: string;
}): void {
  emitEvent({
    agentId: params.buyerId,
    type: 'negotiation.counter',
    title: `Counter offer on ${params.listingTitle}`,
    message: `${params.sellerName} countered with ${formatUsdc(params.amountUsdc)}.`,
    data: {
      negotiationId: params.negotiationId,
      listingId: params.listingId,
      amount: params.amountUsdc,
    },
  });
}

export function emitNegotiationAccepted(params: {
  buyerId: string;
  sellerId: string;
  listingTitle: string;
  amountUsdc: number;
  negotiationId: string;
  listingId: string;
}): void {
  const msg = `Deal agreed at ${formatUsdc(params.amountUsdc)} for ${params.listingTitle}.`;
  emitEvent({
    agentId: params.buyerId,
    type: 'negotiation.accepted',
    title: `Deal agreed!`,
    message: msg,
    data: { negotiationId: params.negotiationId, listingId: params.listingId, amount: params.amountUsdc },
  });
  emitEvent({
    agentId: params.sellerId,
    type: 'negotiation.accepted',
    title: `Deal agreed!`,
    message: msg,
    data: { negotiationId: params.negotiationId, listingId: params.listingId, amount: params.amountUsdc },
  });
}

export function emitNegotiationRejected(params: {
  targetId: string;
  listingTitle: string;
  negotiationId: string;
  listingId: string;
}): void {
  emitEvent({
    agentId: params.targetId,
    type: 'negotiation.rejected',
    title: `Offer rejected`,
    message: `Your offer on ${params.listingTitle} was rejected.`,
    data: { negotiationId: params.negotiationId, listingId: params.listingId },
  });
}

// ─── Dispute Events ─────────────────────────────────────────────

export function emitDisputeOpened(params: {
  targetId: string;
  openerName: string;
  orderId: string;
  disputeId: string;
  reason: string;
}): void {
  emitEvent({
    agentId: params.targetId,
    type: 'dispute.opened',
    title: `Dispute opened`,
    message: `${params.openerName} opened a dispute on order ${params.orderId.slice(0, 8)}… — ${params.reason}.`,
    data: { orderId: params.orderId, disputeId: params.disputeId },
  });
}

export function emitDisputeEvidence(params: {
  targetId: string;
  orderId: string;
  disputeId: string;
}): void {
  emitEvent({
    agentId: params.targetId,
    type: 'dispute.evidence',
    title: `New evidence submitted`,
    message: `New evidence was submitted on the dispute for order ${params.orderId.slice(0, 8)}….`,
    data: { orderId: params.orderId, disputeId: params.disputeId },
  });
}

export function emitDisputeResolved(params: {
  buyerId: string;
  sellerId: string;
  orderId: string;
  disputeId: string;
  resolution: string;
}): void {
  const msg = `Dispute on order ${params.orderId.slice(0, 8)}… resolved: ${params.resolution.replace(/_/g, ' ')}.`;
  emitEvent({
    agentId: params.buyerId,
    type: 'dispute.resolved',
    title: `Dispute resolved`,
    message: msg,
    data: { orderId: params.orderId, disputeId: params.disputeId, resolution: params.resolution },
  });
  emitEvent({
    agentId: params.sellerId,
    type: 'dispute.resolved',
    title: `Dispute resolved`,
    message: msg,
    data: { orderId: params.orderId, disputeId: params.disputeId, resolution: params.resolution },
  });
}

// ─── Rating Events ──────────────────────────────────────────────

export function emitRatingUpdated(params: {
  agentId: string;
  role: 'buyer' | 'seller';
  newRating: number;
}): void {
  emitEvent({
    agentId: params.agentId,
    type: 'rating.updated',
    title: `Rating updated`,
    message: `Your ${params.role} rating updated to ${params.newRating.toFixed(1)}★.`,
    data: { role: params.role, rating: params.newRating },
  });
}
