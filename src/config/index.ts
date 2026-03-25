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
    cluster: process.env.SOLANA_CLUSTER || 'devnet',
    platformAuthorityKeypair: process.env.PLATFORM_AUTHORITY_KEYPAIR || '',
  },

  carriers: {
    fedexClientId: process.env.FEDEX_CLIENT_ID || '',
    fedexClientSecret: process.env.FEDEX_CLIENT_SECRET || '',
    canadaPostUsername: process.env.CANADA_POST_USERNAME || '',
    canadaPostPassword: process.env.CANADA_POST_PASSWORD || '',
  },

  tracking: {
    pollIntervalMs: parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '1800000', 10),
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

  ebay: {
    appId: process.env.EBAY_APP_ID || '',
    certId: process.env.EBAY_CERT_ID || '',
    devId: process.env.EBAY_DEV_ID || '',
    redirectUri: process.env.EBAY_REDIRECT_URI || '',
    sandbox: process.env.EBAY_SANDBOX !== 'false', // default true (sandbox mode)
    usdcToUsdRate: parseFloat(process.env.EBAY_USDC_TO_USD_RATE || '1.0'),
  },
} as const;

// Production safety guards — fail fast if secrets are defaults
if (config.nodeEnv === 'production') {
  const fatal = (msg: string) => { console.error(`FATAL: ${msg}`); process.exit(1); };
  if (config.jwt.secret === 'dev-secret-change-me') fatal('JWT_SECRET must be set in production');
  if (config.encryption.walletKey === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') fatal('WALLET_ENCRYPTION_KEY must be set in production');
  if (!config.database.url || config.database.url.includes('agora_dev')) fatal('DATABASE_URL must use production credentials');
}
