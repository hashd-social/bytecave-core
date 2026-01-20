/**
 * ByteCave - Health Route
 * GET /health - Node health and metrics
 */

import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';
import { replicationService } from '../services/replication.service.js';
import { metricsService } from '../services/metrics.service.js';
import { p2pService } from '../services/p2p.service.js';
import { proofService } from '../services/proof.service.js';
import { versionCheckService } from '../services/version-check.service.js';
import { logger } from '../utils/logger.js';
import { verifyCID, verifyMetadataIntegrity } from '../utils/cid.js';
import { performDeregistrationCleanup } from '../utils/deregistration-cleanup.js';
import { HealthResponse, BlobMetadata } from '../types/index.js';

const VERSION = '1.0.0';

// Track registration state to detect deregistration
let wasRegisteredOnChain = false;

interface IntegrityCheck {
  checked: number;
  passed: number;
  failed: number;
  orphaned: number;  // Files without metadata (potential tampering)
  metadataTampered: number;  // Metadata with invalid integrity hash
  failedCids: string[];
}

/**
 * Check integrity of all stored blobs
 * Verifies that stored content matches its CID
 * Also detects orphaned files and metadata tampering
 */
async function checkBlobIntegrity(): Promise<IntegrityCheck> {
  const result: IntegrityCheck = {
    checked: 0,
    passed: 0,
    failed: 0,
    orphaned: 0,
    metadataTampered: 0,
    failedCids: []
  };

  try {
    const metaDir = path.join(config.dataDir, 'meta');
    const blobsDir = path.join(config.dataDir, 'blobs');
    
    // Read metadata files directly (bypassing integrity check in getMetadata)
    const metaFiles = await fs.readdir(metaDir);
    const blobFiles = await fs.readdir(blobsDir);
    
    // Count actual blob files
    const blobCids = new Set(
      blobFiles
        .filter(f => f.endsWith('.enc'))
        .map(f => f.replace('.enc', ''))
    );
    
    // Check each metadata file
    for (const file of metaFiles) {
      if (!file.endsWith('.json')) continue;
      
      const cid = file.replace('.json', '');
      result.checked++;
      
      try {
        // Read metadata directly without verification
        const metaPath = path.join(metaDir, file);
        const content = await fs.readFile(metaPath, 'utf-8');
        const metadata = JSON.parse(content) as BlobMetadata;
        
        // Check 1: Verify metadata integrity hash
        const integrityResult = verifyMetadataIntegrity(metadata);
        if (!integrityResult.valid) {
          result.metadataTampered++;
          result.failed++;
          result.failedCids.push(cid);
          logger.error('INTEGRITY_CHECK_FAILED: Metadata tampered', { cid, reason: integrityResult.reason });
          continue;
        }
        
        // Check 2: Verify blob file exists
        if (!blobCids.has(cid)) {
          result.failed++;
          result.failedCids.push(cid);
          logger.error('INTEGRITY_CHECK_FAILED: Blob file missing', { cid });
          continue;
        }
        
        // Check 3: Verify blob content matches CID
        const blobPath = path.join(blobsDir, `${cid}.enc`);
        const ciphertext = await fs.readFile(blobPath);
        if (!verifyCID(cid, ciphertext)) {
          result.failed++;
          result.failedCids.push(cid);
          logger.error('INTEGRITY_CHECK_FAILED: Blob content tampered', { cid });
          continue;
        }
        
        result.passed++;
      } catch (err: any) {
        result.failed++;
        result.failedCids.push(cid);
        logger.error('INTEGRITY_CHECK_FAILED: Error checking blob', { cid, error: err.message });
      }
    }
    
    // Detect orphaned blob files (blobs without metadata)
    const metaCids = new Set(
      metaFiles
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
    );
    
    for (const blobCid of blobCids) {
      if (!metaCids.has(blobCid)) {
        result.orphaned++;
        logger.error('INTEGRITY_CHECK_FAILED: Orphaned blob (no metadata)', { cid: blobCid });
      }
    }
  } catch (err) {
    logger.error('Integrity check error', err);
  }

  return result;
}

