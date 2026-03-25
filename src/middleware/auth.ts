import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { verifyApiKey } from '../utils/apiKey';
import { AppError } from './errorHandler';
import { logger } from '../utils/logger';


// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      agent?: {
        id: string;
        name: string;
        email: string;
        permissions: unknown;
        walletAddress: string | null;
      };
    }
  }
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Method 1: JWT Bearer token
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const payload = jwt.verify(token, config.jwt.secret) as { agentId: string };
        const agent = await prisma.agent.findUnique({ where: { id: payload.agentId } });
        if (!agent) {
          throw new AppError('AGENT_NOT_FOUND', 'Agent not found', 401);
        }
        req.agent = {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          permissions: agent.permissions,
          walletAddress: agent.walletAddress,
        };
        return next();
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError('INVALID_TOKEN', 'Invalid or expired JWT token', 401);
      }
    }

    // Method 2: API Key
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const prefix = apiKey.substring(0, 14);
      const agent = await prisma.agent.findFirst({ where: { apiKeyPrefix: prefix } });
      if (!agent) {
        throw new AppError('INVALID_API_KEY', 'Invalid API key', 401);
      }
      const valid = await verifyApiKey(apiKey, agent.apiKeyHash);
      if (!valid) {
        throw new AppError('INVALID_API_KEY', 'Invalid API key', 401);
      }
      req.agent = {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        permissions: agent.permissions,
        walletAddress: agent.walletAddress,
      };
      return next();
    }

    throw new AppError('AUTH_REQUIRED', 'Authentication required. Provide Bearer token or X-API-Key header.', 401);
  } catch (err) {
    next(err);
  }
}

export function requireScope(...scopes: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.agent) {
      return next(new AppError('AUTH_REQUIRED', 'Authentication required', 401));
    }

    const agentPermissions = Array.isArray(req.agent.permissions)
      ? (req.agent.permissions as string[])
      : [];

    // Admin has all permissions
    if (agentPermissions.includes('admin')) {
      return next();
    }

    const hasScope = scopes.every((s) => agentPermissions.includes(s));
    if (!hasScope) {
      return next(
        new AppError(
          'INSUFFICIENT_PERMISSIONS',
          `Required permissions: ${scopes.join(', ')}`,
          403,
        ),
      );
    }

    return next();
  };
}
