import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { logger } from '../utils/logger';
import { sanitizeImage, ImageSanitizationError } from '../services/imageSanitizer';
import { imageUploadRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// ─── Configuration ──────────────────────────────────────────────

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'listings');
const TEMP_DIR = path.join(os.tmpdir(), 'agora-uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Ensure directories exist
for (const dir of [UPLOADS_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Multer Configuration (temp storage) ────────────────────────
// Upload raw files to temp dir; they'll be sanitized before moving to final dir

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const random = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase() || mimeToExt(file.mimetype);
    cb(null, `raw_${timestamp}_${random}${ext}`);
  },
});

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    default: return '.bin';
  }
}

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('INVALID_FILE_TYPE', `Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP`, 400));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

// ─── Image Data Shape (stored in listing.images JSON array) ─────

export interface ListingImageData {
  url: string;
  thumbnailUrl: string;
  filename: string;
  thumbnailFilename: string;
  width: number;
  height: number;
  sanitized: boolean;
  uploadedAt: string;
}

// Helper to serialize BigInt fields
function serializeListing(listing: any) {
  return {
    ...listing,
    priceUsdc: listing.priceUsdc?.toString(),
    priceSol: listing.priceSol?.toString() || null,
  };
}

/** Safely delete a file, ignoring errors */
function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}

// ─── POST /api/v1/listings/:id/images — Upload images ──────────

router.post(
  '/:id/images',
  imageUploadRateLimiter,
  authenticate,
  requireScope('list'),
  (req: Request, res: Response, next: NextFunction) => {
    upload.array('images', MAX_FILES)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('FILE_TOO_LARGE', `File exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`, 400));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new AppError('TOO_MANY_FILES', `Maximum ${MAX_FILES} images per upload`, 400));
        }
        return next(new AppError('UPLOAD_ERROR', err.message, 400));
      }
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    const rawFiles: string[] = [];

    try {
      const { id } = uuidParamSchema.parse(req.params);
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        throw new AppError('NO_FILES', 'No image files provided. Use field name "images".', 400);
      }

      // Track raw files for cleanup
      files.forEach((f) => rawFiles.push(f.path));

      // Verify listing exists and belongs to the authenticated agent
      const listing = await prisma.listing.findUnique({ where: { id } });
      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }
      if (listing.agentId !== req.agent!.id) {
        throw new AppError('FORBIDDEN', 'You can only upload images to your own listings', 403);
      }

      // Check total image count (existing + new)
      const existingImages: ListingImageData[] = parseExistingImages(listing.images);
      if (existingImages.length + files.length > MAX_FILES) {
        throw new AppError(
          'TOO_MANY_IMAGES',
          `Maximum ${MAX_FILES} images per listing. Currently ${existingImages.length}, attempted to add ${files.length}.`,
          400,
        );
      }

      // ── Sanitize each uploaded file ───────────────────────────
      const newImages: ListingImageData[] = [];

      for (const file of files) {
        try {
          const result = await sanitizeImage(file.path, UPLOADS_DIR, id);

          newImages.push({
            url: `/api/v1/images/proxy/${id}/${result.filename}`,
            thumbnailUrl: `/api/v1/images/proxy/${id}/${result.filename}?size=thumb`,
            filename: result.filename,
            thumbnailFilename: result.thumbnailFilename,
            width: result.width,
            height: result.height,
            sanitized: true,
            uploadedAt: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof ImageSanitizationError) {
            throw new AppError(err.code, err.message, 400);
          }
          throw err;
        }
      }

      // Merge with existing images
      const allImages = [...existingImages, ...newImages];

      // Update listing with structured image data
      const updated = await prisma.listing.update({
        where: { id },
        data: { images: allImages as any },
        include: {
          agent: { select: { id: true, name: true, reputation: true } },
        },
      });

      logger.info('Images uploaded and sanitized', {
        listingId: id,
        count: newImages.length,
        agentId: req.agent!.id,
      });

      res.json({
        listing: serializeListing(updated),
        uploaded: newImages.map((img) => img.url),
      });
    } catch (err) {
      next(err);
    } finally {
      // Always clean up raw temp files
      rawFiles.forEach(safeUnlink);
    }
  },
);

// ─── DELETE /api/v1/listings/:id/images/:filename — Remove image ─

router.delete(
  '/:id/images/:filename',
  authenticate,
  requireScope('list'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const filename = req.params.filename as string;

      if (!filename || filename.includes('..') || filename.includes('/')) {
        throw new AppError('INVALID_FILENAME', 'Invalid filename', 400);
      }

      // Verify listing exists and belongs to authenticated agent
      const listing = await prisma.listing.findUnique({ where: { id } });
      if (!listing) {
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }
      if (listing.agentId !== req.agent!.id) {
        throw new AppError('FORBIDDEN', 'You can only delete images from your own listings', 403);
      }

      const existingImages: ListingImageData[] = parseExistingImages(listing.images);

      // Find the image by filename
      const imageIndex = existingImages.findIndex((img) => img.filename === filename);
      if (imageIndex === -1) {
        // Backwards compatibility: check for old-format URL strings
        const legacyUrl = `/uploads/listings/${filename}`;
        const legacyIndex = (listing.images as any[])?.findIndex((img: any) =>
          typeof img === 'string' && img === legacyUrl
        );
        if (legacyIndex === undefined || legacyIndex === -1) {
          throw new AppError('IMAGE_NOT_FOUND', 'Image not found on this listing', 404);
        }
        // Handle legacy removal
        const updatedImages = (listing.images as any[]).filter((_: any, i: number) => i !== legacyIndex);
        safeUnlink(path.join(UPLOADS_DIR, filename));
        const updated = await prisma.listing.update({
          where: { id },
          data: { images: updatedImages },
          include: { agent: { select: { id: true, name: true, reputation: true } } },
        });
        logger.info('Legacy image deleted', { listingId: id, filename, agentId: req.agent!.id });
        res.json({ listing: serializeListing(updated), deleted: filename });
        return;
      }

      const imageData = existingImages[imageIndex];

      // Remove files from disk (sanitized + thumbnail)
      safeUnlink(path.join(UPLOADS_DIR, imageData.filename));
      safeUnlink(path.join(UPLOADS_DIR, imageData.thumbnailFilename));

      // Remove from listing
      const updatedImages = existingImages.filter((_, i) => i !== imageIndex);
      const updated = await prisma.listing.update({
        where: { id },
        data: { images: updatedImages as any },
        include: {
          agent: { select: { id: true, name: true, reputation: true } },
        },
      });

      logger.info('Image deleted', { listingId: id, filename, agentId: req.agent!.id });

      res.json({
        listing: serializeListing(updated),
        deleted: filename,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse existing images from the listing, handling both old (string[])
 * and new (ListingImageData[]) formats.
 */
function parseExistingImages(images: unknown): ListingImageData[] {
  if (!images || !Array.isArray(images)) return [];

  return images
    .filter((img: any) => typeof img === 'object' && img !== null && img.url)
    .map((img: any) => img as ListingImageData);
}

export default router;
