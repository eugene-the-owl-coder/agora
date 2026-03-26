import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const router = Router();

// ─── Constants ──────────────────────────────────────────────────

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'listings');

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

// ─── Rate Limiter (per IP, stricter for image proxy) ────────────

const imageProxyLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 60, // 60 images per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  message: {
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many image requests, please try again later',
      status: 429,
    },
  },
});

// ─── GET /api/v1/images/proxy/:listingId/:filename ──────────────

router.get(
  '/:listingId/:filename',
  imageProxyLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const listingId = req.params.listingId as string;
      const filename = req.params.filename as string;

      // Validate params — prevent path traversal
      if (
        !listingId ||
        !filename ||
        listingId.includes('..') ||
        listingId.includes('/') ||
        filename.includes('..') ||
        filename.includes('/')
      ) {
        throw new AppError('INVALID_REQUEST', 'Invalid image path', 400);
      }

      // Determine if thumbnail is requested
      const size = req.query.size as string | undefined;
      let targetFilename = filename;

      if (size === 'thumb') {
        // Convert "image.jpg" → "image_thumb.jpg"
        const fileExt = path.extname(filename);
        const base = path.basename(filename, fileExt);
        targetFilename = `${base}_thumb${fileExt}`;
      }

      // Verify the filename starts with the listing ID (prevents cross-listing access)
      if (!targetFilename.startsWith(listingId + '_')) {
        throw new AppError('FORBIDDEN', 'Image does not belong to this listing', 403);
      }

      const filePath = path.join(UPLOADS_DIR, targetFilename);

      // Check file exists
      if (!fs.existsSync(filePath)) {
        throw new AppError('IMAGE_NOT_FOUND', 'Image not found', 404);
      }

      // Determine content type from extension
      const ext = path.extname(targetFilename).toLowerCase();
      const contentType = MIME_TYPES[ext];
      if (!contentType) {
        throw new AppError('INVALID_FILE_TYPE', 'Unsupported image format', 400);
      }

      // Set secure headers
      res.set({
        'Content-Type': contentType,
        'Content-Security-Policy': "default-src 'none'; img-src 'self'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=86400',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
      });

      // Stream the file
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      stream.on('error', (err) => {
        logger.error('Image stream error', { listingId, filename: targetFilename, error: err.message });
        if (!res.headersSent) {
          next(new AppError('STREAM_ERROR', 'Failed to serve image', 500));
        }
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
