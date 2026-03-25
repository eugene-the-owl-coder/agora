/**
 * Syndication Routes
 *
 * POST   /api/v1/listings/:id/syndicate       — Push listing to external marketplace
 * GET    /api/v1/listings/:id/syndicate        — Get syndication status for a listing
 * DELETE /api/v1/listings/:id/syndicate/:mkt   — Remove from external marketplace
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { logger } from '../utils/logger';
import {
  EbayService,
  getEbayService,
  decryptEbayCredentials,
} from '../services/marketplaces/ebay';
import type { AgoraListing, EbayCredentials } from '../services/marketplaces/types';

const router = Router();

// ─── Validators ─────────────────────────────────────────────────────

const syndicateSchema = z.object({
  marketplace: z.enum(['ebay']),
  credentials: z
    .object({
      refreshToken: z.string().min(1).optional(),
    })
    .optional(),
});

// ─── POST /:id/syndicate — Push listing to marketplace ──────────────

router.post(
  '/:id/syndicate',
  authenticate,
  requireScope('list'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: listingId } = uuidParamSchema.parse(req.params);
      const body = syndicateSchema.parse(req.body);
      const agentId = req.agent!.id;

      // Get listing
      const listing = await prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }
      if (listing.agentId !== agentId) {
        throw new AppError('FORBIDDEN', 'You can only syndicate your own listings', 403);
      }
      if (listing.status !== 'active') {
        throw new AppError('LISTING_NOT_ACTIVE', 'Only active listings can be syndicated', 400);
      }

      // Check if already syndicated
      const existing = await prisma.syndicationRecord.findUnique({
        where: { listingId_marketplace: { listingId, marketplace: body.marketplace } },
      });
      if (existing && existing.status === 'active') {
        throw new AppError(
          'ALREADY_SYNDICATED',
          `Listing is already syndicated to ${body.marketplace}`,
          409,
        );
      }

      // Get credentials — from request body or stored credentials
      let creds: EbayCredentials;

      if (body.credentials?.refreshToken) {
        // One-time credentials from request body
        const ebay = getEbayService();
        const tokens = await ebay.refreshUserToken(body.credentials.refreshToken);
        creds = {
          accessToken: tokens.accessToken,
          refreshToken: body.credentials.refreshToken,
          expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        };
      } else {
        // Use stored credentials
        const stored = await prisma.marketplaceCredential.findUnique({
          where: { agentId_marketplace: { agentId, marketplace: body.marketplace } },
        });
        if (!stored || !stored.isActive) {
          throw new AppError(
            'NO_CREDENTIALS',
            `No ${body.marketplace} credentials found. Connect your account first via /api/v1/integrations/ebay/auth-url`,
            400,
          );
        }
        creds = decryptEbayCredentials(stored.encryptedTokens);
      }

      // Build AgoraListing from Prisma listing
      const agoraListing: AgoraListing = {
        id: listing.id,
        title: listing.title,
        description: listing.description,
        priceUsdc: listing.priceUsdc,
        priceSol: listing.priceSol,
        category: listing.category,
        condition: listing.condition,
        images: listing.images,
        quantity: listing.quantity,
        metadata: listing.metadata as Record<string, unknown>,
      };

      // Create listing on eBay
      const ebay = getEbayService();
      const result = await ebay.createListing(agoraListing, creds);

      // Store syndication record
      await prisma.syndicationRecord.upsert({
        where: { listingId_marketplace: { listingId, marketplace: body.marketplace } },
        create: {
          listingId,
          marketplace: body.marketplace,
          externalId: result.externalId,
          externalUrl: result.url,
          status: 'active',
        },
        update: {
          externalId: result.externalId,
          externalUrl: result.url,
          status: 'active',
          lastSyncedAt: new Date(),
        },
      });

      // Update listing's externalListings JSON
      const externalListings = (listing.externalListings as Record<string, unknown>) || {};
      externalListings[body.marketplace] = {
        id: result.externalId,
        url: result.url,
        syndicatedAt: new Date().toISOString(),
      };
      await prisma.listing.update({
        where: { id: listingId },
        data: { externalListings: externalListings as any },
      });

      logger.info('Listing syndicated', {
        listingId,
        marketplace: body.marketplace,
        externalId: result.externalId,
      });

      res.status(201).json({
        externalId: result.externalId,
        url: result.url,
        marketplace: result.marketplace,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id/syndicate — Get syndication status ────────────────────

router.get(
  '/:id/syndicate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: listingId } = uuidParamSchema.parse(req.params);

      const listing = await prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }

      const records = await prisma.syndicationRecord.findMany({
        where: { listingId },
        orderBy: { createdAt: 'desc' },
      });

      res.json({
        listingId,
        syndications: records.map((r) => ({
          marketplace: r.marketplace,
          externalId: r.externalId,
          url: r.externalUrl,
          status: r.status,
          lastSyncedAt: r.lastSyncedAt,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /:id/syndicate/:marketplace — Remove from marketplace ───

router.delete(
  '/:id/syndicate/:marketplace',
  authenticate,
  requireScope('list'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id: listingId } = uuidParamSchema.parse(req.params);
      const marketplace = req.params.marketplace as string;
      const agentId = req.agent!.id;

      if (!['ebay'].includes(marketplace)) {
        throw new AppError('INVALID_MARKETPLACE', `Unsupported marketplace: ${marketplace}`, 400);
      }

      const listing = await prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }
      if (listing.agentId !== agentId) {
        throw new AppError('FORBIDDEN', 'You can only manage your own listings', 403);
      }

      const record = await prisma.syndicationRecord.findUnique({
        where: { listingId_marketplace: { listingId, marketplace } },
      });
      if (!record) {
        throw new AppError('NOT_SYNDICATED', `Listing is not syndicated to ${marketplace}`, 404);
      }

      // Get credentials
      const stored = await prisma.marketplaceCredential.findUnique({
        where: { agentId_marketplace: { agentId, marketplace } },
      });

      if (stored && stored.isActive) {
        try {
          const creds = decryptEbayCredentials(stored.encryptedTokens);
          const ebay = getEbayService();
          await ebay.delistItem(record.externalId, creds);
        } catch (err) {
          logger.warn('Failed to delist from eBay (continuing with local removal)', {
            error: (err as Error).message,
            externalId: record.externalId,
          });
        }
      }

      // Update syndication record
      await prisma.syndicationRecord.update({
        where: { id: record.id },
        data: { status: 'ended' },
      });

      // Update listing's externalListings JSON
      const externalListings = (listing.externalListings as Record<string, unknown>) || {};
      delete externalListings[marketplace];
      await prisma.listing.update({
        where: { id: listingId },
        data: { externalListings: externalListings as any },
      });

      logger.info('Syndication removed', { listingId, marketplace });

      res.json({ message: `Listing removed from ${marketplace}` });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
