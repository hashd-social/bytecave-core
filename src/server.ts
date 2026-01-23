/**
 * ByteCave - Main Server
 * 
 * Decentralized storage node for HASHD protocol
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, validateConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { storageService } from './services/storage.service.js';
import { blockedContentService } from './services/blocked-content.service.js';
import { replicationService } from './services/replication.service.js';
import { replicationManager } from './services/replication-manager.service.js';
import { proofService } from './services/proof.service.js';
import { reputationService } from './services/reputation.service.js';
import { gcService } from './services/gc.service.js';
import { feedService } from './services/feed.service.js';
import { appRegistryCleanupService } from './services/app-registry-cleanup.service.js';
import { versionCheckService } from './services/version-check.service.js';
import { requestLogger } from './middleware/logging.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { blobHandler } from './routes/blob.route.js';
// REMOVED: store.route.js and replicate.route.js - legacy HTTP endpoints
// Storage now only via P2P protocols (/bytecave/store/1.0.0 and /bytecave/replicate/1.0.0)
import { healthHandler } from './routes/health.route.js';
import { listHandler } from './routes/list.route.js';
import { statusHandler } from './routes/status.route.js';
import { sendBroadcast, getBroadcasts } from './routes/broadcast.route.js';
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
import { validateShardForProof } from './middleware/shard-validation.middleware.js';
import { gcStatusHandler, triggerGCHandler, forcePurgeHandler, deleteBlobHandler } from './routes/gc.route.js';
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
import { networkStatsHandler } from './routes/network-stats.route.js';
import { getPeers, signRegistration } from './routes/health.route.js';
import { connectPeerHandler } from './routes/peer-connect.route.js';
import { contractIntegrationService } from './services/contract-integration.service.js';
import { ethers } from 'ethers';
import {
  generalLimiter,
  monitoringLimiter,
  storageLimiter,
  proofLimiter,
  readLimiter,
  adminLimiter
} from './middleware/rate-limit.middleware.js';
import {
  tlsEnforcementMiddleware,
  checkProductionSecurity,
  requestTimeoutMiddleware
} from './middleware/security.middleware.js';
import { storageAuthorizationService } from './services/storage-authorization.service.js';
import { p2pService } from './services/p2p.service.js';

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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  exposedHeaders: ['Content-Type']
}));

// Body parsing
app.use(express.json({ limit: `${config.maxBlobSizeMB}mb` }));

// Pretty print JSON responses
app.set('json spaces', 2);

// Request logging
app.use(requestLogger);

// Security middleware
app.use(tlsEnforcementMiddleware);
app.use(requestTimeoutMiddleware(30000)); // 30 second timeout

// Disable x-powered-by header
app.disable('x-powered-by');

/**
 * Routes with Rate Limiting
 */

// REMOVED: /store and /replicate HTTP endpoints - legacy, insecure
// Storage now only via P2P protocols:
// - /bytecave/store/1.0.0 (browser → node with authorization)
// - /bytecave/replicate/1.0.0 (node → node with peer verification)

// Read endpoints
app.get('/blob/:cid', readLimiter, blobHandler);
app.get('/blobs', readLimiter, listHandler);
app.get('/health', monitoringLimiter, healthHandler);
app.get('/peers', monitoringLimiter, getPeers);
app.post('/peers/connect', generalLimiter, connectPeerHandler);
app.post('/sign-registration', generalLimiter, signRegistration);
app.get('/status', monitoringLimiter, statusHandler);

// Broadcast endpoints
app.post('/broadcast', generalLimiter, sendBroadcast);
app.get('/broadcasts', monitoringLimiter, getBroadcasts);

// Proof endpoints with shard validation (Requirement 4, R7.8)
app.post('/proofs/generate', proofLimiter, validateShardForProof, proofGenerateHandler);
app.get('/proofs/:cid', readLimiter, proofListHandler);
app.get('/proofs', readLimiter, proofStatsHandler);

