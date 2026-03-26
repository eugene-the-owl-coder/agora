import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { authenticate, requireScope } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { uuidParamSchema } from '../validators/common';
import { logger } from '../utils/logger';

const router = Router();

// ─── Multer Configuration ───────────────────────────────────────

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'listings');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const listingId = req.params.id;
    const timestamp = Date.now();
    const random = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase() || mimeToExt(file.mimetype);
    cb(null, `${listingId}_${timestamp}_${random}${ext}`);
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

// Helper to serialize BigInt fields
function serializeListing(listing: any) {
  return {
    ...listing,
    priceUsdc: listing.priceUsdc?.toString(),
    priceSol: listing.priceSol?.toString() || null,
  };
}

// ─── POST /api/v1/listings/:id/images — Upload images ──────────

router.post(
  '/:id/images',
  authenticate,
  requireScope('list'),
  (req: Request, res: Response, next: NextFunction) => {
    // Run multer as middleware, handle its errors
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
    try {
      const { id } = uuidParamSchema.parse(req.params);
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        throw new AppError('NO_FILES', 'No image files provided. Use field name "images".', 400);
      }

      // Verify listing exists and belongs to the authenticated agent
      const listing = await prisma.listing.findUnique({ where: { id } });
      if (!listing) {
        // Clean up uploaded files
        files.forEach((f) => fs.unlinkSync(f.path));
        throw new AppError('LISTING_NOT_FOUND', 'Listing not found', 404);
      }
      if (listing.agentId !== req.agent!.id) {
        files.forEach((f) => fs.unlinkSync(f.path));
        throw new AppError('FORBIDDEN', 'You can only upload images to your own listings', 403);
      }

      // Check total image count (existing + new)
      const existingImages = listing.images || [];
      if (existingImages.length + files.length > MAX_FILES) {
        files.forEach((f) => fs.unlinkSync(f.path));
        throw new AppError(
          'TOO_MANY_IMAGES',
          `Maximum ${MAX_FILES} images per listing. Currently ${existingImages.length}, attempted to add ${files.length}.`,
          400,
        );
      }

      // Build URLs for new files
      const newImageUrls = files.map((f) => `/uploads/listings/${f.filename}`);
      const allImages = [...existingImages, ...newImageUrls];

      // Update listing
      const updated = await prisma.listing.update({
        where: { id },
        data: { images: allImages },
        include: {
          agent: { select: { id: true, name: true, reputation: true } },
        },
      });

      logger.info('Images uploaded', { listingId: id, count: files.length, agentId: req.agent!.id });

      res.json({
        listing: serializeListing(updated),
        uploaded: newImageUrls,
      });
    } catch (err) {
      next(err);
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

      const imageUrl = `/uploads/listings/${filename}`;
      const existingImages = listing.images || [];

      if (!existingImages.includes(imageUrl)) {
        throw new AppError('IMAGE_NOT_FOUND', 'Image not found on this listing', 404);
      }

      // Remove from disk
      const filePath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // Remove from listing
      const updatedImages = existingImages.filter((img) => img !== imageUrl);
      const updated = await prisma.listing.update({
        where: { id },
        data: { images: updatedImages },
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

export default router;
