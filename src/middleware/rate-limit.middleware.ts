/**
 * HASHD Vault - Rate Limiting Middleware
 * 
 * Protects against DOS attacks by limiting request rates per IP.
 * Different limits for different endpoint types.
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

const rateLimitMessage = {
  error: 'RATE_LIMITED',
  message: 'Too many requests, please try again later',
  retryAfter: 60
};

/**
 * General API rate limiter - applies to most endpoints
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
  skip: () => config.nodeEnv === 'test'
});

/**
 * Monitoring endpoint rate limiter - very permissive for health/status checks
 * Skip rate limiting for localhost in development
 */
export const monitoringLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000, // Allow 1000 requests per minute for monitoring
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
  skip: (req) => {
    // Skip rate limiting for localhost in development/test
    const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
    return config.nodeEnv === 'test' || (config.nodeEnv === 'development' && isLocalhost);
  }
});

/**
 * Storage endpoint rate limiter - more restrictive for uploads
 */
export const storageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ...rateLimitMessage, message: 'Too many upload requests' },
  skip: () => config.nodeEnv === 'test'
});

/**
 * Proof generation rate limiter - prevents proof DOS attacks
 */
export const proofLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ...rateLimitMessage, message: 'Too many proof requests' },
  skip: () => config.nodeEnv === 'test'
});

/**
 * Replication endpoint rate limiter - for node-to-node requests
 */
export const replicationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ...rateLimitMessage, message: 'Too many replication requests' },
  skip: () => config.nodeEnv === 'test'
});

/**
 * Admin endpoint rate limiter - very restrictive
 */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ...rateLimitMessage, message: 'Too many admin requests' },
  skip: () => config.nodeEnv === 'test'
});

/**
 * Read endpoint rate limiter - higher limits for reads
 */
export const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ...rateLimitMessage, message: 'Too many read requests' },
  skip: () => config.nodeEnv === 'test'
});
