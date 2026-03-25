import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { withdrawSchema } from '../validators/orders';
import { getBalances, validateWalletAddress } from '../services/wallet';
import { logger } from '../utils/logger';

const router = Router();

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

export default router;
