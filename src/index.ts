import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { prisma } from './lib/prisma';
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
import trackingRoutes from './routes/tracking';
import syndicationRoutes from './routes/syndication';
import ebayAuthRoutes from './routes/ebayAuth';
import shippingRoutes from './routes/shipping';
import { getTrackingOracle } from './services/trackingOracle';
import { oracleRouter, oracleOrderRouter } from './routes/oracle';

const app = express();
// Prisma singleton from lib/prisma.ts

// Global middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(globalRateLimiter);

// Serve static files (landing page, docs, feature request UI)
app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/v1/orders', trackingRoutes);
app.use('/api/v1/listings', syndicationRoutes);
app.use('/api/v1/integrations/ebay', ebayAuthRoutes);
app.use('/api/v1/shipping', shippingRoutes);
app.use('/api/v1/oracle', oracleRouter);
app.use('/api/v1/orders', oracleOrderRouter);

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

      // Start tracking oracle in background
      if (config.nodeEnv !== 'test') {
        try {
          const oracle = getTrackingOracle();
          oracle.start();
        } catch (err) {
          logger.warn('Tracking oracle failed to start (continuing without it)', {
            error: (err as Error).message,
          });
        }
      }
    });
  } catch (err) {
    logger.error('Failed to start server', { error: (err as Error).message });
    process.exit(1);
  }
}

main();

export default app;
