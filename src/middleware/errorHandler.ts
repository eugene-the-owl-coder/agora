import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';
import { config } from '../config';

export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public status: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Always log full error internally
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    name: err.name,
  });

  // ── AppError (our structured errors) ─────────────────────────
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
      },
    });
    return;
  }

  // ── Zod Validation Error ─────────────────────────────────────
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        status: 400,
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  // ── Prisma Known Errors ──────────────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        // Unique constraint violation
        const target = (err.meta?.target as string[])?.join(', ') || 'field';
        res.status(409).json({
          error: {
            code: 'DUPLICATE_ENTRY',
            message: `A record with this ${target} already exists`,
            status: 409,
          },
        });
        return;
      }
      case 'P2025': {
        // Record not found (update/delete on missing record)
        res.status(404).json({
          error: {
            code: 'RECORD_NOT_FOUND',
            message: 'The requested record was not found',
            status: 404,
          },
        });
        return;
      }
      case 'P2003': {
        // Foreign key constraint violation
        res.status(400).json({
          error: {
            code: 'INVALID_REFERENCE',
            message: 'Referenced record does not exist',
            status: 400,
          },
        });
        return;
      }
      default: {
        // Other Prisma errors — don't expose internal details
        res.status(500).json({
          error: {
            code: 'DATABASE_ERROR',
            message: 'A database error occurred. Please try again.',
            status: 500,
          },
        });
        return;
      }
    }
  }

  // ── Prisma Validation Error ──────────────────────────────────
  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({
      error: {
        code: 'INVALID_DATA',
        message: 'Invalid data provided for this operation',
        status: 400,
      },
    });
    return;
  }

  // ── SyntaxError from JSON parsing ────────────────────────────
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains invalid JSON',
        status: 400,
      },
    });
    return;
  }

  // ── Generic fallback — no stack traces in production ─────────
  const isProduction = config.nodeEnv === 'production';
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction
        ? 'An unexpected error occurred'
        : `Internal error: ${err.message}`,
      status: 500,
    },
  });
}
