import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { generateApiKey, verifyApiKey } from '../utils/apiKey';
import { generateWallet, validateWalletAddress } from '../services/wallet';
import { registerSchema, loginApiKeySchema, loginWalletSchema } from '../validators/auth';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { strictRateLimiter, registrationRateLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';
import { sanitizeText } from '../utils/sanitize';
import { getAgentTier } from '../services/trustTier';
import { getAgentRatings } from '../services/rating';
import { getReputationSummary } from '../services/reputation';

const router = Router();

// POST /register
router.post('/register', registrationRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = registerSchema.parse(req.body);

    // Sanitize text fields
    data.name = sanitizeText(data.name, 100);
    if (data.profileDescription) {
      data.profileDescription = sanitizeText(data.profileDescription, 1000);
    }

    // Check email uniqueness
    const existing = await prisma.agent.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new AppError('EMAIL_EXISTS', 'An agent with this email already exists', 409);
    }

    // Generate API key
    const { raw, prefix, hash } = generateApiKey();

    // Optionally create wallet
    let walletAddress: string | null = null;
    let walletEncryptedKey: string | null = null;

    if (data.createWallet) {
      const wallet = generateWallet();
      walletAddress = wallet.address;
      walletEncryptedKey = wallet.encryptedKey;
    } else if (data.walletAddress) {
      if (!validateWalletAddress(data.walletAddress)) {
        throw new AppError('INVALID_WALLET', 'Invalid Solana wallet address', 400);
      }
      walletAddress = data.walletAddress;
    }

    // Validate operator exists if specified
    if (data.operatorId) {
      const operator = await prisma.agent.findUnique({ where: { id: data.operatorId } });
      if (!operator) {
        throw new AppError('OPERATOR_NOT_FOUND', 'Operator agent not found', 404);
      }
    }

    const agent = await prisma.agent.create({
      data: {
        name: data.name,
        email: data.email,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        walletAddress,
        walletEncryptedKey,
        profileDescription: data.profileDescription || null,
        avatarUrl: data.avatarUrl || null,
        operatorId: data.operatorId || null,
        permissions: data.permissions || ['list', 'buy', 'sell'],
        spendingLimits: data.spendingLimits || { maxPerTx: 1000000000, dailyCap: 10000000000 },
      },
    });

    logger.info('Agent registered', { agentId: agent.id, email: agent.email });

    res.status(201).json({
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        walletAddress: agent.walletAddress,
        permissions: agent.permissions,
        createdAt: agent.createdAt,
      },
      apiKey: raw, // Only returned once!
      warning: 'Store this API key securely. It cannot be retrieved again.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /login
router.post('/login', strictRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Try API key login first
    const apiKeyResult = loginApiKeySchema.safeParse(req.body);
    if (apiKeyResult.success) {
      const { apiKey } = apiKeyResult.data;
      const prefix = apiKey.substring(0, 14);
      const agent = await prisma.agent.findFirst({ where: { apiKeyPrefix: prefix } });
      if (!agent) {
        throw new AppError('INVALID_CREDENTIALS', 'Invalid API key', 401);
      }
      const valid = await verifyApiKey(apiKey, agent.apiKeyHash);
      if (!valid) {
        throw new AppError('INVALID_CREDENTIALS', 'Invalid API key', 401);
      }
      const token = jwt.sign({ agentId: agent.id }, config.jwt.secret, {
        expiresIn: config.jwt.expiry,
      } as jwt.SignOptions);
      return res.json({
        token,
        agent: {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          walletAddress: agent.walletAddress,
        },
      });
    }

    // Try wallet signature login
    const walletResult = loginWalletSchema.safeParse(req.body);
    if (walletResult.success) {
      const { walletAddress, signature, message } = walletResult.data;

      // Verify signature
      try {
        const messageBytes = new TextEncoder().encode(message);
        const signatureBytes = Buffer.from(signature, 'base64');
        const publicKeyBytes = Buffer.from(
          // base58 decode
          (() => {
            const bs58chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
            let result = BigInt(0);
            for (const char of walletAddress) {
              result = result * BigInt(58) + BigInt(bs58chars.indexOf(char));
            }
            const bytes = [];
            while (result > 0n) {
              bytes.unshift(Number(result % 256n));
              result = result / 256n;
            }
            // Add leading zeros
            for (const char of walletAddress) {
              if (char === '1') bytes.unshift(0);
              else break;
            }
            return new Uint8Array(bytes);
          })(),
        );

        const valid = nacl.sign.detached.verify(
          messageBytes,
          new Uint8Array(signatureBytes),
          new Uint8Array(publicKeyBytes),
        );

        if (!valid) {
          throw new AppError('INVALID_SIGNATURE', 'Wallet signature verification failed', 401);
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError('INVALID_SIGNATURE', 'Invalid wallet signature', 401);
      }

      const agent = await prisma.agent.findFirst({ where: { walletAddress } });
      if (!agent) {
        throw new AppError('AGENT_NOT_FOUND', 'No agent registered with this wallet', 404);
      }

      const token = jwt.sign({ agentId: agent.id }, config.jwt.secret, {
        expiresIn: config.jwt.expiry,
      } as jwt.SignOptions);

      return res.json({
        token,
        agent: {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          walletAddress: agent.walletAddress,
        },
      });
    }

    throw new AppError('INVALID_CREDENTIALS', 'Provide apiKey or walletAddress+signature+message', 400);
  } catch (err) {
    next(err);
  }
});

// GET /me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = req.agent!.id;

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        name: true,
        email: true,
        walletAddress: true,
        profileDescription: true,
        avatarUrl: true,
        reputation: true,
        totalSales: true,
        totalPurchases: true,
        isVerified: true,
        operatorId: true,
        permissions: true,
        spendingLimits: true,
        buyerRating: true,
        sellerRating: true,
        buyerTxCount: true,
        sellerTxCount: true,
        lastTransactionAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Non-fatal enrichment lookups — each wrapped in try/catch
    let trustTier = null;
    try {
      trustTier = await getAgentTier(agentId);
    } catch (err) {
      logger.warn('Failed to fetch trust tier for /me', { agentId, error: (err as Error).message });
    }

    let ratings = null;
    try {
      ratings = await getAgentRatings(agentId);
    } catch (err) {
      logger.warn('Failed to fetch ratings for /me', { agentId, error: (err as Error).message });
    }

    let reputation = null;
    try {
      reputation = await getReputationSummary(agentId);
    } catch (err) {
      logger.warn('Failed to fetch reputation for /me', { agentId, error: (err as Error).message });
    }

    let stats = null;
    try {
      const [activeListings, activeOrdersAsBuyer, activeOrdersAsSeller] = await Promise.all([
        prisma.listing.count({
          where: { agentId, status: 'active' },
        }),
        prisma.order.count({
          where: { buyerAgentId: agentId, status: { in: ['pending_approval', 'created', 'funded', 'fulfilled'] } },
        }),
        prisma.order.count({
          where: { sellerAgentId: agentId, status: { in: ['pending_approval', 'created', 'funded', 'fulfilled'] } },
        }),
      ]);
      stats = { activeListings, activeOrdersAsBuyer, activeOrdersAsSeller };
    } catch (err) {
      logger.warn('Failed to fetch stats for /me', { agentId, error: (err as Error).message });
    }

    res.json({ agent, trustTier, ratings, reputation, stats });
  } catch (err) {
    next(err);
  }
});

// POST /rotate-key
router.post('/rotate-key', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { raw, prefix, hash } = generateApiKey();

    await prisma.agent.update({
      where: { id: req.agent!.id },
      data: { apiKeyHash: hash, apiKeyPrefix: prefix },
    });

    logger.info('API key rotated', { agentId: req.agent!.id });

    res.json({
      apiKey: raw,
      warning: 'Store this API key securely. It cannot be retrieved again. Previous key is now invalid.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
