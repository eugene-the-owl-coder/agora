import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';

// ─── Constants ──────────────────────────────────────────────────

const MAX_DIMENSION = 2048;
const THUMBNAIL_WIDTH = 400;
const JPEG_QUALITY = 85;

/** Allowed MIME types mapped to magic-byte signatures */
const MAGIC_BYTES: Record<string, Buffer[]> = {
  'image/jpeg': [
    Buffer.from([0xff, 0xd8, 0xff]),
  ],
  'image/png': [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ],
  'image/webp': [
    // RIFF....WEBP — first 4 bytes are RIFF, bytes 8-11 are WEBP
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
  ],
};

// Disallowed signatures to explicitly reject
const BLOCKED_SIGNATURES: { name: string; bytes: Buffer }[] = [
  { name: 'SVG', bytes: Buffer.from('<svg') },
  { name: 'SVG', bytes: Buffer.from('<?xml') },
  { name: 'GIF', bytes: Buffer.from('GIF87a') },
  { name: 'GIF', bytes: Buffer.from('GIF89a') },
  { name: 'BMP', bytes: Buffer.from([0x42, 0x4d]) },
  { name: 'TIFF-LE', bytes: Buffer.from([0x49, 0x49, 0x2a, 0x00]) },
  { name: 'TIFF-BE', bytes: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]) },
];

// ─── Types ──────────────────────────────────────────────────────

export interface SanitizedImageResult {
  /** Path to the sanitized full-size image */
  sanitizedPath: string;
  /** Path to the thumbnail image */
  thumbnailPath: string;
  /** Filename of the sanitized image (for URL construction) */
  filename: string;
  /** Filename of the thumbnail */
  thumbnailFilename: string;
  /** Detected MIME type */
  mimeType: string;
  /** Width after processing */
  width: number;
  /** Height after processing */
  height: number;
  /** Thumbnail width */
  thumbWidth: number;
  /** Thumbnail height */
  thumbHeight: number;
}

// ─── Helpers ────────────────────────────────────────────────────

function detectMimeType(header: Buffer): string | null {
  // Check for blocked types first
  for (const sig of BLOCKED_SIGNATURES) {
    if (header.subarray(0, sig.bytes.length).equals(sig.bytes)) {
      return null; // Explicitly blocked
    }
  }

  // Check JPEG
  if (header.subarray(0, 3).equals(MAGIC_BYTES['image/jpeg'][0])) {
    return 'image/jpeg';
  }

  // Check PNG
  if (header.subarray(0, 8).equals(MAGIC_BYTES['image/png'][0])) {
    return 'image/png';
  }

  // Check WebP (RIFF header + WEBP at offset 8)
  if (
    header.subarray(0, 4).equals(MAGIC_BYTES['image/webp'][0]) &&
    header.length >= 12 &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    default: return '.bin';
  }
}

// ─── Main Sanitizer ─────────────────────────────────────────────

/**
 * Sanitize an uploaded image:
 * 1. Validate file type via magic bytes (reject SVG, GIF, BMP, TIFF)
 * 2. Strip ALL metadata (EXIF, IPTC, XMP)
 * 3. Re-encode the image (destroys embedded payloads)
 * 4. Resize if too large (max 2048px on longest side)
 * 5. Generate thumbnail (400px wide)
 * 6. Save sanitized + thumbnail to the output directory
 */
