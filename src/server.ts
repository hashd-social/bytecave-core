/**
 * HASHD Vault - Main Server
 * 
 * Decentralized storage node for HASHD protocol
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, validateConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { storageService } from './services/storage.service.js';
import { banlistService } from './services/banlist.service.js';
import { replicationService } from './services/replication.service.js';
import { proofService } from './services/proof.service.js';
import { requestLogger } from './middleware/logging.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { storeHandler } from './routes/store.route.js';
import { blobHandler } from './routes/blob.route.js';
import { replicateHandler } from './routes/replicate.route.js';
import { healthHandler } from './routes/health.route.js';
import { listHandler } from './routes/list.route.js';
import { statusHandler } from './routes/status.route.js';
import { proofGenerateHandler, proofListHandler, proofStatsHandler } from './routes/proof.route.js';

const app = express();

/**
 * Middleware
 */

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // In development, allow all localhost origins
    if (config.nodeEnv !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }

    // Check against configured origins
    if (config.corsOrigin.includes(origin) || config.corsOrigin.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  exposedHeaders: ['Content-Type']
}));

// Body parsing
app.use(express.json({ limit: `${config.maxBlobSizeMB}mb` }));

// Pretty print JSON responses
app.set('json spaces', 2);

// Request logging
app.use(requestLogger);

// Disable x-powered-by header
app.disable('x-powered-by');

/**
 * Routes
 */

app.post('/store', storeHandler);
app.get('/blob/:cid', blobHandler);
app.get('/blobs', listHandler);
app.post('/replicate', replicateHandler);
app.get('/health', healthHandler);
app.get('/status', statusHandler);

// Proof endpoints (Requirement 4)
app.post('/proofs/generate', proofGenerateHandler);
app.get('/proofs/:cid', proofListHandler);
app.get('/proofs', proofStatsHandler);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    service: 'HASHD Vault',
    version: '1.0.0',
    status: 'online',
    endpoints: {
      store: 'POST /store',
      retrieve: 'GET /blob/:cid',
      list: 'GET /blobs',
      replicate: 'POST /replicate',
      health: 'GET /health',
      status: 'GET /status',
      proofGenerate: 'POST /proofs/generate',
      proofList: 'GET /proofs/:cid',
      proofStats: 'GET /proofs'
    }
  });
});

/**
 * Error handling
 */

app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Server initialization
 */

async function initialize(): Promise<void> {
  try {
    logger.info('Initializing HASHD Vault...');

    // Validate configuration
    validateConfig();
    logger.info('Configuration validated');

    // Initialize services
    await storageService.initialize();
    await banlistService.initialize();
    await replicationService.initialize();
    await proofService.initialize();

    logger.info('Services initialized');
  } catch (error) {
    logger.error('Initialization failed', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */

function setupGracefulShutdown(server: any): void {
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
      logger.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Start server
 */

async function start(): Promise<void> {
  try {
    await initialize();

    const server = app.listen(config.port, () => {
      logger.info('🚀 HASHD Vault v1.0.0');
      logger.info(`   Environment: ${config.nodeEnv}`);
      logger.info(`   Port: ${config.port}`);
      logger.info(`   Node URL: ${config.nodeUrl}`);
      logger.info(`   Data directory: ${config.dataDir}`);
      logger.info(`   Max blob size: ${config.maxBlobSizeMB}MB`);
      logger.info(`   Max storage: ${config.maxStorageGB}GB`);
      logger.info(`   Replication: ${config.replicationEnabled ? 'enabled' : 'disabled'}`);
      logger.info(`   Banlist: ${config.enableBanlist ? 'enabled' : 'disabled'}`);
      logger.info('✅ Server ready for requests');
    });

    setupGracefulShutdown(server);
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server
start();
