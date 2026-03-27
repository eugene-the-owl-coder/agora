import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Basic Auth middleware for protecting UI pages.
 * - If SITE_PASSWORD is not set (empty), skips auth (open access for dev).
 * - If set, requires HTTP Basic Auth with username "admin" and the configured password.
 * - Only intended for static file routes, NOT API endpoints.
 */
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const password = config.sitePassword;

  // Skip auth for API routes, health checks, and install script
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/install.sh') {
    next();
    return;
  }

  // No password configured — allow open access
  if (!password) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Agora Marketplace"');
    res.status(401).send('Authentication required');
    return;
  }

  const encoded = authHeader.slice(6); // strip "Basic "
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  const [username, ...passwordParts] = decoded.split(':');
  const providedPassword = passwordParts.join(':'); // password may contain colons

  if (username === 'admin' && providedPassword === password) {
    next();
    return;
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Agora Marketplace"');
  res.status(401).send('Invalid credentials');
}