// Reputation endpoints (Requirement 5)
app.get('/reputation/score', readLimiter, reputationScoreHandler);
app.get('/reputation/snapshot', readLimiter, reputationSnapshotHandler);
app.post('/reputation/report', generalLimiter, reputationReportHandler);
app.get('/reputation/stats', readLimiter, reputationStatsHandler);
app.get('/reputation/scores', readLimiter, allScoresHandler);
app.get('/node/reputation', readLimiter, nodeReputationHandler);

// Replication status endpoints (Requirement 6)
app.get('/replication/:cid', readLimiter, replicationStatusHandler);
app.get('/replication', readLimiter, allReplicationStatesHandler);
app.get('/replication-stats', readLimiter, replicationStatsHandler);

// Shard discovery endpoint (Requirement 7)
app.get('/shards', readLimiter, shardsHandler);

// Garbage collection endpoints (Requirement 8)
app.get('/gc/status', readLimiter, gcStatusHandler);
app.post('/admin/gc', adminLimiter, triggerGCHandler);
app.delete('/admin/blob/:cid', adminLimiter, deleteBlobHandler);

// DEV ONLY - Force purge endpoint (bypasses all safety checks)
// Only available in development/test environments
if (config.nodeEnv === 'development' || config.nodeEnv === 'test') {
  app.post('/admin/force-purge', adminLimiter, forcePurgeHandler);
  logger.warn('⚠️ Force purge endpoint enabled (DEV/TEST MODE ONLY)');
}

// Pinning endpoints (Requirement 9)
app.post('/pin/:cid', generalLimiter, pinBlobHandler);
app.delete('/pin/:cid', generalLimiter, unpinBlobHandler);
app.get('/pin/list', readLimiter, listPinnedBlobsHandler);
app.post('/pin/bulk', generalLimiter, bulkPinHandler);
app.get('/blobs/:cid/status', readLimiter, blobStatusHandler);

// Feed endpoints (Requirement 10)
app.get('/feed/:feedId', readLimiter, getFeedHandler);
app.get('/feed/:feedId/blobs', readLimiter, getFeedBlobsHandler);
app.post('/feed', storageLimiter, createFeedHandler);
app.post('/feed/:feedId/entry', storageLimiter, addFeedEntryHandler);
app.get('/feed/:feedId/validate', readLimiter, validateFeedHandler);
app.get('/feed/:feedId/forks', readLimiter, resolveFeedForksHandler);

// Node discovery endpoint (Requirement 11)
app.get('/node/info', readLimiter, nodeInfoHandler);

// Network stats endpoint (for frontend node selection)
app.get('/network/stats', readLimiter, networkStatsHandler);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    service: 'ByteCave',
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
    logger.info('Initializing ByteCave...');

    // Validate configuration
    validateConfig();
    logger.info('Configuration validated');

    // Run production security checks
    checkProductionSecurity();

    // Initialize contract integration first (needed for peer discovery)
    await initializeContractIntegration();

    // Initialize storage authorization service
    await initializeStorageAuthorization();

    // Initialize services
    await storageService.initialize();
    await blockedContentService.initialize();
    await replicationService.initialize();
    await replicationManager.initialize();
    await proofService.initialize();
    await reputationService.initialize();
    await gcService.initialize();
    await feedService.initialize();
    await versionCheckService.start();
    
    // Initialize app registry cleanup service
    await appRegistryCleanupService.initialize();
    
    // Check for unauthorized blobs on startup
    await appRegistryCleanupService.checkAndCleanup();
    
    // Schedule periodic cleanup checks (every 5 minutes)
    setInterval(async () => {
      try {
        await appRegistryCleanupService.checkAndCleanup();
      } catch (error: any) {
        logger.error('Failed to check app registry cleanup', { error: error.message });
      }
    }, 5 * 60 * 1000);

    // Initialize P2P service
    await initializeP2P();

    // Note: Nodes do not auto-register. Registration is done manually via dashboard.
    // Contract integration is initialized in read-only mode for verification only.

    logger.info('Services initialized');
  } catch (error) {
    logger.error('Initialization failed', error);
    process.exit(1);
  }
}