export async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await storageService.getStats();
    const metrics = metricsService.getMetrics();
    const uptime = metricsService.getUptime();
    const successRate = metricsService.getSuccessRate();
    const peerCount = replicationService.getEnabledPeerCount();

    // Run integrity check on stored blobs
    const integrityCheck = await checkBlobIntegrity();

    // Check version status
    const versionStatus = versionCheckService.getVersionStatus();
    
    // Determine health status
    let status: 'healthy' | 'degraded' | 'unhealthy' | 'outdated' = 'healthy';
    
    // Outdated takes precedence - any version mismatch shows as outdated
    if (versionStatus.outdated || versionStatus.outdatedWarning) {
      status = 'outdated';
    }
    // Unhealthy if integrity check fails, orphaned files, or metadata tampered
    else if (integrityCheck.failed > 0 || integrityCheck.orphaned > 0 || integrityCheck.metadataTampered > 0) {
      status = 'unhealthy';
    }
    // Degraded if success rate is below 90%
    else if (successRate < 0.9) {
      status = 'degraded';
    }
    
    // Unhealthy only if success rate is critically low
    if (successRate < 0.5 && status !== 'outdated') {
      status = 'unhealthy';
    }

    // Get public key for contract registration
    let publicKey: string | undefined;
    let registeredOnChain = false;
    let onChainNodeId: string | undefined;
    try {
      publicKey = proofService.getPublicKey();
      
      // Check if node is registered on-chain by peer ID (most accurate)
      const peerId = p2pService.isStarted() ? p2pService.getPeerId() : null;
      if (peerId) {
        const { contractIntegrationService } = await import('../services/contract-integration.service.js');
        if (contractIntegrationService.isInitialized()) {
          const nodeId = await contractIntegrationService.getNodeByPeerId(peerId);
          if (nodeId) {
            registeredOnChain = true;
            onChainNodeId = nodeId;
          }
          
          // Detect deregistration and trigger cleanup
          if (wasRegisteredOnChain && !registeredOnChain) {
            logger.warn('Node deregistration detected (was registered, now not) - triggering cleanup');
            // Trigger cleanup asynchronously (don't block health response)
            performDeregistrationCleanup().catch(err => 
              logger.error('Failed to perform deregistration cleanup', err)
            );
          }
          // Also check if node has blobs but is not registered (handles restart case)
          else if (!registeredOnChain && stats.blobCount > 0) {
            logger.warn('Node has blobs but is not registered on-chain - triggering cleanup');
            // Trigger cleanup asynchronously (don't block health response)
            performDeregistrationCleanup().catch(err => 
              logger.error('Failed to perform deregistration cleanup', err)
            );
          }
          
          // Update registration state
          wasRegisteredOnChain = registeredOnChain;
        }
      }
    } catch {
      // Keys not initialized yet or registration check failed
    }

    // Get multiaddrs for P2P connectivity
    let multiaddrs: string[] | undefined;
    if (p2pService.isStarted()) {
      multiaddrs = p2pService.getMultiaddrs();
    }

    // Get P2P connection details - actual connected peers
    const connectedPeers = p2pService.isStarted() ? p2pService.getConnectedPeers().length : 0;
    
    // Get registered node count from contract - this is the true replicating count
    let registeredNodeCount = 0;
    try {
      const { contractIntegrationService } = await import('../services/contract-integration.service.js');
      if (contractIntegrationService.isInitialized()) {
        const nodeCount = await contractIntegrationService.getNodeCount();
        registeredNodeCount = nodeCount.active;
      }
    } catch (error) {
      logger.debug('Failed to get node count from contract', error);
    }

    const response: HealthResponse = {
      status,
      uptime,
      storedBlobs: stats.blobCount,
      totalSize: stats.totalSize,
      latencyMs: metrics.avgLatency,
      version: VERSION,
      minVersion: status === 'outdated' ? versionStatus.minimum ?? undefined : undefined,
      nodeId: config.nodeId, // Add node ID for display in dashboard
      peers: peerCount, // Legacy: replication peers for backward compatibility
      p2p: {
        connected: connectedPeers,        // Total P2P connections
        registered: registeredNodeCount,  // Active registered nodes from contract
        relay: 0                          // TODO: Track relay connections
      },
      peerId: p2pService.isStarted() ? (p2pService.getPeerId() ?? undefined) : undefined,
      multiaddrs,
      publicKey,
      secp256k1PublicKey: p2pService.isStarted() ? (p2pService.getSecp256k1PublicKey() ?? undefined) : undefined,
      ownerAddress: process.env.OWNER_ADDRESS || undefined,
      registeredOnChain,
      onChainNodeId,
      lastReplication: 0, // TODO: Track last replication time
      metrics: {
        requestsLastHour: metrics.requestsLastHour,
        avgResponseTime: metrics.avgLatency,
        successRate
      },
      integrity: integrityCheck
    };

    res.json(response);
  } catch (error: any) {
    logger.error('Health check failed', error);

    res.status(503).json({
      status: 'unhealthy',
      error: 'Health check failed',
      message: error.message,
      timestamp: Date.now()
    });
  }
}

/**
 * GET /peers - Get list of CONNECTED peers only (real-time, no cache)
 * Used for network discovery from dashboard
 */
export async function getPeers(_req: Request, res: Response): Promise<void> {
  try {
    const knownPeers = p2pService.getKnownPeers();
    const connectedPeerIds = p2pService.getConnectedPeers();
    
    // Only return actually connected peers (real-time from libp2p)
    const peers = knownPeers
      .filter(peer => connectedPeerIds.includes(peer.peerId))
      .map(peer => ({
        peerId: peer.peerId,
        // contentTypes removed - nodes accept all content in shard range
        connected: true,
        lastSeen: peer.lastSeen,
        reputation: peer.reputation
      }));

    res.json({
      count: peers.length,
      peers
    });
  } catch (error: any) {
    logger.error('Failed to get peers', error);
    res.status(500).json({ error: 'Failed to get peers' });
  }
}

/**
 * POST /sign-registration
 * Generate a signature for node registration
 * Body: { ownerAddress: string }
 */
export async function signRegistration(req: Request, res: Response): Promise<void> {
  try {
    const { ownerAddress } = req.body;
    
    if (!ownerAddress) {
      res.status(400).json({ error: 'ownerAddress is required' });
      return;
    }

    // Get the public key to verify it matches
    const publicKey = p2pService.getSecp256k1PublicKey();
    
    // Sign the owner address with the node's secp256k1 private key
    const signature = await p2pService.signMessage(ownerAddress);
    
    if (!signature) {
      res.status(500).json({ error: 'Failed to generate signature - node may not have secp256k1 key' });
      return;
    }

    logger.info('Generated registration signature', {
      ownerAddress,
      publicKey: publicKey?.slice(0, 20) + '...',
      signature: signature.slice(0, 20) + '...'
    });

    res.json({
      signature,
      ownerAddress,
      publicKey // Include for debugging
    });
  } catch (error: any) {
    logger.error('Failed to sign registration', error);
    res.status(500).json({ error: 'Failed to sign registration' });
  }
}
