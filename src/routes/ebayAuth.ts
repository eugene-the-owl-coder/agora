/**
 * eBay OAuth Integration Routes
 *
 * GET  /api/v1/integrations/ebay/auth-url  — Generate eBay OAuth consent URL
 * POST /api/v1/integrations/ebay/callback  — Handle OAuth callback, store tokens
 * GET  /api/v1/integrations/ebay/status    — Check eBay connection status
 * DELETE /api/v1/integrations/ebay          — Disconnect eBay account
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  getEbayService,
  encryptEbayCredentials,
  decryptEbayCredentials,
} from '../services/marketplaces/ebay';

const router = Router();

// ─── GET /auth-url — Generate eBay OAuth consent URL ────────────────

router.get('/auth-url', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ebay = getEbayService();
    const state = req.agent!.id; // Use agent ID as state for CSRF protection
    const authUrl = ebay.getAuthUrl(state);

    res.json({
      authUrl,
      message: 'Visit this URL to authorize your eBay account with Agora.',
      note: 'After authorizing, eBay will redirect with a code. POST that code to /api/v1/integrations/ebay/callback.',
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /callback — Handle OAuth callback ────────────────────────

const callbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
});

router.post('/callback', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = callbackSchema.parse(req.body);
    const agentId = req.agent!.id;

    const ebay = getEbayService();

    // Exchange code for tokens
    const tokens = await ebay.getUserToken(code);

    // Encrypt and store credentials
    const creds = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    };
    const encrypted = encryptEbayCredentials(creds);

    await prisma.marketplaceCredential.upsert({
      where: { agentId_marketplace: { agentId, marketplace: 'ebay' } },
      create: {
        agentId,
        marketplace: 'ebay',
        encryptedTokens: encrypted,
        isActive: true,
      },
      update: {
        encryptedTokens: encrypted,
        isActive: true,
        updatedAt: new Date(),
      },
    });

    logger.info('eBay credentials stored', { agentId });

    res.json({
      message: 'eBay account connected successfully.',
      marketplace: 'ebay',
      connected: true,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /status — Check eBay connection status ─────────────────────

router.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = req.agent!.id;

    const credential = await prisma.marketplaceCredential.findUnique({
      where: { agentId_marketplace: { agentId, marketplace: 'ebay' } },
    });

    if (!credential || !credential.isActive) {
      res.json({
        marketplace: 'ebay',
        connected: false,
        message: 'No eBay account connected. Use /api/v1/integrations/ebay/auth-url to connect.',
      });
      return;
    }

    // Check if token is still valid
    let tokenValid = false;
    try {
      const creds = decryptEbayCredentials(credential.encryptedTokens);
      tokenValid = creds.expiresAt ? new Date(creds.expiresAt) > new Date() : true;
    } catch {
      tokenValid = false;
    }

    res.json({
      marketplace: 'ebay',
      connected: true,
      tokenValid,
      connectedAt: credential.createdAt,
      lastUpdated: credential.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE / — Disconnect eBay account ─────────────────────────────

router.delete('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = req.agent!.id;

    const credential = await prisma.marketplaceCredential.findUnique({
      where: { agentId_marketplace: { agentId, marketplace: 'ebay' } },
    });

    if (!credential) {
      throw new AppError('NOT_CONNECTED', 'No eBay account connected', 404);
    }

    await prisma.marketplaceCredential.update({
      where: { id: credential.id },
      data: { isActive: false },
    });

    logger.info('eBay account disconnected', { agentId });

    res.json({
      message: 'eBay account disconnected.',
      marketplace: 'ebay',
      connected: false,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