/**
 * Initialize P2P discovery service
 */
async function initializeP2P(): Promise<void> {
  if (!config.p2pEnabled) {
    logger.info('P2P discovery disabled');
    return;
  }

  try {
    await p2pService.start();

    const peerId = p2pService.getPeerId();
    const addrs = p2pService.getMultiaddrs();
    
    logger.info(`P2P node started: ${peerId}`);
    logger.info(`P2P addresses: ${addrs.join(', ')}`);

    // Check if node was deregistered and trigger cleanup if needed
    await checkDeregistrationOnStartup(peerId);

    // Wait for peers to connect, then replicate existing blobs
    setTimeout(async () => {
      try {
        logger.info('Triggering replication of existing blobs after peer connection delay');
        await replicationService.replicateExistingBlobs();
      } catch (error: any) {
        logger.warn('Failed to replicate existing blobs on startup', { error: error.message });
      }
    }, 15000); // Wait 15 seconds for peers to connect
  } catch (error) {
    logger.error('Failed to start P2P service', error);
    // Don't fail startup - P2P is optional, HTTP still works
    logger.warn('Continuing without P2P discovery');
  }
}

/**
 * Check if node was deregistered and trigger cleanup
 */
async function checkDeregistrationOnStartup(peerId: string | null): Promise<void> {
  if (!peerId) {
    logger.debug('No peer ID available for deregistration check');
    return;
  }

  try {
    // Check if contract integration is initialized
    if (!contractIntegrationService.isInitialized()) {
      logger.debug('Contract integration not initialized, skipping deregistration check');
      return;
    }

    // Check if node is registered on-chain
    const nodeId = await contractIntegrationService.getNodeByPeerId(peerId);
    
    if (!nodeId) {
      // Node is not registered on-chain
      // Check if we have any stored blobs - if yes, this means node was deregistered
      const stats = await storageService.getStats();
      
      if (stats.blobCount > 0) {
        logger.warn('='.repeat(60));
        logger.warn('DEREGISTRATION DETECTED ON STARTUP');
        logger.warn(`Node has ${stats.blobCount} blobs but is not registered on-chain`);
        logger.warn('Triggering cleanup of all stored data');
        logger.warn('='.repeat(60));
        
        // Import and trigger cleanup
        const { performDeregistrationCleanup } = await import('./utils/deregistration-cleanup.js');
        await performDeregistrationCleanup();
      } else {
        logger.info('Node is not registered on-chain (no blobs stored, no cleanup needed)');
      }
    } else {
      logger.info('Node is registered on-chain', { nodeId: nodeId.slice(0, 16) + '...' });
    }
  } catch (error: any) {
    logger.warn('Failed to check deregistration status on startup', { error: error.message });
  }
}

/**
 * Initialize contract integration and register node on-chain
 */
async function initializeContractIntegration(): Promise<void> {
  const rpcUrl = config.rpcUrl;
  const privateKey = process.env.PRIVATE_KEY; // Private key not stored in config for security
  const registryAddress = config.registryAddress;

  // Skip if RPC or registry not configured
  if (!rpcUrl || !registryAddress) {
    logger.info('Contract integration not configured (missing rpcUrl or registryAddress in config)');
    return;
  }

  try {
    logger.info('Initializing contract integration...', {
      readOnly: !privateKey,
      rpcUrl,
      registryAddress
    });
    
    await contractIntegrationService.initialize({
      rpcUrl,
      privateKey, // Optional - if not provided, runs in read-only mode
      registryAddress,
      incentivesAddress: process.env.VAULT_INCENTIVES_ADDRESS,
      contentRegistryAddress: process.env.CONTENT_REGISTRY_ADDRESS
    });

    const signerAddress = await contractIntegrationService.getSignerAddress();
    
    if (!signerAddress) {
      logger.info('Contract integration initialized in read-only mode (no private key)');
      logger.info('Node can verify registrations but cannot self-register');
    } else {
      logger.info(`Contract signer: ${signerAddress}`);
      logger.info('Node registration will happen after P2P service starts');
    }
  } catch (error: any) {
    logger.warn('Contract integration failed', error.message);
  }
}

