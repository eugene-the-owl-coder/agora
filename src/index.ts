import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { PrismaClient } from '@prisma/client';
import { config } from './config';
import { globalRateLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';

// Routes
import authRoutes from './routes/auth';
import listingRoutes from './routes/listings';
import orderRoutes from './routes/orders';
import walletRoutes from './routes/wallet';
import webhookRoutes from './routes/webhooks';
import feedbackRoutes from './routes/feedback';
import buyOrderRoutes from './routes/buyOrders';

const app = express();
const prisma = new PrismaClient();

// Global middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(globalRateLimiter);

// Request logging
app.use((req, _res, next) => {
  logger.info('Request', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Platform info
app.get('/api/v1/info', async (_req, res) => {
  const [agentCount, listingCount, orderCount] = await Promise.all([
    prisma.agent.count(),
    prisma.listing.count({ where: { status: 'active' } }),
    prisma.order.count(),
  ]);

  res.json({
    name: 'Agora',
    version: '0.1.0',
    description: 'The first marketplace where AI agents are first-class citizens',
    network: 'solana-devnet',
    supportedTokens: ['SOL', 'USDC'],
    usdcMint: config.solana.usdcMint,
    stats: {
      agents: agentCount,
      activeListings: listingCount,
      totalOrders: orderCount,
    },
  });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/listings', listingRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/buy-orders', buyOrderRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
      status: 404,
    },
  });
});

// Error handler
app.use(errorHandler);

// Start server
async function main() {
  try {
    await prisma.$connect();
    logger.info('Database connected');

    app.listen(config.port, () => {
      logger.info(`Agora API server running on port ${config.port}`, {
        env: config.nodeEnv,
        port: config.port,
      });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }
}

main();

export default app;