export async function sanitizeImage(
  inputPath: string,
  outputDir: string,
  listingId: string,
): Promise<SanitizedImageResult> {
  // ── Step 1: Read header and validate magic bytes ──────────
  const fd = fs.openSync(inputPath, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);

  const detectedMime = detectMimeType(header);
  if (!detectedMime) {
    throw new ImageSanitizationError(
      'INVALID_FILE_TYPE',
      'File type not allowed. Only JPEG, PNG, and WebP are accepted. SVG, GIF, BMP, and TIFF are rejected for security reasons.',
    );
  }

  // ── Step 2 & 3: Load, strip metadata, re-encode ──────────
  // sharp().rotate() auto-rotates per EXIF then strips EXIF.
  // We explicitly strip all metadata and re-encode.
  const inputBuffer = fs.readFileSync(inputPath);

  // Validate the buffer can actually be decoded as an image
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(inputBuffer).metadata();
  } catch {
    throw new ImageSanitizationError(
      'CORRUPT_IMAGE',
      'File could not be decoded as a valid image.',
    );
  }

  // Extra safety: verify sharp agrees on the format
  const sharpFormat = metadata.format;
  const allowedFormats = ['jpeg', 'png', 'webp'];
  if (!sharpFormat || !allowedFormats.includes(sharpFormat)) {
    throw new ImageSanitizationError(
      'INVALID_FILE_TYPE',
      `Detected format "${sharpFormat}" is not allowed. Only JPEG, PNG, and WebP are accepted.`,
    );
  }

  let width = metadata.width || 0;
  let height = metadata.height || 0;

  // ── Step 4: Resize if too large ───────────────────────────
  let pipeline = sharp(inputBuffer)
    .rotate() // Auto-rotate based on EXIF, then strips EXIF
    .withMetadata({ orientation: undefined }); // Ensure no metadata leaks

  // Actually strip ALL metadata by not passing withMetadata
  pipeline = sharp(inputBuffer).rotate();

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    pipeline = pipeline.resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // ── Re-encode based on detected format ────────────────────
  let sanitizedBuffer: Buffer;
  const ext = mimeToExtension(detectedMime);

  switch (detectedMime) {
    case 'image/jpeg':
      sanitizedBuffer = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
      break;
    case 'image/png':
      sanitizedBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      break;
    case 'image/webp':
      sanitizedBuffer = await pipeline.webp({ quality: JPEG_QUALITY }).toBuffer();
      break;
    default:
      throw new ImageSanitizationError('INVALID_FILE_TYPE', 'Unsupported format after detection.');
  }

  // Get final dimensions from the sanitized buffer
  const sanitizedMeta = await sharp(sanitizedBuffer).metadata();
  width = sanitizedMeta.width || width;
  height = sanitizedMeta.height || height;

  // ── Step 5: Generate thumbnail ────────────────────────────
  let thumbPipeline = sharp(sanitizedBuffer).resize({
    width: THUMBNAIL_WIDTH,
    withoutEnlargement: true,
  });

  let thumbnailBuffer: Buffer;
  switch (detectedMime) {
    case 'image/jpeg':
      thumbnailBuffer = await thumbPipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      break;
    case 'image/png':
      thumbnailBuffer = await thumbPipeline.png({ compressionLevel: 9 }).toBuffer();
      break;
    case 'image/webp':
      thumbnailBuffer = await thumbPipeline.webp({ quality: 80 }).toBuffer();
      break;
    default:
      thumbnailBuffer = await thumbPipeline.jpeg({ quality: 80 }).toBuffer();
      break;
  }

  const thumbMeta = await sharp(thumbnailBuffer).metadata();

  // ── Step 6: Save to disk ──────────────────────────────────
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  const filename = `${listingId}_${timestamp}_${random}${ext}`;
  const thumbnailFilename = `${listingId}_${timestamp}_${random}_thumb${ext}`;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const sanitizedPath = path.join(outputDir, filename);
  const thumbnailPath = path.join(outputDir, thumbnailFilename);

  fs.writeFileSync(sanitizedPath, sanitizedBuffer);
  fs.writeFileSync(thumbnailPath, thumbnailBuffer);

  logger.info('Image sanitized', {
    listingId,
    filename,
    mimeType: detectedMime,
    originalSize: inputBuffer.length,
    sanitizedSize: sanitizedBuffer.length,
    thumbnailSize: thumbnailBuffer.length,
    dimensions: `${width}x${height}`,
  });

  return {
    sanitizedPath,
    thumbnailPath,
    filename,
    thumbnailFilename,
    mimeType: detectedMime,
    width,
    height,
    thumbWidth: thumbMeta.width || THUMBNAIL_WIDTH,
    thumbHeight: thumbMeta.height || 0,
  };
}

// ─── Error Class ────────────────────────────────────────────────

export class ImageSanitizationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImageSanitizationError';
  }
}
