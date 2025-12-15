/**
 * HASHD Vault - Security Middleware
 * 
 * Production security checks including TLS enforcement.
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * TLS Enforcement Middleware
 * 
 * In production mode:
 * - Warns on startup if TLS is not detected
 * - Checks for X-Forwarded-Proto header (reverse proxy)
 * - Logs insecure requests
 * 
 * Note: TLS should be handled by reverse proxy (nginx/caddy) in production.
 * This middleware provides defense-in-depth logging.
 */
export function tlsEnforcementMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // Skip in non-production
  if (config.nodeEnv !== 'production') {
    return next();
  }

  // Check if request is secure
  const isSecure = 
    req.secure || // Direct HTTPS
    req.headers['x-forwarded-proto'] === 'https' || // Behind reverse proxy
    req.headers['x-forwarded-ssl'] === 'on';

  if (!isSecure) {
    // Log insecure request but don't block (reverse proxy may strip headers)
    logger.warn('Insecure request in production', {
      ip: req.ip,
      path: req.path,
      forwardedProto: req.headers['x-forwarded-proto']
    });
  }

  next();
}

/**
 * Production security startup check
 * Call this on server startup to warn about security issues
 */
export function checkProductionSecurity(): void {
  if (config.nodeEnv !== 'production') {
    return;
  }

  const warnings: string[] = [];

  // Check for TLS configuration hints
  if (!process.env.TLS_CERT && !process.env.HTTPS_PROXY) {
    warnings.push('No TLS certificate configured. Ensure a reverse proxy (nginx/caddy) handles TLS.');
  }

  // Check for secure CORS
  if (config.corsOrigin.includes('*')) {
    warnings.push('CORS allows all origins (*). Consider restricting in production.');
  }

  // Check for localhost in CORS
  const hasLocalhost = config.corsOrigin.some(o => 
    o.includes('localhost') || o.includes('127.0.0.1')
  );
  if (hasLocalhost) {
    warnings.push('CORS includes localhost origins. Remove for production.');
  }

  // Log warnings
  if (warnings.length > 0) {
    logger.warn('⚠️ Production Security Warnings:', { warnings });
    warnings.forEach(w => logger.warn(`  - ${w}`));
  } else {
    logger.info('✅ Production security checks passed');
  }
}

/**
 * Request timeout middleware
 * Prevents slow loris attacks
 */
export function requestTimeoutMiddleware(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setTimeout(timeoutMs, () => {
      logger.warn('Request timeout', {
        ip: req.ip,
        path: req.path,
        method: req.method
      });
      res.status(408).json({
        error: 'REQUEST_TIMEOUT',
        message: 'Request took too long to process'
      });
    });
    next();
  };
}
