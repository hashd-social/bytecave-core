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
import { replicationManager } from './services/replication-manager.service.js';
import { proofService } from './services/proof.service.js';
import { reputationService } from './services/reputation.service.js';
import { gcService } from './services/gc.service.js';
import { feedService } from './services/feed.service.js';
import { requestLogger } from './middleware/logging.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { storeHandler } from './routes/store.route.js';
import { blobHandler } from './routes/blob.route.js';
import { replicateHandler } from './routes/replicate.route.js';
import { healthHandler } from './routes/health.route.js';
import { listHandler } from './routes/list.route.js';
import { statusHandler } from './routes/status.route.js';
import { proofGenerateHandler, proofListHandler, proofStatsHandler } from './routes/proof.route.js';
import { 
  reputationScoreHandler, 
  reputationSnapshotHandler, 
  reputationReportHandler, 
  nodeReputationHandler,
  reputationStatsHandler,
  allScoresHandler
} from './routes/reputation.route.js';
import {
  replicationStatusHandler,
  allReplicationStatesHandler,
  replicationStatsHandler
} from './routes/replication-status.route.js';
import { shardsHandler } from './routes/shards.route.js';
import { validateShardAssignment, validateShardForProof } from './middleware/shard-validation.middleware.js';
import { gcStatusHandler, triggerGCHandler } from './routes/gc.route.js';
import { 
  pinBlobHandler, 
  unpinBlobHandler, 
  listPinnedBlobsHandler, 
  bulkPinHandler,
  blobStatusHandler
} from './routes/pin.route.js';
import {
  getFeedHandler,
  getFeedBlobsHandler,
  createFeedHandler,
  addFeedEntryHandler,
  validateFeedHandler,
  resolveFeedForksHandler
} from './routes/feed.route.js';
import { nodeInfoHandler } from './routes/node-info.route.js';
import { contractIntegrationService } from './services/contract-integration.service.js';
import { ethers } from 'ethers';

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

// Storage endpoints with shard validation (R7.5)
app.post('/store', validateShardAssignment, storeHandler);
app.post('/replicate', validateShardAssignment, replicateHandler);

app.get('/blob/:cid', blobHandler);
app.get('/blobs', listHandler);
app.get('/health', healthHandler);
app.get('/status', statusHandler);

// Proof endpoints with shard validation (Requirement 4, R7.8)
app.post('/proofs/generate', validateShardForProof, proofGenerateHandler);
app.get('/proofs/:cid', proofListHandler);
app.get('/proofs', proofStatsHandler);

// Reputation endpoints (Requirement 5)
app.get('/reputation/score', reputationScoreHandler);
app.get('/reputation/snapshot', reputationSnapshotHandler);
app.post('/reputation/report', reputationReportHandler);
app.get('/reputation/stats', reputationStatsHandler);
app.get('/reputation/scores', allScoresHandler);
app.get('/node/reputation', nodeReputationHandler);

// Replication status endpoints (Requirement 6)
app.get('/replication/:cid', replicationStatusHandler);
app.get('/replication', allReplicationStatesHandler);
app.get('/replication-stats', replicationStatsHandler);

// Shard discovery endpoint (Requirement 7)
app.get('/shards', shardsHandler);

// Garbage collection endpoints (Requirement 8)
app.get('/gc/status', gcStatusHandler);
app.post('/admin/gc', triggerGCHandler);

// Pinning endpoints (Requirement 9)
app.post('/pin/:cid', pinBlobHandler);
app.delete('/pin/:cid', unpinBlobHandler);
app.get('/pin/list', listPinnedBlobsHandler);
app.post('/pin/bulk', bulkPinHandler);
app.get('/blobs/:cid/status', blobStatusHandler);

// Feed endpoints (Requirement 10)
app.get('/feed/:feedId', getFeedHandler);
app.get('/feed/:feedId/blobs', getFeedBlobsHandler);
app.post('/feed', createFeedHandler);
app.post('/feed/:feedId/entry', addFeedEntryHandler);
app.get('/feed/:feedId/validate', validateFeedHandler);
app.get('/feed/:feedId/forks', resolveFeedForksHandler);

// Node discovery endpoint (Requirement 11)
app.get('/node/info', nodeInfoHandler);

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
    await replicationManager.initialize();
    await proofService.initialize();
    await reputationService.initialize();
    await gcService.initialize();
    await feedService.initialize();

    logger.info('Services initialized');

    // Initialize contract integration and auto-register (Requirement 3)
    await initializeContractIntegration();
  } catch (error) {
    logger.error('Initialization failed', error);
    process.exit(1);
  }
}

/**
 * Initialize contract integration and register node on-chain
 */
async function initializeContractIntegration(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  const registryAddress = process.env.VAULT_REGISTRY_ADDRESS;

  // Skip if not configured
  if (!rpcUrl || !privateKey || !registryAddress) {
    logger.info('Contract integration not configured, skipping on-chain registration');
    return;
  }

  try {
    logger.info('Initializing contract integration...');
    
    await contractIntegrationService.initialize({
      rpcUrl,
      privateKey,
      registryAddress,
      incentivesAddress: process.env.VAULT_INCENTIVES_ADDRESS
    });

    const signerAddress = await contractIntegrationService.getSignerAddress();
    logger.info(`Contract signer: ${signerAddress}`);

    // Check if already registered
    const existingNodeId = await contractIntegrationService.getNode(
      ethers.keccak256(ethers.toUtf8Bytes(config.nodeId))
    );

    if (existingNodeId && existingNodeId.active) {
      logger.info(`Node already registered: ${existingNodeId.nodeId}`);
      return;
    }

    // Generate node public key (deterministic from node ID)
    const nodeKeyHash = ethers.keccak256(ethers.toUtf8Bytes(config.nodeId));
    const publicKey = nodeKeyHash; // Using hash as public key for now

    // Create metadata
    const metadata = {
      name: config.nodeId,
      version: '1.0.0',
      url: config.nodeUrl,
      capabilities: ['storage', 'replication', 'consensus'],
      shards: config.nodeShards,
      timestamp: Date.now()
    };
    const metadataHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(metadata))
    );

    // Register node on-chain
    logger.info('Registering node on-chain...');
    const nodeId = await contractIntegrationService.registerNode(
      publicKey,
      config.nodeUrl,
      metadataHash
    );

    if (nodeId) {
      logger.info(`✅ Node registered on-chain: ${nodeId}`);
      logger.info(`   Public Key: ${publicKey}`);
      logger.info(`   URL: ${config.nodeUrl}`);
    } else {
      logger.warn('Node registration returned no ID');
    }
  } catch (error: any) {
    // Don't fail startup if registration fails
    logger.warn('Contract integration failed (node will run without on-chain registration)', error.message);
  }
}

/**
 * Graceful shutdown
 */

function setupGracefulShutdown(server: any): void {
  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Stop GC service
    gcService.stop();

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
