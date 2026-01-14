/**
 * ByteCave Core - P2P Protocol Handlers
 * 
 * Implements libp2p stream protocols for pure P2P communication:
 * - /bytecave/replicate/1.0.0 - Blob replication between nodes
 * - /bytecave/blob/1.0.0 - Blob retrieval
 * - /bytecave/health/1.0.0 - Health status exchange
 * - /bytecave/info/1.0.0 - Node info (for registration)
 */

import { Libp2p } from 'libp2p';
import type { Stream, Connection } from '@libp2p/interface';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';
import { metricsService } from './metrics.service.js';
import { config } from '../config/index.js';

// Protocol identifiers
export const PROTOCOL_REPLICATE = '/bytecave/replicate/1.0.0';
export const PROTOCOL_STORE = '/bytecave/store/1.0.0'; // Browser-to-node storage with authorization
export const PROTOCOL_BLOB = '/bytecave/blob/1.0.0';
export const PROTOCOL_HEALTH = '/bytecave/health/1.0.0';
export const PROTOCOL_INFO = '/bytecave/info/1.0.0';
export const PROTOCOL_HAVE_LIST = '/bytecave/have-list/1.0.0';
export const PROTOCOL_HAVE_CID = '/bytecave/have-cid/1.0.0'; // Query if node has specific CID

// Message types for protocol communication (v2 - with application metadata)
interface ReplicateRequest {
  cid: string;
  mimeType: string;
  ciphertext: string; // base64 encoded
  appId?: string;
  contentType?: string;
  sender?: string;
  timestamp?: number;
  metadata?: Record<string, any>;
  authorization?: any; // For browser-to-node storage with signed authorization
}

interface ReplicateResponse {
  success: boolean;
  alreadyStored?: boolean;
  error?: string;
}

interface BlobRequest {
  cid: string;
}

interface BlobResponse {
  success: boolean;
  ciphertext?: string; // base64 encoded
  mimeType?: string;
  error?: string;
}

export interface P2PHealthResponse {
  peerId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'outdated';
  blobCount: number;
  storageUsed: number;
  storageMax: number;
  uptime: number;
  version: string;
  minVersion?: string;
  multiaddrs: string[];
  nodeId?: string;
  publicKey?: string;
  ownerAddress?: string;
  registeredOnChain?: boolean;
  onChainNodeId?: string;
  metrics?: {
    requestsLastHour: number;
    avgResponseTime: number;
    successRate: number;
  };
  integrity?: {
    checked: number;
    passed: number;
    failed: number;
    orphaned: number;
    metadataTampered: number;
    failedCids: string[];
  };
}

export interface P2PInfoResponse {
  peerId: string;
  publicKey: string;
  ownerAddress?: string;
  version: string;
}

interface HaveListRequest {
  cids?: string[]; // Specific CIDs to check (if provided, only check these)
  limit?: number; // Max number of CIDs to return (if cids not provided)
  offset?: number; // Pagination offset (if cids not provided)
}

interface HaveListResponse {
  cids: string[];
  total: number;
  hasMore: boolean;
}

class P2PProtocolsService {
  private node: Libp2p | null = null;
  private startTime = Date.now();

  /**
   * Register all protocol handlers on the libp2p node
   */
  registerProtocols(node: Libp2p): void {
    this.node = node;

    // Register protocol handlers - signature is (stream: Stream, connection: Connection)
    node.handle(PROTOCOL_REPLICATE, (stream: Stream, connection: Connection) => 
      this.handleReplicate(stream, connection));
    node.handle(PROTOCOL_STORE, (stream: Stream, connection: Connection) => 
      this.handleStore(stream, connection));
    node.handle(PROTOCOL_BLOB, (stream: Stream, connection: Connection) => 
      this.handleBlob(stream, connection));
    node.handle(PROTOCOL_HEALTH, (stream: Stream, connection: Connection) => 
      this.handleHealth(stream, connection));
    node.handle(PROTOCOL_INFO, (stream: Stream, connection: Connection) => 
      this.handleInfo(stream, connection));
    node.handle(PROTOCOL_HAVE_LIST, (stream: Stream, connection: Connection) => 
      this.handleHaveList(stream, connection));
    node.handle(PROTOCOL_HAVE_CID, (stream: Stream, connection: Connection) => 
      this.handleHaveCid(stream, connection));

    logger.info('P2P protocols registered', {
      protocols: [PROTOCOL_REPLICATE, PROTOCOL_STORE, PROTOCOL_BLOB, PROTOCOL_HEALTH, PROTOCOL_INFO, PROTOCOL_HAVE_LIST, PROTOCOL_HAVE_CID]
    });
  }

