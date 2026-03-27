import { Router, Request, Response, NextFunction } from 'express';
import { UserWallet } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { withdrawSchema, upsertSettlementWalletSchema } from '../validators/orders';
import { getBalances, validateWalletAddress, generateWallet } from '../services/wallet';
import { logger } from '../utils/logger';

const router = Router();

// POST /provision — provision a wallet for an existing agent
router.post('/provision', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });

    if (!agent) {
      throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 404);
    }

    // If agent already has a wallet, return it without regenerating
    if (agent.walletAddress) {
      return res.json({
        wallet: { address: agent.walletAddress },
        created: false,
        message: 'Wallet already exists.',
      });
    }

    // Generate a new wallet
    const wallet = generateWallet();

    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        walletAddress: wallet.address,
        walletEncryptedKey: wallet.encryptedKey,
      },
    });

    logger.info('Wallet provisioned for existing agent', {
      agentId: agent.id,
      walletAddress: wallet.address,
    });

    res.status(201).json({
      wallet: { address: wallet.address },
      created: true,
      message: 'Wallet created successfully.',
    });
  } catch (err) {
    next(err);
  }
});

// GET / — get wallet balance
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.agent!.walletAddress) {
      throw new AppError('NO_WALLET', 'No wallet associated with this agent', 400);
    }

    const balances = await getBalances(req.agent!.walletAddress);

    res.json({
      wallet: {
        address: req.agent!.walletAddress,
        balances: {
          sol: balances.sol,
          solLamports: balances.solLamports.toString(),
          usdc: balances.usdc,
          usdcRaw: balances.usdcRaw.toString(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /transactions — transaction history
router.get('/transactions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const skip = (page - 1) * limit;

    const where = {
      OR: [
        { fromAgentId: req.agent!.id },
        { toAgentId: req.agent!.id },
      ],
    };

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          order: { select: { id: true, listingId: true } },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      transactions: transactions.map((tx) => ({
        ...tx,
        amountUsdc: tx.amountUsdc?.toString(),
        amountSol: tx.amountSol?.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /withdraw — withdraw to external address
router.post('/withdraw', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = withdrawSchema.parse(req.body);

    if (!req.agent!.walletAddress) {
      throw new AppError('NO_WALLET', 'No wallet associated with this agent', 400);
    }

    if (!validateWalletAddress(data.toAddress)) {
      throw new AppError('INVALID_ADDRESS', 'Invalid destination Solana address', 400);
    }

    // In Phase 2, this will execute the actual transfer
    // For now, record the intent
    const tx = await prisma.transaction.create({
      data: {
        fromAgentId: req.agent!.id,
        amountUsdc: data.amountUsdc ? BigInt(data.amountUsdc) : null,
        amountSol: data.amountSol ? BigInt(data.amountSol) : null,
        txType: 'withdrawal',
        status: 'pending',
      },
    });

    logger.info('Withdrawal requested', {
      agentId: req.agent!.id,
      toAddress: data.toAddress,
    });

    res.json({
      transaction: {
        ...tx,
        amountUsdc: tx.amountUsdc?.toString(),
        amountSol: tx.amountSol?.toString(),
      },
      message: 'Withdrawal request created. Processing will occur in Phase 2.',
    });
  } catch (err) {
    next(err);
  }
});

// ─── Settlement Wallet Helpers ──────────────────────────────────────

function serializeWallet(w: UserWallet) {
  const now = new Date();
  const effectiveAddress =
    w.changeEffectiveAt && w.changeEffectiveAt <= now && w.pendingAddress
      ? w.pendingAddress
      : w.address;
  return {
    role: w.role,
    address: effectiveAddress,
    pendingAddress:
      w.changeEffectiveAt && w.changeEffectiveAt > now ? w.pendingAddress : null,
    changeEffectiveAt: w.changeEffectiveAt,
    activatedAt: w.activatedAt,
    isChangePending: !!(w.changeEffectiveAt && w.changeEffectiveAt > now),
  };
}

const CHANGE_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

// GET /settlement-wallets — list agent's settlement wallets
router.get('/settlement-wallets', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wallets = await prisma.userWallet.findMany({
      where: { agentId: req.agent!.id },
      orderBy: { role: 'asc' },
    });

    res.json({ wallets: wallets.map((w) => serializeWallet(w)) });
  } catch (err) {
    next(err);
  }
});

// PUT /settlement-wallets — set or update a settlement wallet
router.put('/settlement-wallets', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = upsertSettlementWalletSchema.parse(req.body);

    if (!validateWalletAddress(data.address)) {
      throw new AppError('INVALID_ADDRESS', 'Invalid Solana wallet address', 400);
    }

    const existing = await prisma.userWallet.findUnique({
      where: {
        agentId_role: {
          agentId: req.agent!.id,
          role: data.role,
        },
      },
    });

    let result: UserWallet;
    const now = new Date();

    if (existing) {
      // Check if address is the same (no-op)
      const currentEffective =
        existing.changeEffectiveAt && existing.changeEffectiveAt <= now && existing.pendingAddress
          ? existing.pendingAddress
          : existing.address;

      if (currentEffective === data.address) {
        return res.json({ wallet: serializeWallet(existing) });
      }

      // Check change lock
      if (existing.changeLockedUntil && existing.changeLockedUntil > now) {
        throw new AppError(
          'WALLET_CHANGE_LOCKED',
          `Wallet changes are locked until ${existing.changeLockedUntil.toISOString()}. ` +
          'Wait for the current change to take effect before requesting another.',
          409,
        );
      }

      // Apply 24h delay for existing wallet changes
      const effectiveAt = new Date(now.getTime() + CHANGE_DELAY_MS);
      result = await prisma.userWallet.update({
        where: { id: existing.id },
        data: {
          pendingAddress: data.address,
          changeEffectiveAt: effectiveAt,
          changeLockedUntil: effectiveAt,
        },
      });

      logger.info('Settlement wallet change requested (24h delay)', {
        agentId: req.agent!.id,
        role: data.role,
        currentAddress: existing.address,
        pendingAddress: data.address,
        effectiveAt: effectiveAt.toISOString(),
      });
    } else {
      // First-time setup — no delay
      result = await prisma.userWallet.create({
        data: {
          agentId: req.agent!.id,
          role: data.role,
          address: data.address,
        },
      });

      logger.info('Settlement wallet created', {
        agentId: req.agent!.id,
        role: data.role,
        address: data.address,
      });
    }

    res.json({ wallet: serializeWallet(result) });
  } catch (err) {
    next(err);
  }
});

export default router;
