/**
 * HASHD Vault - Error Handling Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { VaultError } from '../types/index.js';

export function errorHandler(
  error: Error | VaultError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error('Request error', error, {
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  if (error instanceof VaultError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
      details: error.details,
      timestamp: Date.now()
    });
    return;
  }

  // Unknown error
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    timestamp: Date.now()
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `${req.method} ${req.path} is not a valid endpoint`,
    timestamp: Date.now()
  });
}
