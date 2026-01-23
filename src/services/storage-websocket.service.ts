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
}

interface StorageRequestMessage {
  type: 'storage-request';
  requestId: string;
  data: string; // base64 encoded blob
  contentType: string;
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

type Message = RegisterMessage | StorageRequestMessage | StorageResponseMessage;

export class StorageWebSocketService {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private peerId: string | null = null;
  private reconnectInterval: number = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl;
  }

  async connect(peerId: string): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      logger.warn('[Storage WS] Already connected or connecting');
      return;
    }

    this.isConnecting = true;
    this.peerId = peerId;

    try {
      logger.info('[Storage WS] Connecting to relay', { url: this.relayUrl });
      this.ws = new WebSocket(this.relayUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        logger.info('[Storage WS] Connected to relay');
        this.register();
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
        logger.warn('[Storage WS] Connection closed, will reconnect...');
        this.scheduleReconnect();
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
      nodeId: config.nodeId
    };

    this.ws.send(JSON.stringify(message));
    logger.info('[Storage WS] Sent registration', { peerId: this.peerId.slice(0, 12), nodeId: config.nodeId });
  }

  private handleMessage(message: Message): void {
    switch (message.type) {
      case 'storage-request':
        this.handleStorageRequest(message);
        break;
      case 'storage-response':
        // We don't expect responses as a storage node
        break;
      default:
        logger.debug('[Storage WS] Received message', { type: message.type });
    }
  }

  private async handleStorageRequest(message: StorageRequestMessage): Promise<void> {
    const { requestId, data, contentType, authorization } = message;

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

      // Store the blob
      await storageService.storeBlob(contentHash, blobData, contentType, {
        appId: authorization?.appId,
        sender: authorization?.address,
        timestamp: authorization?.timestamp
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

  private sendResponse(message: StorageResponseMessage): void {
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
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.peerId) {
        logger.info('[Storage WS] Attempting to reconnect...');
        this.connect(this.peerId);
      }
    }, this.reconnectInterval);
  }

  disconnect(): void {
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
