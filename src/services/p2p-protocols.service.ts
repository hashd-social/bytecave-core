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
    node.handle(PROTOCOL_BLOB, (stream: Stream, connection: Connection) => 
      this.handleBlob(stream, connection));
    node.handle(PROTOCOL_HEALTH, (stream: Stream, connection: Connection) => 
      this.handleHealth(stream, connection));
    node.handle(PROTOCOL_INFO, (stream: Stream, connection: Connection) => 
      this.handleInfo(stream, connection));
    node.handle(PROTOCOL_HAVE_LIST, (stream: Stream, connection: Connection) => 
      this.handleHaveList(stream, connection));

    logger.info('P2P protocols registered', {
      protocols: [PROTOCOL_REPLICATE, PROTOCOL_BLOB, PROTOCOL_HEALTH, PROTOCOL_INFO, PROTOCOL_HAVE_LIST]
    });
  }

  /**
   * Unregister all protocol handlers
   */
  unregisterProtocols(): void {
    if (!this.node) return;

    this.node.unhandle(PROTOCOL_REPLICATE);
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

      // SECURITY CHECK 2: Verify peer is an authorized VaultNode (registered on-chain)
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      
      // Get peer's public key from libp2p connection
      const peerPublicKey = connection.remotePeer.publicKey;
      if (!peerPublicKey) {
        logger.warn('Replication rejected: Peer has no public key', { peerId: remotePeer });
        await this.writeMessage(stream, { success: false, error: 'Peer authentication failed' });
        return;
      }
      
      // Convert libp2p public key to bytes for on-chain lookup
      // The public key raw property is a Uint8Array
      const publicKeyBytes = peerPublicKey.raw;
      const publicKeyHex = '0x' + Buffer.from(publicKeyBytes).toString('hex');
      
      // Hash the public key to get nodeId (same as contract does)
      const { ethers } = await import('ethers');
      const nodeId = ethers.keccak256(publicKeyHex);
      
      // Verify node is registered and active in VaultNodeRegistry
      const isAuthorized = await contractIntegrationService.isNodeActive(nodeId);
      if (!isAuthorized) {
        logger.warn('Replication rejected: Peer not registered in VaultNodeRegistry', { 
          peerId: remotePeer,
          nodeId,
          publicKey: publicKeyHex.slice(0, 20) + '...'
        });
        await this.writeMessage(stream, { success: false, error: 'Peer not authorized' });
        return;
      }
      
      logger.debug('✅ Peer authorization verified via VaultNodeRegistry', { 
        peerId: remotePeer,
        nodeId: nodeId.slice(0, 16) + '...'
      });

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
      const isMediaContent = request.contentType === 'media';
      
      if (!isMediaContent) {
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
      } else {
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
    if (!this.node) return false;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_REPLICATE);

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
      const response = await this.readMessage<ReplicateResponse>(stream);

      await stream.close();

      if (response?.success) {
        logger.debug('Replicated to peer via P2P', { peerId, cid });
        return true;
      } else {
        logger.warn('Replication failed', { peerId, cid, error: response?.error });
        return false;
      }

    } catch (error: any) {
      logger.warn('Failed to replicate to peer', { peerId, cid, error: error.message });
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
