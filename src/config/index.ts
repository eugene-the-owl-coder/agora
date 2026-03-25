import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://agora:agora_dev@localhost:5432/agora?schema=public',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiry: process.env.JWT_EXPIRY || '24h',
  },

  solana: {
    clusterUrl: process.env.SOLANA_CLUSTER_URL || 'https://api.devnet.solana.com',
    usdcMint: process.env.SOLANA_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
  },

  encryption: {
    walletKey: process.env.WALLET_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  webhook: {
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
  },
} as const;