  /**
   * Unregister all protocol handlers
   */
  unregisterProtocols(): void {
    if (!this.node) return;

    this.node.unhandle(PROTOCOL_REPLICATE);
    this.node.unhandle(PROTOCOL_STORE);
    this.node.unhandle(PROTOCOL_BLOB);
    this.node.unhandle(PROTOCOL_HEALTH);
    this.node.unhandle(PROTOCOL_INFO);
    this.node.unhandle(PROTOCOL_HAVE_LIST);
    this.node.unhandle(PROTOCOL_HAVE_CID);

    logger.info('P2P protocols unregistered');
  }

  // ============================================
  // PROTOCOL HANDLERS (incoming requests)
  // ============================================

  /**
   * Handle incoming replicate request
   * SECURITY: Verifies peer authorization and on-chain CID existence before accepting replication.
   * This prevents malicious nodes (even modified official code) from injecting unauthorized blobs.
   */
  private async handleReplicate(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling replicate request', { from: remotePeer });

    try {
      // SECURITY CHECK 1: Verify peer is not blocked
      const { blockedContentService } = await import('./blocked-content.service.js');
      if (await blockedContentService.isPeerBlocked(remotePeer)) {
        logger.warn('Replication rejected: Peer is blocked', { peerId: remotePeer });
        await this.writeMessage(stream, { success: false, error: 'Peer blocked' });
        return;
      }

      // SECURITY CHECK 2: Verify peer is an authorized VaultNode (registered on-chain by peer ID)
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      
      if (contractIntegrationService.isInitialized()) {
        // Check if this peer ID is registered on-chain
        const nodeId = await contractIntegrationService.getNodeByPeerId(remotePeer);
        
        if (!nodeId) {
          logger.warn('Replication rejected: Peer not registered in VaultNodeRegistry', { 
            peerId: remotePeer.slice(0, 12) + '...'
          });
          await this.writeMessage(stream, { success: false, error: 'Peer not authorized' });
          return;
        }
        
        // Verify node is active
        const node = await contractIntegrationService.getNode(nodeId);
        if (!node || !node.active) {
          logger.warn('Replication rejected: Peer not active in VaultNodeRegistry', { 
            peerId: remotePeer.slice(0, 12) + '...',
            nodeId: nodeId.slice(0, 16) + '...'
          });
          await this.writeMessage(stream, { success: false, error: 'Peer not authorized' });
          return;
        }
        
        logger.debug('✅ Peer authorization verified via VaultNodeRegistry', { 
          peerId: remotePeer.slice(0, 12) + '...',
          nodeId: nodeId.slice(0, 16) + '...'
        });
      } else {
        logger.debug('Contract integration not initialized, skipping peer authorization check');
      }

      // Read the request
      const request = await this.readMessage<ReplicateRequest>(stream);
      
      if (!request || !request.cid || !request.ciphertext) {
        await this.writeMessage(stream, { success: false, error: 'Invalid request' });
        return;
      }

      // SECURITY CHECK 3: Verify CID is not blocked
      if (await blockedContentService.isBlocked(request.cid)) {
        logger.warn('Replication rejected: CID is blocked', { cid: request.cid, from: remotePeer });
        await this.writeMessage(stream, { success: false, error: 'Content blocked' });
        return;
      }

      // SECURITY CHECK 4: Verify CID matches ciphertext (cryptographic integrity)
      const ciphertext = Buffer.from(request.ciphertext, 'base64');
      const { verifyCID } = await import('../utils/cid.js');
      if (!verifyCID(request.cid, ciphertext)) {
        logger.warn('Replication rejected: CID mismatch - tampered content', { 
          cid: request.cid, 
          from: remotePeer 
        });
        await this.writeMessage(stream, { success: false, error: 'CID verification failed' });
        return;
      }

      // SECURITY CHECK 5: Verify app authorization when requireAppRegistry is enabled
      const { config } = await import('../config/index.js');
      const isMediaContent = request.contentType === 'media';
      const requireAppRegistry = config.requireAppRegistry;
      
      if (requireAppRegistry) {
        // Check if appId is provided and is in allowed apps list
        if (!request.appId) {
          logger.warn('Replication rejected: No appId provided', { 
            cid: request.cid, 
            from: remotePeer
          });
          await this.writeMessage(stream, { 
            success: false, 
            error: 'App ID required when app registry is enabled' 
          });
          return;
        }
        
        if (!config.allowedApps.includes(request.appId)) {
          logger.warn('Replication rejected: App not in allowed list', { 
            cid: request.cid, 
            appId: request.appId,
            allowedApps: config.allowedApps,
            from: remotePeer
          });
          await this.writeMessage(stream, { 
            success: false, 
            error: `App '${request.appId}' not authorized on this node` 
          });
          return;
        }
        
        logger.debug('App authorization verified for replication', { 
          cid: request.cid, 
          appId: request.appId 
        });
        
        // For non-media content: verify CID exists on-chain in authorized contracts
        if (!isMediaContent) {
          const { storageAuthorizationService } = await import('./storage-authorization.service.js');
          const onChainVerification = await storageAuthorizationService.verifyCIDOnChain(request.cid);
          
          if (!onChainVerification.authorized) {
            logger.warn('Replication rejected: CID not found on-chain', { 
              cid: request.cid, 
              from: remotePeer,
              error: onChainVerification.error
            });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'CID not authorized on-chain' 
            });
            return;
          }
        }
        
        // For media: verify sender was provided
        if (isMediaContent && !request.sender) {
          logger.warn('Replication rejected: Media content missing sender', { 
            cid: request.cid, 
            from: remotePeer
          });
          await this.writeMessage(stream, { 
            success: false, 
            error: 'Media content requires sender metadata' 
          });
          return;
        }
      }

