/**
 * ByteCave Core - P2P Protocol Handlers
 * 
 * Implements libp2p stream protocols for pure P2P communication:
 * - /bytecave/replicate/1.0.0 - Blob replication between nodes
 * - /bytecave/blob/1.0.0 - Blob retrieval
 * - /bytecave/health/1.0.0 - Health status exchange
 * - /bytecave/info/1.0.0 - Node info (for registration)
 */

import { pipe } from 'it-pipe';
import { Libp2p } from 'libp2p';
import type { Stream, Connection } from '@libp2p/interface';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';
import { config } from '../config/index.js';
import * as lp from 'it-length-prefixed';

// Protocol identifiers
export const PROTOCOL_REPLICATE = '/bytecave/replicate/1.0.0';
export const PROTOCOL_BLOB = '/bytecave/blob/1.0.0';
export const PROTOCOL_HEALTH = '/bytecave/health/1.0.0';
export const PROTOCOL_INFO = '/bytecave/info/1.0.0';

// Message types for protocol communication
interface ReplicateRequest {
  cid: string;
  mimeType: string;
  ciphertext: string; // base64 encoded
  contentType?: string;
  guildId?: string;
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
  contentTypes: string[] | 'all';
  multiaddrs: string[];
}

export interface P2PInfoResponse {
  peerId: string;
  publicKey: string;
  ownerAddress?: string;
  version: string;
  contentTypes: string[] | 'all';
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

    logger.info('P2P protocols registered', {
      protocols: [PROTOCOL_REPLICATE, PROTOCOL_BLOB, PROTOCOL_HEALTH, PROTOCOL_INFO]
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

    logger.info('P2P protocols unregistered');
  }

  // ============================================
  // PROTOCOL HANDLERS (incoming requests)
  // ============================================

  /**
   * Handle incoming replicate request
   */
  private async handleReplicate(stream: Stream, connection: Connection): Promise<void> {
    const remotePeer = connection.remotePeer.toString();
    logger.debug('Handling replicate request', { from: remotePeer });

    try {
      // Check if peer is blocked
      const { blockedContentService } = await import('./blocked-content.service.js');
      if (await blockedContentService.isPeerBlocked(remotePeer)) {
        logger.warn('Replication rejected: Peer is blocked', { peerId: remotePeer });
        await this.writeMessage(stream, { success: false, error: 'Peer blocked' });
        return;
      }

      // Read the request
      const request = await this.readMessage<ReplicateRequest>(stream);
      
      if (!request || !request.cid || !request.ciphertext) {
        await this.writeMessage(stream, { success: false, error: 'Invalid request' });
        return;
      }

      // Check if CID is blocked
      if (await blockedContentService.isBlocked(request.cid)) {
        logger.warn('Replication rejected: CID is blocked', { cid: request.cid, from: remotePeer });
        await this.writeMessage(stream, { success: false, error: 'Content blocked' });
        return;
      }

      // Check if we already have this blob
      const exists = await storageService.hasBlob(request.cid);
      if (exists) {
        logger.debug('Blob already stored', { cid: request.cid });
        await this.writeMessage(stream, { success: true, alreadyStored: true });
        return;
      }

      // Store the blob
      const ciphertext = Buffer.from(request.ciphertext, 'base64');
      await storageService.storeBlob(request.cid, ciphertext, request.mimeType, {
        contentType: request.contentType,
        guildId: request.guildId,
        fromPeer: remotePeer
      });

      logger.info('Blob replicated via P2P', { cid: request.cid, from: remotePeer });
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
    logger.debug('Handling health request', { from: remotePeer });

    try {
      // Read empty request (just a ping)
      await this.readMessage(stream);

      const stats = await storageService.getStats();
      const multiaddrs = this.node?.getMultiaddrs().map(ma => ma.toString()) || [];

      const response: P2PHealthResponse = {
        peerId: this.node?.peerId.toString() || '',
        status: 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        storageMax: config.gcMaxStorageMB * 1024 * 1024,
        uptime: Date.now() - this.startTime,
        version: '1.0.0',
        contentTypes: config.contentFilter.types || 'all',
        multiaddrs
      };

      await this.writeMessage(stream, response);

    } catch (error: any) {
      logger.error('Health handler error', { error: error.message });
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
        version: '1.0.0',
        contentTypes: config.contentFilter.types || 'all'
      };

      await this.writeMessage(stream, response);

    } catch (error: any) {
      logger.error('Info handler error', { error: error.message });
    }
  }

  // ============================================
  // CLIENT METHODS (outgoing requests)
  // ============================================

  /**
   * Replicate a blob to a peer via P2P stream
   */
  async replicateToPeer(
    peerId: string,
    cid: string,
    ciphertext: Buffer,
    mimeType: string,
    options?: { contentType?: string; guildId?: string }
  ): Promise<boolean> {
    if (!this.node) return false;

    try {
      const stream = await this.node.dialProtocol(peerId as any, PROTOCOL_REPLICATE);

      const request: ReplicateRequest = {
        cid,
        mimeType,
        ciphertext: ciphertext.toString('base64'),
        contentType: options?.contentType,
        guildId: options?.guildId
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

  // ============================================
  // STREAM UTILITIES
  // ============================================

  /**
   * Read a JSON message from a stream using length-prefixed framing
   */
  private async readMessage<T>(stream: Stream): Promise<T | null> {
    try {
      const chunks: Uint8Array[] = [];
      
      // Use any to bypass strict typing on stream.source
      const source = (stream as any).source;
      for await (const chunk of pipe(source, lp.decode)) {
        chunks.push(chunk.subarray());
        break; // Only read first message
      }

      if (chunks.length === 0) return null;

      const data = new TextDecoder().decode(chunks[0]);
      return JSON.parse(data) as T;

    } catch (error: any) {
      logger.debug('Failed to read message', { error: error.message });
      return null;
    }
  }

  /**
   * Write a JSON message to a stream using length-prefixed framing
   */
  private async writeMessage(stream: Stream, message: any): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(message));
    
    // Use any to bypass strict typing on stream.sink
    const sink = (stream as any).sink;
    await pipe(
      [data],
      lp.encode,
      sink
    );
  }
}

export const p2pProtocolsService = new P2PProtocolsService();
