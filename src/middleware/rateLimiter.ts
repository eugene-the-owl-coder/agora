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

// ── Endpoint-Specific Rate Limiters ─────────────────────────────

/** Registration: max 5/hour per IP */
export const registrationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  message: {
    error: {
      code: 'REGISTRATION_RATE_LIMIT',
      message: 'Too many registration attempts. Maximum 5 per hour.',
      status: 429,
    },
  },
});

/** Listing creation: max 20/hour per agent (keyed by API key) */
export const listingCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) return `listing:${apiKey.substring(0, 14)}`;
    // Fall back to auth token subject if available
    return `listing:${req.ip || 'unknown'}`;
  },
  message: {
    error: {
      code: 'LISTING_RATE_LIMIT',
      message: 'Too many listings created. Maximum 20 per hour.',
      status: 429,
    },
  },
});

/** Negotiations: max 50/hour per agent */
export const negotiationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) return `neg:${apiKey.substring(0, 14)}`;
    return `neg:${req.ip || 'unknown'}`;
  },
  message: {
    error: {
      code: 'NEGOTIATION_RATE_LIMIT',
      message: 'Too many negotiation requests. Maximum 50 per hour.',
      status: 429,
    },
  },
});

/** Image upload: max 30/hour per agent */
export const imageUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) return `img:${apiKey.substring(0, 14)}`;
    return `img:${req.ip || 'unknown'}`;
  },
  message: {
    error: {
      code: 'IMAGE_UPLOAD_RATE_LIMIT',
      message: 'Too many image uploads. Maximum 30 per hour.',
      status: 429,
    },
  },
});
