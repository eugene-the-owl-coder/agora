import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use API key prefix if available, otherwise IP
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      return apiKey.substring(0, 14);
    }
    return req.ip || 'unknown';
  },
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later',
      status: 429,
    },
  },
});

export const strictRateLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests to this endpoint, please try again later',
      status: 429,
    },
  },
});