      // Check if we already have this blob
      const exists = await storageService.hasBlob(request.cid);
      if (exists) {
        logger.debug('Blob already stored', { cid: request.cid });
        await this.writeMessage(stream, { success: true, alreadyStored: true });
        return;
      }

      // All security checks passed - store the blob with metadata
      // Mark as 'replicated' so this node doesn't re-replicate it
      await storageService.storeBlob(request.cid, ciphertext, request.mimeType, {
        appId: request.appId,
        contentType: request.contentType,
        sender: request.sender,
        timestamp: request.timestamp,
        metadata: request.metadata,
        fromPeer: remotePeer,
        replicationSource: 'replicated' // Mark as received via replication
      });

      logger.info('Blob replicated via P2P - all security checks passed', { 
        cid: request.cid, 
        from: remotePeer,
        contentType: request.contentType,
        sender: request.sender
      });
      await this.writeMessage(stream, { success: true });

    } catch (error: any) {
      logger.error('Replicate handler error', { error: error.message });
      try {
        await this.writeMessage(stream, { success: false, error: error.message });
      } catch {
        // Stream may be closed
      }
    }
  }

  /**
   * Handle incoming storage request from browser (with authorization)
   * This protocol accepts storage requests from browsers with signed authorization
   */
  private async handleStore(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    console.log('[P2P Store] Received store request from:', remotePeer.slice(0, 12));
    logger.debug('Handling store request from browser', { from: remotePeer });

    try {
      // Read the request
      const request = await this.readMessage<ReplicateRequest>(stream);
      
      console.log('[P2P Store] Request received:', {
        hasRequest: !!request,
        hasCid: !!request?.cid,
        cidValue: request?.cid,
        hasCiphertext: !!request?.ciphertext,
        ciphertextType: typeof request?.ciphertext,
        ciphertextLength: request?.ciphertext?.length,
        requestKeys: request ? Object.keys(request) : []
      });
      
      if (!request || !request.cid || !request.ciphertext) {
        console.log('[P2P Store] Invalid request - missing required fields');
        await this.writeMessage(stream, { success: false, error: 'Invalid request' });
        return;
      }

      // Check if this node is registered on-chain (only registered nodes accept storage)
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      
      if (contractIntegrationService.isInitialized()) {
        try {
          // Get this node's P2P public key (the one used for registration)
          const { p2pService } = await import('./p2p.service.js');
          
          if (!p2pService.isStarted()) {
            logger.warn('Store rejected: P2P service not started', { cid: request.cid });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not ready (P2P not started)' 
            });
            return;
          }

          // Get the P2P public key from the libp2p node
          const node = (p2pService as any).node;
          if (!node?.peerId?.publicKey) {
            logger.warn('Store rejected: No P2P public key available', { cid: request.cid });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not configured properly (no P2P public key)' 
            });
            return;
          }

          // Extract the raw secp256k1 public key bytes (same as registration)
          const publicKeyProto = (node.peerId.publicKey as any).raw;
          const protoBuffer = Buffer.from(publicKeyProto);
          
          // Extract the 33-byte key from the protobuf (skip 3-byte header for typical secp256k1)
          let keyBytes: Buffer | undefined;
          if (protoBuffer.length === 33) {
            keyBytes = protoBuffer;
          } else if (protoBuffer.length === 36) {
            keyBytes = protoBuffer.slice(3);
          } else {
            // Search for the key prefix
            for (let i = 0; i < protoBuffer.length - 33; i++) {
              if (protoBuffer[i] === 0x02 || protoBuffer[i] === 0x03) {
                keyBytes = protoBuffer.slice(i, i + 33);
                break;
              }
            }
            if (!keyBytes) {
              logger.warn('Store rejected: Could not extract public key', { cid: request.cid });
              await this.writeMessage(stream, { 
                success: false, 
                error: 'Node public key format error' 
              });
              return;
            }
          }

          // Calculate nodeId from public key (keccak256 hash - same as contract)
          const { ethers } = await import('ethers');
          const publicKey = '0x' + keyBytes.toString('hex');
          const nodeId = ethers.keccak256(publicKey);
          
          console.log('[P2P Store] Checking registration for nodeId:', nodeId.slice(0, 10) + '...');
          
          // Check if this nodeId is registered on-chain
          const registeredNode = await contractIntegrationService.getNode(nodeId);
          
          if (!registeredNode || !registeredNode.active) {
            logger.warn('Store rejected: Node not registered or not active on-chain', { 
              cid: request.cid, 
              nodeId: nodeId.slice(0, 10) + '...',
              hasNode: !!registeredNode,
              active: registeredNode?.active 
            });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not registered on-chain. Only registered nodes accept storage.' 
            });
            return;
          }

          logger.info('Node registration verified', { 
            nodeId: nodeId.slice(0, 10) + '...', 
            publicKey: publicKey.slice(0, 10) + '...',
            active: node.active 
          });
        } catch (error: any) {
          logger.warn('Store rejected: Could not verify node registration', { 
            cid: request.cid, 
            error: error.message 
          });
          await this.writeMessage(stream, { 
            success: false, 
            error: 'Could not verify node registration' 
          });
          return;
        }
      } else {
        // Contract integration not initialized - reject to be safe
        logger.warn('Store rejected: Contract integration not initialized', { cid: request.cid });
        await this.writeMessage(stream, { 
          success: false, 
          error: 'Node not configured for on-chain verification' 
        });
        return;
      }

      // Verify authorization only if using application-specific authorization (not numerical sharding)
      const { config } = await import('../config/index.js');
      if (config.requireAppRegistry) {
        if (request.authorization) {
          const { storageAuthorizationService } = await import('./storage-authorization.service.js');
          
          // Verify the authorization signature
          const result = await storageAuthorizationService.verifyAuthorization(
            request.authorization,
            request.authorization.contentHash
          );

          if (!result.authorized) {
            logger.warn('Store rejected: Invalid authorization signature', { 
              cid: request.cid,
              sender: request.authorization.sender,
              reason: result.error 
            });
            await this.writeMessage(stream, { success: false, error: result.error || 'Invalid authorization' });
            return;
          }

          logger.debug('Browser storage authorization verified', { 
            cid: request.cid, 
            sender: request.authorization.sender 
          });
        } else {
          // No authorization provided - reject
          logger.warn('Store rejected: No authorization provided', { cid: request.cid });
          await this.writeMessage(stream, { success: false, error: 'Authorization required' });
          return;
        }
      } else {
        // Using numerical sharding - skip authorization check
        logger.debug('Skipping authorization check (numerical sharding mode)', { cid: request.cid });
      }

      // Check if we already have this blob
      const exists = await storageService.hasBlob(request.cid);
      if (exists) {
        logger.debug('Blob already stored', { cid: request.cid });
        await this.writeMessage(stream, { success: true, alreadyStored: true });
        return;
      }

      // Store the blob with metadata
      console.log('[P2P Store] Storing blob with CID:', request.cid);
      const ciphertext = Buffer.from(request.ciphertext, 'base64');
      await storageService.storeBlob(request.cid, ciphertext, request.mimeType, {
        appId: request.appId,
        contentType: request.contentType,
        sender: request.authorization?.sender,
        timestamp: request.authorization?.timestamp,
        metadata: request.metadata,
        fromPeer: remotePeer
      });

      console.log('[P2P Store] Blob stored successfully, CID:', request.cid);
      logger.info('Blob stored from browser via P2P', { 
        cid: request.cid, 
        from: remotePeer,
        sender: request.authorization?.sender
      });
      
      console.log('[P2P Store] Triggering replication for CID:', request.cid);
      
      // Trigger replication to other nodes (async, don't wait)
      const { replicationService } = await import('./replication.service.js');
      replicationService.replicateToAll(request.cid, ciphertext, request.mimeType, {
        contentType: request.contentType
      }).then((results) => {
        console.log('[P2P Store] Replication completed:', results.length, 'successful replications');
      }).catch((err: any) => {
        console.error('[P2P Store] Replication failed:', err.message);
        logger.warn('Replication failed for browser-stored blob', { 
          cid: request.cid, 
          error: err.message 
        });
      });
      
      await this.writeMessage(stream, { success: true });

    } catch (error: any) {
      console.error('[P2P Store] ERROR in handleStore:', error.message, error.stack);
      logger.error('Store handler error', { error: error.message });
      try {
        await this.writeMessage(stream, { success: false, error: error.message });
      } catch {
        // Stream may be closed
      }
    }
  }

  /**
   * Handle incoming blob retrieval request
   */
  private async handleBlob(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling blob request', { from: remotePeer });

    try {
      const request = await this.readMessage<BlobRequest>(stream);
      
      if (!request || !request.cid) {
        await this.writeMessage(stream, { success: false, error: 'Invalid request' });
        await stream.close();
        return;
      }

      try {
        const blob = await storageService.getBlob(request.cid);
        
        const response: BlobResponse = {
          success: true,
          ciphertext: blob.ciphertext.toString('base64'),
          mimeType: blob.metadata.mimeType
        };

        await this.writeMessage(stream, response);
        await stream.close();
        logger.debug('Blob served via P2P', { cid: request.cid, to: remotePeer });
      } catch (err: any) {
        await this.writeMessage(stream, { success: false, error: 'Blob not found' });
        await stream.close();
      }

    } catch (error: any) {
      logger.error('Blob handler error', { error: error.message });
      try {
        await this.writeMessage(stream, { success: false, error: error.message });
        await stream.close();
      } catch {
        // Stream may be closed
      }
    }
  }

  /**
   * Handle incoming health request
   */
  private async handleHealth(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Health handler called', { from: remotePeer });

    try {
      // Read empty request (just a ping)
      await this.readMessage(stream);

      const stats = await storageService.getStats();
      const metrics = metricsService.getMetrics();
      const successRate = metricsService.getSuccessRate();
      const multiaddrs = this.node?.getMultiaddrs().map(ma => ma.toString()) || [];

      // Use config.publicKey which matches what's registered on-chain
      // This is the node's identity public key, not the proof service key
      const publicKey = config.publicKey;

      // Get version status from version check service
      const { versionCheckService } = await import('./version-check.service.js');
      const versionStatus = versionCheckService.getVersionStatus();

      // Get on-chain registration status
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      let registeredOnChain = false;
      let onChainNodeId: string | undefined;
      
      if (contractIntegrationService.isInitialized() && publicKey) {
        try {
          const peerId = this.node?.peerId.toString();
          if (peerId) {
            const nodeIdFromContract = await contractIntegrationService.getNodeByPeerId(peerId);
            registeredOnChain = nodeIdFromContract !== null;
            onChainNodeId = nodeIdFromContract || undefined;
          }
        } catch (err) {
          // Ignore - not critical for health response
        }
      }

      const response: P2PHealthResponse = {
        peerId: this.node?.peerId.toString() || '',
        status: versionStatus.outdated || versionStatus.outdatedWarning ? 'outdated' : 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        storageMax: config.gcMaxStorageMB * 1024 * 1024,
        uptime: Math.floor((Date.now() - this.startTime) / 1000), // Return seconds, not milliseconds
        version: versionStatus.current,
        minVersion: versionStatus.minimum || undefined,
        multiaddrs,
        nodeId: config.nodeId,
        publicKey,
        ownerAddress: config.ownerAddress,
        registeredOnChain,
        onChainNodeId,
        metrics: {
          requestsLastHour: metrics.requestsLastHour,
          avgResponseTime: metrics.avgLatency,
          successRate
        }
      };

      logger.info('P2P health response', { 
        nodeId: config.nodeId, 
        publicKey, 
        peerId: this.node?.peerId.toString().slice(0, 12) + '...',
        remotePeer: remotePeer.slice(0, 12) + '...',
        version: versionStatus.current,
        minVersion: versionStatus.minimum,
        registeredOnChain,
        onChainNodeId
      });

      await this.writeMessage(stream, response);
      
      // Close the stream to signal we're done
      await stream.close();

    } catch (error: any) {
      logger.error('Health handler error', { error: error.message, stack: error.stack });
    }
  }

  /**
   * Handle incoming info request (for registration)
   */
  private async handleInfo(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling info request', { from: remotePeer });

    try {
      // Read empty request
      await this.readMessage(stream);

      const response: P2PInfoResponse = {
        peerId: this.node?.peerId.toString() || '',
        publicKey: config.publicKey || '',
        ownerAddress: config.ownerAddress,
        version: '1.0.0'
      };

      await this.writeMessage(stream, response);

    } catch (error: any) {
      logger.error('Info handler error', { error: error.message });
    }
  }

  /**
   * Handle incoming have-cid request (check if node has specific CID)
   */
  private async handleHaveCid(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling have-cid request', { from: remotePeer });

    try {
      const request = await this.readMessage<{ cid: string }>(stream);
      
      if (!request?.cid) {
        await this.writeMessage(stream, { has: false });
        return;
      }

      const hasBlob = await storageService.hasBlob(request.cid);
      await this.writeMessage(stream, { has: hasBlob });
      
      logger.debug('Have-cid response sent', { 
        to: remotePeer, 
        cid: request.cid,
        has: hasBlob
      });
    } catch (error: any) {
      logger.error('Have-cid handler error', { error: error.message });
      try {
        await this.writeMessage(stream, { has: false });
      } catch {
        // Stream may be closed
      }
    }
  }

  /**
   * Handle incoming have-list request
   */
  private async handleHaveList(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling have-list request', { from: remotePeer });

    try {
      const request = await this.readMessage<HaveListRequest>(stream);
      
      // If specific CIDs are requested, check only those
      if (request?.cids && request.cids.length > 0) {
        logger.debug('Checking specific CIDs', { count: request.cids.length, cids: request.cids });
        const foundCids: string[] = [];
        
        for (const cid of request.cids) {
          try {
            const hasBlob = await storageService.hasBlob(cid);
            if (hasBlob) {
              foundCids.push(cid);
            }
          } catch (err) {
            // Blob not found, skip
          }
        }

        const response: HaveListResponse = {
          cids: foundCids,
          total: foundCids.length,
          hasMore: false
        };

        await this.writeMessage(stream, response);
        logger.debug('Sent have-list response for specific CIDs', { 
          to: remotePeer, 
          requested: request.cids.length,
          found: foundCids.length,
          foundCids 
        });
        return;
      }

      // Otherwise, return paginated list of all CIDs
      const limit = request?.limit || 100;
      const offset = request?.offset || 0;

      const allBlobs = await storageService.listBlobs();
      const total = allBlobs.length;
      const cids = allBlobs.slice(offset, offset + limit).map(blob => blob.cid);
      const hasMore = offset + limit < total;

      const response: HaveListResponse = {
        cids,
        total,
        hasMore
      };

      await this.writeMessage(stream, response);
      logger.debug('Sent have-list to peer', { to: remotePeer, count: cids.length, total });

    } catch (error: any) {
      logger.error('Have-list handler error', { error: error.message });
    }
  }

  // ============================================
  // CLIENT METHODS (outgoing requests)
  // ============================================

  /**
   * Replicate a blob to a peer via P2P stream (v2 - with application metadata)
   */
  async replicateToPeer(
    peerId: string,
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: { 
      appId?: string;
      contentType?: string;
      sender?: string;
      timestamp?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<boolean> {
    if (!this.node) {
      logger.warn('[P2P-PROTOCOLS] Node not initialized for replication', { peerId: peerId.slice(0, 12), cid });
      return false;
    }

    logger.info('[P2P-PROTOCOLS] Starting replication to peer', {
      peerId: peerId.slice(0, 12),
      cid,
      protocol: PROTOCOL_REPLICATE,
      ciphertextSize: ciphertext.length
    });

    try {
      // Import peerIdFromString to convert string to PeerId
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerIdObj = peerIdFromString(peerId);
      
      logger.info('[P2P-PROTOCOLS] Attempting to dial protocol', {
        peerId: peerId.slice(0, 12),
        peerIdLength: peerId.length,
        fullPeerId: peerId,
        protocol: PROTOCOL_REPLICATE,
        connections: this.node.getConnections(peerIdObj).length
      });
      
      const stream = await this.node.dialProtocol(peerIdObj, PROTOCOL_REPLICATE);
      
      logger.info('[P2P-PROTOCOLS] Protocol dial successful, sending request', {
        peerId: peerId.slice(0, 12),
        cid
      });

      const request: ReplicateRequest = {
        cid,
        mimeType,
        ciphertext: ciphertext.toString('base64'),
        appId: options?.appId,
        contentType: options?.contentType,
        sender: options?.sender,
        timestamp: options?.timestamp,
        metadata: options?.metadata
      };

      await this.writeMessage(stream, request);
      logger.info('[P2P-PROTOCOLS] Request sent, waiting for response', {
        peerId: peerId.slice(0, 12),
        cid
      });
      
      const response = await this.readMessage<ReplicateResponse>(stream);
      
      logger.info('[P2P-PROTOCOLS] Response received', {
        peerId: peerId.slice(0, 12),
        cid,
        success: response?.success,
        error: response?.error
      });

      await stream.close();

      if (response?.success) {
        logger.info('[P2P-PROTOCOLS] Replication successful', { peerId: peerId.slice(0, 12), cid });
        return true;
      } else {
        logger.warn('[P2P-PROTOCOLS] Replication failed - peer rejected', { 
          peerId: peerId.slice(0, 12), 
          cid, 
          error: response?.error 
        });
        return false;
      }

    } catch (error: any) {
      logger.warn('[P2P-PROTOCOLS] Failed to replicate to peer', { 
        peerId: peerId.slice(0, 12), 
        cid, 
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n')
      });
      return false;
    }
  }

  /**
   * Retrieve a blob from a peer via P2P stream
   */
  async retrieveFromPeer(peerId: string, cid: string): Promise<{ ciphertext: Buffer; mimeType: string } | null> {
    if (!this.node) return null;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_BLOB);

      const request: BlobRequest = { cid };
      await this.writeMessage(stream, request);
      
      const response = await this.readMessage<BlobResponse>(stream);
      await stream.close();

      if (response?.success && response.ciphertext) {
        return {
          ciphertext: Buffer.from(response.ciphertext, 'base64'),
          mimeType: response.mimeType || 'application/octet-stream'
        };
      }

      return null;

    } catch (error: any) {
      logger.warn('Failed to retrieve from peer', { peerId, cid, error: error.message });
      return null;
    }
  }

  /**
   * Get health info from a peer via P2P stream
   */
  async getHealthFromPeer(peerId: string): Promise<P2PHealthResponse | null> {
    if (!this.node) return null;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_HEALTH);

      // Send empty request
      await this.writeMessage(stream, {});
      const response = await this.readMessage<P2PHealthResponse>(stream);
      
      await stream.close();
      return response;

    } catch (error: any) {
      logger.warn('Failed to get health from peer', { peerId, error: error.message });
      return null;
    }
  }

  /**
   * Get node info from a peer via P2P stream (for registration)
   */
  async getInfoFromPeer(peerId: string): Promise<P2PInfoResponse | null> {
    if (!this.node) return null;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_INFO);

      // Send empty request
      await this.writeMessage(stream, {});
      const response = await this.readMessage<P2PInfoResponse>(stream);
      
      await stream.close();
      return response;

    } catch (error: any) {
      logger.warn('Failed to get info from peer', { peerId, error: error.message });
      return null;
    }
  }

  /**
   * Check if a specific peer has a CID
   */
  async checkPeerHasCid(peerId: string, cid: string): Promise<boolean> {
    if (!this.node) return false;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_HAVE_CID);

      await this.writeMessage(stream, { cid });
      const response = await this.readMessage<{ has: boolean }>(stream);
      
      await stream.close();
      return response?.has || false;

    } catch (error: any) {
      logger.debug('Failed to check if peer has CID', { peerId: peerId.slice(0, 12), cid, error: error.message });
      return false;
    }
  }

  /**
   * Get list of CIDs a peer has via P2P stream
   */
  async getHaveListFromPeer(peerId: string, options?: { limit?: number; offset?: number }): Promise<HaveListResponse | null> {
    if (!this.node) return null;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_HAVE_LIST);

      const request: HaveListRequest = {
        limit: options?.limit || 100,
        offset: options?.offset || 0
      };

      await this.writeMessage(stream, request);
      const response = await this.readMessage<HaveListResponse>(stream);
      
      await stream.close();
      return response;

    } catch (error: any) {
      logger.warn('Failed to get have-list from peer', { peerId, error: error.message });
      return null;
    }
  }

  /**
   * Query all connected peers to find who has a specific CID
   * Returns array of peer IDs that have the CID
   */
  async queryWhoHasCid(cid: string, peerIds: string[]): Promise<string[]> {
    const peersWithCid: string[] = [];
    
    const checks = peerIds.map(async (peerId) => {
      const hasCid = await this.checkPeerHasCid(peerId, cid);
      if (hasCid) {
        peersWithCid.push(peerId);
      }
    });

    await Promise.all(checks);
    
    logger.info('[P2P-PROTOCOLS] CID replica query complete', {
      cid,
      queriedPeers: peerIds.length,
      foundReplicas: peersWithCid.length,
      peers: peersWithCid.map(p => p.slice(0, 12))
    });

    return peersWithCid;
  }

  // ============================================
  // STREAM UTILITIES
  // ============================================

  /**
   * Read a JSON message from a stream using custom length-prefixed framing
   */
  private async readMessage<T>(stream: Stream): Promise<T | null> {
    try {
      // Read length prefix (4 bytes, big-endian)
      const lengthBytes = new Uint8Array(4);
      let bytesRead = 0;
      
      // Stream is AsyncIterable itself, not stream.source
      for await (const chunk of stream) {
        const chunkArray = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        const bytesToCopy = Math.min(4 - bytesRead, chunkArray.length);
        lengthBytes.set(chunkArray.subarray(0, bytesToCopy), bytesRead);
        bytesRead += bytesToCopy;
        
        if (bytesRead >= 4) {
          // Read message length
          const length = new DataView(lengthBytes.buffer).getUint32(0, false);
          
          // Read message data
          const messageBytes = new Uint8Array(length);
          let messageBytesRead = 0;
          
          // Copy remaining bytes from first chunk
          if (chunkArray.length > bytesToCopy) {
            const remainingBytes = chunkArray.subarray(bytesToCopy);
            const copyLength = Math.min(remainingBytes.length, length);
            messageBytes.set(remainingBytes.subarray(0, copyLength), 0);
            messageBytesRead = copyLength;
          }
          
          // Read more chunks if needed
          if (messageBytesRead < length) {
            for await (const nextChunk of stream) {
              const nextArray = nextChunk instanceof Uint8Array ? nextChunk : nextChunk.subarray();
              const copyLength = Math.min(nextArray.length, length - messageBytesRead);
              messageBytes.set(nextArray.subarray(0, copyLength), messageBytesRead);
              messageBytesRead += copyLength;
              if (messageBytesRead >= length) break;
            }
          }
          
          const data = new TextDecoder().decode(messageBytes);
          return JSON.parse(data) as T;
        }
      }

      return null;
    } catch (error: any) {
      logger.debug('Failed to read message', { error: error.message });
      return null;
    }
  }

  /**
   * Write a JSON message to a stream using custom length-prefixed framing
   */
  private async writeMessage(stream: Stream, message: any): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(message));
    
    // Create length prefix (4 bytes, big-endian)
    const lengthPrefix = new Uint8Array(4);
    new DataView(lengthPrefix.buffer).setUint32(0, data.length, false);
    
    // Combine length prefix and data
    const combined = new Uint8Array(lengthPrefix.length + data.length);
    combined.set(lengthPrefix, 0);
    combined.set(data, lengthPrefix.length);
    
    // Write to stream using send() method
    stream.send(combined);
  }
}

export const p2pProtocolsService = new P2PProtocolsService();
