/**
 * Storage WebSocket Client Service
 * 
 * Maintains persistent WebSocket connection to relay for receiving storage requests
 * from browsers. This allows browsers to store data without direct P2P connections.
 * 
 * Flow:
 * 1. Connect to relay WebSocket on startup
 * 2. Register with peerId
 * 3. Receive storage-request messages
 * 4. Process storage and send storage-response
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';
import { storageAuthorizationService } from './storage-authorization.service.js';
import { config } from '../config/index.js';

interface RegisterMessage {
  type: 'register';
  peerId: string;
  nodeId?: string;
  isRegistered?: boolean;
}

interface StorageRequestMessage {
  type: 'storage-request';
  requestId: string;
  data: string; // base64 encoded blob
  contentType: string;
  hashIdToken?: number;
  authorization?: {
    signature: string;
    address: string;
    timestamp: number;
    nonce: string;
    appId?: string;
    contentHash?: string;
  };
}

interface StorageResponseMessage {
  type: 'storage-response';
  requestId: string;
  success: boolean;
  cid?: string;
  error?: string;
}

interface RetrieveRequestMessage {
  type: 'retrieve-request';
  requestId: string;
  cid: string;
}

interface RetrieveResponseMessage {
  type: 'retrieve-response';
  requestId: string;
  success: boolean;
  data?: string; // base64
  mimeType?: string;
  error?: string;
}

type Message = RegisterMessage | StorageRequestMessage | StorageResponseMessage | RetrieveRequestMessage | RetrieveResponseMessage;

export class StorageWebSocketService {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private peerId: string | null = null;
  private isRegistered: boolean = false;
  private reconnectInterval: number = 5000;
  private maxReconnectInterval: number = 60000;
  private currentReconnectInterval: number = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
  }

  async connect(peerId: string, isRegistered?: boolean): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      logger.warn('[Storage WS] Already connected or connecting');
      return;
    }

    this.isConnecting = true;
    this.peerId = peerId;
    this.isRegistered = isRegistered ?? false;

    try {
      logger.info('[Storage WS] Connecting to relay', { url: this.relayUrl });
      this.ws = new WebSocket(this.relayUrl);

      this.ws.on('open', async () => {
        this.isConnecting = false;
        this.currentReconnectInterval = this.reconnectInterval; // Reset backoff on successful connection
        logger.info('[Storage WS] Connected to relay');
        this.register();
        
        // Trigger P2P libp2p connection to relay
        const { p2pService } = await import('./p2p.service.js');
        await p2pService.connectToRelayPeer();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as Message;
          this.handleMessage(message);
        } catch (error: any) {
          logger.error('[Storage WS] Failed to parse message', { error: error.message });
        }
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.ws = null;
        if (this.shouldReconnect) {
          logger.warn('[Storage WS] Connection closed, will reconnect in', { delay: this.currentReconnectInterval });
          this.scheduleReconnect();
        } else {
          logger.info('[Storage WS] Connection closed, reconnection disabled');
        }
      });

      this.ws.on('error', (error: Error) => {
        this.isConnecting = false;
        logger.error('[Storage WS] WebSocket error', { error: error.message });
      });

    } catch (error: any) {
      this.isConnecting = false;
      logger.error('[Storage WS] Failed to connect', { error: error.message });
      this.scheduleReconnect();
    }
  }

  private register(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.peerId) {
      return;
    }

    const message: RegisterMessage = {
      type: 'register',
      peerId: this.peerId,
      nodeId: config.nodeId,
      isRegistered: this.isRegistered
    };

    this.ws.send(JSON.stringify(message));
    logger.info('[Storage WS] Sent registration', { peerId: this.peerId.slice(0, 12), nodeId: config.nodeId });
  }

  private handleMessage(message: Message): void {
    switch (message.type) {
      case 'storage-request':
        this.handleStorageRequest(message);
        break;
      case 'retrieve-request':
        this.handleRetrieveRequest(message);
        break;
      case 'storage-response':
      case 'retrieve-response':
        // We don't expect responses as a storage node
        break;
      default:
        logger.debug('[Storage WS] Received message', { type: message.type });
    }
  }

  private async handleStorageRequest(message: StorageRequestMessage): Promise<void> {
    const { requestId, data, contentType, hashIdToken, authorization } = message;

    logger.info('[Storage WS] Received storage request', {
      requestId,
      dataSize: data.length,
      contentType,
      hasAuth: !!authorization
    });

    try {
      // Decode base64 data
      const blobData = Buffer.from(data, 'base64');

      // Calculate content hash for verification
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256');
      hash.update(blobData);
      const contentHash = hash.digest('hex');

      // Verify authorization if provided
      if (authorization) {
        // For signature verification, use the contentHash as-is (with 0x prefix if present)
        // For hash comparison, normalize by removing 0x prefix
        const authContentHash = authorization.contentHash || contentHash;
        const normalizedAuthHash = authContentHash.startsWith('0x') 
          ? authContentHash.slice(2) 
          : authContentHash;
        
        logger.info('[Storage WS] Hash comparison', {
          authContentHash,
          normalizedAuthHash,
          calculatedHash: contentHash,
          match: normalizedAuthHash === contentHash
        });
        
        logger.info('[Storage WS] Calling verifyAuthorization', {
          appId: authorization.appId,
          sender: authorization.address,
          hasSignature: !!authorization.signature
        });
        
        const authResult = await storageAuthorizationService.verifyAuthorization(
          {
            signature: authorization.signature,
            sender: authorization.address,
            contentHash: authContentHash, // Keep 0x prefix for signature verification
            appId: authorization.appId,
            timestamp: authorization.timestamp,
            nonce: authorization.nonce
          },
          contentHash // Pass calculated hash (without 0x) for comparison
        );
        
        logger.info('[Storage WS] verifyAuthorization result', {
          authorized: authResult.authorized,
          error: authResult.error
        });

        if (!authResult.authorized) {
          throw new Error(authResult.error || 'Invalid storage authorization');
        }
      }

      // SECURITY CHECK: Verify CID is registered in ContentRegistry
      // This ensures only on-chain registered content can be stored
      const onChainVerification = await storageAuthorizationService.verifyCIDOnChain(contentHash);
      
      if (!onChainVerification.authorized) {
        logger.warn('[Storage WS] Store rejected: CID not registered in ContentRegistry', { 
          cid: contentHash, 
          sender: authorization?.address,
          error: onChainVerification.error
        });
        throw new Error('Content must be registered in ContentRegistry before storage');
      }
      
      logger.debug('[Storage WS] ✅ ContentRegistry verification passed', { 
        cid: contentHash,
        source: onChainVerification.source
      });

      // Store the blob
      await storageService.storeBlob(contentHash, blobData, contentType, {
        appId: authorization?.appId,
        sender: authorization?.address,
        timestamp: authorization?.timestamp,
        hashIdToken
      });

      // Send success response
      this.sendResponse({
        type: 'storage-response',
        requestId,
        success: true,
        cid: contentHash
      });

      logger.info('[Storage WS] Storage successful', {
        requestId,
        cid: contentHash.slice(0, 16)
      });

    } catch (error: any) {
      logger.error('[Storage WS] Storage failed', { error: error.message });

      // Send error response
      this.sendResponse({
        type: 'storage-response',
        requestId,
        success: false,
        error: error.message
      });
    }
  }

  private async handleRetrieveRequest(message: RetrieveRequestMessage): Promise<void> {
    const { requestId, cid } = message;

    logger.info('[Storage WS] Received retrieve request', { requestId, cid: cid.slice(0, 16) });

    try {
      // Retrieve the blob from storage
      const blob = await storageService.getBlob(cid);

      if (!blob) {
        throw new Error('Blob not found');
      }

      // Convert blob ciphertext to base64
      const base64Data = blob.ciphertext.toString('base64');

      // Send success response
      this.sendResponse({
        type: 'retrieve-response',
        requestId,
        success: true,
        data: base64Data,
        mimeType: blob.metadata.mimeType || 'application/octet-stream'
      });

      logger.info('[Storage WS] Retrieval successful', {
        requestId,
        cid: cid.slice(0, 16),
        size: blob.ciphertext.length
      });

    } catch (error: any) {
      logger.error('[Storage WS] Retrieval failed', { error: error.message, cid: cid.slice(0, 16) });

      // Send error response
      this.sendResponse({
        type: 'retrieve-response',
        requestId,
        success: false,
        error: error.message
      });
    }
  }

  private sendResponse(message: StorageResponseMessage | RetrieveResponseMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('[Storage WS] Cannot send response, WebSocket not open');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error: any) {
      logger.error('[Storage WS] Failed to send response', { error: error.message });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.peerId && this.shouldReconnect) {
        logger.info('[Storage WS] Attempting to reconnect...', { attempt: Math.floor(this.currentReconnectInterval / 1000) + 's delay' });
        this.connect(this.peerId, this.isRegistered);
        
        // Exponential backoff: double the interval up to max
        this.currentReconnectInterval = Math.min(
          this.currentReconnectInterval * 2,
          this.maxReconnectInterval
        );
      }
    }, this.currentReconnectInterval);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('[Storage WS] Disconnected');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const storageWebSocketService = new StorageWebSocketService(
  process.env.RELAY_WS_URL || 'ws://localhost:4003'
);