/**
 * Initialize storage authorization service for on-chain verification
 * Only needed when using application-specific authorization (not numerical sharding)
 */
async function initializeStorageAuthorization(): Promise<void> {
  // Storage authorization is always initialized
  // App filtering is controlled via allowedApps list

  const rpcUrl = config.rpcUrl;

  // Skip if not configured
  if (!rpcUrl) {
    logger.warn('Storage authorization not configured (RPC_URL required)');
    logger.warn('Storage requests will fail without authorization service');
    return;
  }

  try {
    logger.info('Initializing storage authorization service (application-specific authorization)...');
    
    await storageAuthorizationService.initialize(
      rpcUrl,
      process.env.MESSAGE_STORAGE_ADDRESS,
      process.env.POST_STORAGE_ADDRESS,
      process.env.CONTENT_REGISTRY_ADDRESS
    );

    logger.info('✅ Storage authorization service initialized');

    // Initialize AppRegistry if configured and allowedApps filter is enabled
    const hasAllowedAppsFilter = config.allowedApps && config.allowedApps.length > 0;
    if (hasAllowedAppsFilter && config.appRegistryAddress) {
      logger.info('Initializing AppRegistry service for app authorization...');
      const { appRegistryService } = await import('./services/app-registry.service.js');
      await appRegistryService.initialize(rpcUrl, config.appRegistryAddress);
      logger.info('✅ AppRegistry service initialized', { 
        contractAddress: config.appRegistryAddress,
        allowedApps: config.allowedApps 
      });
    } else if (hasAllowedAppsFilter && !config.appRegistryAddress) {
      logger.error('CRITICAL: allowedApps filter is configured but APP_REGISTRY_ADDRESS is not set');
      logger.error('Storage requests will be rejected without AppRegistry verification');
      throw new Error('APP_REGISTRY_ADDRESS required when allowedApps filter is configured');
    }
  } catch (error: any) {
    logger.error('Failed to initialize storage authorization service', error.message);
    throw error; // This is critical - fail startup if authorization can't be initialized
  }
}

/**
 * Graceful shutdown
 */

function setupGracefulShutdown(server: any): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Stop accepting new connections immediately
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Stop GC service
    gcService.stop();

    // Stop P2P service
    if (p2pService.isStarted()) {
      await p2pService.stop();
      logger.info('P2P service stopped');
    }

    // Destroy all active connections to free ports immediately
    server.closeAllConnections?.();
    
    logger.info('Shutdown complete');
    process.exit(0);
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

    // Generate node public key for display
    const nodePublicKey = ethers.keccak256(ethers.toUtf8Bytes(config.nodeId));

    const server = app.listen(config.port, () => {
      logger.info('🚀 ByteCave v1.0.0');
      logger.info(`   Environment: ${config.nodeEnv}`);
      logger.info(`   Node ID: ${config.nodeId}`);
      logger.info(`   HTTP API Port: ${config.port} (local access only)`);
      logger.info(`   Public Key: ${nodePublicKey}`);
      logger.info(`   Data directory: ${config.dataDir}`);
      logger.info(`   Max blob size: ${config.maxBlobSizeMB}MB`);
      logger.info(`   Max storage: ${config.maxStorageGB}GB`);
      logger.info(`   Replication: ${config.replicationEnabled ? 'enabled' : 'disabled'}`);
      logger.info(`   Blocked content: ${config.enableBlockedContent ? 'enabled' : 'disabled'}`);
      if (p2pService.isStarted()) {
        logger.info(`   P2P Peer ID: ${p2pService.getPeerId()}`);
      }
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
