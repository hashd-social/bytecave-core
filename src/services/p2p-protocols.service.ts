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
import { proofService } from './proof.service.js';
import { config } from '../config/index.js';

// Protocol identifiers
export const PROTOCOL_REPLICATE = '/bytecave/replicate/1.0.0';
export const PROTOCOL_STORE = '/bytecave/store/1.0.0'; // Browser-to-node storage with authorization
export const PROTOCOL_BLOB = '/bytecave/blob/1.0.0';
export const PROTOCOL_HEALTH = '/bytecave/health/1.0.0';
export const PROTOCOL_INFO = '/bytecave/info/1.0.0';
export const PROTOCOL_HAVE_LIST = '/bytecave/have-list/1.0.0';

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
  status: 'healthy' | 'degraded' | 'unhealthy';
  blobCount: number;
  storageUsed: number;
  storageMax: number;
  uptime: number;
  version: string;
  multiaddrs: string[];
  nodeId?: string;
  publicKey?: string;
  ownerAddress?: string;
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
  limit?: number; // Max number of CIDs to return
  offset?: number; // Pagination offset
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

    logger.info('P2P protocols registered', {
      protocols: [PROTOCOL_REPLICATE, PROTOCOL_STORE, PROTOCOL_BLOB, PROTOCOL_HEALTH, PROTOCOL_INFO, PROTOCOL_HAVE_LIST]
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

      // SECURITY CHECK 5: Verify CID exists on-chain in authorized contracts (for messages only)
      // Media content is verified by signature alone - no on-chain CID storage
      // Skip this check when REQUIRE_APP_REGISTRY is false
      const isMediaContent = request.contentType === 'media';
      const requireAppRegistry = process.env.REQUIRE_APP_REGISTRY !== 'false';
      
      if (!isMediaContent && requireAppRegistry) {
        // For messages/posts: require on-chain CID verification
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
      
      if (isMediaContent && requireAppRegistry) {
        // For media: verify sender signature was provided
        if (!request.sender) {
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
        logger.debug('Media content accepted - signature-based authorization', { 
          cid: request.cid, 
          sender: request.sender 
        });
      }

      // Check if we already have this blob
      const exists = await storageService.hasBlob(request.cid);
      if (exists) {
        logger.debug('Blob already stored', { cid: request.cid });
        await this.writeMessage(stream, { success: true, alreadyStored: true });
        return;
      }

      // All security checks passed - store the blob with metadata
      await storageService.storeBlob(request.cid, ciphertext, request.mimeType, {
        appId: request.appId,
        contentType: request.contentType,
        sender: request.sender,
        timestamp: request.timestamp,
        metadata: request.metadata,
        fromPeer: remotePeer
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
      
      if (!request || !request.cid || !request.ciphertext) {
        await this.writeMessage(stream, { success: false, error: 'Invalid request' });
        return;
      }

      // Check if this node is registered on-chain (only registered nodes accept storage)
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      const { p2pService } = await import('./p2p.service.js');
      
      if (contractIntegrationService.isInitialized()) {
        try {
          // Get this node's peer ID
          const myPeerId = p2pService.getPeerId();
          if (!myPeerId) {
            logger.warn('Store rejected: P2P peer ID not available', { cid: request.cid });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not configured properly (no peer ID)' 
            });
            return;
          }

          // Check if this peer ID is registered on-chain
          const nodeId = await contractIntegrationService.getNodeByPeerId(myPeerId);
          
          if (!nodeId) {
            logger.warn('Store rejected: Node peer ID not registered on-chain', { 
              cid: request.cid, 
              peerId: myPeerId.slice(0, 12) + '...' 
            });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not registered on-chain. Only registered nodes accept storage.' 
            });
            return;
          }

          const node = await contractIntegrationService.getNode(nodeId);
          if (!node || !node.active) {
            logger.warn('Store rejected: Node not active on-chain', { cid: request.cid, nodeId });
            await this.writeMessage(stream, { 
              success: false, 
              error: 'Node not active on-chain. Only active registered nodes accept storage.' 
            });
            return;
          }

          logger.debug('Node registration verified', { 
            nodeId, 
            peerId: myPeerId.slice(0, 12) + '...', 
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
        logger.debug('Blob served via P2P', { cid: request.cid, to: remotePeer });
      } catch (err: any) {
        await this.writeMessage(stream, { success: false, error: 'Blob not found' });
      }

    } catch (error: any) {
      logger.error('Blob handler error', { error: error.message });
      try {
        await this.writeMessage(stream, { success: false, error: error.message });
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

      // Get public key if available
      let publicKey: string | undefined;
      try {
        publicKey = proofService.getPublicKey();
      } catch {
        // Keys not initialized yet
      }

      const response: P2PHealthResponse = {
        peerId: this.node?.peerId.toString() || '',
        status: 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        storageMax: config.gcMaxStorageMB * 1024 * 1024,
        uptime: Date.now() - this.startTime,
        version: '1.0.0',
        multiaddrs,
        nodeId: config.nodeId,
        publicKey,
        ownerAddress: config.ownerAddress,
        metrics: {
          requestsLastHour: metrics.requestsLastHour,
          avgResponseTime: metrics.avgLatency,
          successRate
        }
      };

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
   * Handle incoming have-list request
   */
  private async handleHaveList(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling have-list request', { from: remotePeer });

    try {
      const request = await this.readMessage<HaveListRequest>(stream);
      
      const limit = request?.limit || 100;
      const offset = request?.offset || 0;

      // Get list of CIDs we have
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
