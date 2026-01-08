/**
 * HASHD Vault - Storage Authorization Service (Numerical Sharding)
 * 
 * Verifies authorization before accepting storage requests.
 * With numerical sharding, authorization is content-agnostic:
 * - Signature verification (EIP-191)
 * - Timestamp freshness
 * - Nonce uniqueness (replay protection)
 * - Content hash match
 * 
 * Content-specific authorization (group membership, etc.) is handled
 * by the application layer, not the storage layer.
 */

import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';
import {
  StorageAuthorization,
  AuthorizationVerificationResult
} from '../types/index.js';

// Signature message format (v3 - numerical sharding, content-agnostic)
const SIGNATURE_MESSAGE_TEMPLATE = `HASHD Vault Storage Request
Content Hash: {contentHash}
Timestamp: {timestamp}
Nonce: {nonce}`;

// Contract ABIs for on-chain verification
const MESSAGE_STORAGE_ABI = [
  'function getMessageByCID(string cid) view returns (tuple(bool exists, address sender, uint256 timestamp))'
];

const POST_STORAGE_ABI = [
  'function getPostByCID(string cid) view returns (tuple(bool exists, address author, uint256 timestamp))'
];

export class StorageAuthorizationService {
  private provider: ethers.Provider | null = null;
  private messageStorageAddress: string | null = null;
  private postStorageAddress: string | null = null;
  private initialized = false;
  
  // Timestamp tolerance (5 minutes)
  private readonly TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
  
  // Nonce cache to prevent replay attacks (in production, use Redis)
  private usedNonces: Map<string, number> = new Map();
  private readonly NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
  
  // CID verification cache (to avoid excessive RPC calls)
  private cidVerificationCache: Map<string, { authorized: boolean; source: string; timestamp: number }> = new Map();
  private readonly CID_CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Initialize the service with RPC and contract addresses
   */
  async initialize(config: {
    rpcUrl: string;
    messageStorageAddress?: string;
    postStorageAddress?: string;
  }): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
      this.messageStorageAddress = config.messageStorageAddress || null;
      this.postStorageAddress = config.postStorageAddress || null;
      this.initialized = true;
      
      logger.info('Storage authorization service initialized', {
        messageStorage: config.messageStorageAddress || 'not configured',
        postStorage: config.postStorageAddress || 'not configured'
      });
      
      // Start cleanup intervals
      setInterval(() => this.cleanupExpiredNonces(), 60000);
      setInterval(() => this.cleanupExpiredCIDCache(), 60000);
    } catch (error) {
      logger.error('Failed to initialize storage authorization service', error);
      throw error;
    }
  }

  /**
   * Verify that a CID exists on-chain in authorized contracts
   * Used to validate P2P replication requests
   */
  async verifyCIDOnChain(cid: string): Promise<{ authorized: boolean; source?: string; error?: string }> {
    if (!this.initialized || !this.provider) {
      return { authorized: false, error: 'Authorization service not initialized' };
    }

    // Check cache first
    const cached = this.cidVerificationCache.get(cid);
    if (cached && Date.now() - cached.timestamp < this.CID_CACHE_EXPIRY_MS) {
      logger.debug('CID verification cache hit', { cid, source: cached.source });
      return { authorized: cached.authorized, source: cached.source };
    }

    try {
      logger.debug('Verifying CID on-chain', { cid });

      // Check MessageStorage contract
      if (this.messageStorageAddress) {
        const messageStorage = new ethers.Contract(
          this.messageStorageAddress,
          MESSAGE_STORAGE_ABI,
          this.provider
        );

        try {
          const result = await messageStorage.getMessageByCID(cid);
          if (result.exists) {
            const cacheEntry = { authorized: true, source: 'MessageStorage', timestamp: Date.now() };
            this.cidVerificationCache.set(cid, cacheEntry);
            logger.info('CID verified on-chain', { cid, source: 'MessageStorage' });
            return { authorized: true, source: 'MessageStorage' };
          }
        } catch (error: any) {
          logger.debug('CID not found in MessageStorage', { cid });
        }
      }

      // Check PostStorage contract (central storage for all group posts)
      if (this.postStorageAddress) {
        const postStorage = new ethers.Contract(
          this.postStorageAddress,
          POST_STORAGE_ABI,
          this.provider
        );

        try {
          const result = await postStorage.getPostByCID(cid);
          if (result.exists) {
            const cacheEntry = { authorized: true, source: 'PostStorage', timestamp: Date.now() };
            this.cidVerificationCache.set(cid, cacheEntry);
            logger.info('CID verified on-chain', { cid, source: 'PostStorage' });
            return { authorized: true, source: 'PostStorage' };
          }
        } catch (error: any) {
          logger.debug('CID not found in PostStorage', { cid });
        }
      }

      // CID not found in any configured contract
      const cacheEntry = { authorized: false, source: 'none', timestamp: Date.now() };
      this.cidVerificationCache.set(cid, cacheEntry);
      
      logger.warn('CID not found in any authorized contract', { 
        cid,
        checkedContracts: {
          messageStorage: !!this.messageStorageAddress,
          postStorage: !!this.postStorageAddress
        }
      });

      return { 
        authorized: false, 
        error: 'CID not found in authorized contracts'
      };
    } catch (error: any) {
      logger.error('Failed to verify CID on-chain', { cid, error: error.message });
      return { authorized: false, error: error.message };
    }
  }

  /**
   * Clean up expired CID verification cache entries
   */
  private cleanupExpiredCIDCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [cid, entry] of this.cidVerificationCache.entries()) {
      if (now - entry.timestamp > this.CID_CACHE_EXPIRY_MS) {
        this.cidVerificationCache.delete(cid);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up expired CID cache entries', { count: cleaned });
    }
  }

  /**
   * Verify a storage authorization request
   */
  async verifyAuthorization(
    authorization: StorageAuthorization,
    actualContentHash: string
  ): Promise<AuthorizationVerificationResult> {
    // 1. Check if service is initialized
    if (!this.initialized || !this.provider) {
      return {
        authorized: false,
        error: 'Authorization service not initialized'
      };
    }

    // 2. Verify appId and contentType are present (v2 requirement)
    if (!authorization.appId || !authorization.contentType) {
      return {
        authorized: false,
        error: 'appId and contentType are required',
        details: {
          hasAppId: !!authorization.appId,
          hasContentType: !!authorization.contentType
        }
      };
    }

    // 3. Verify sender is authorized for this appId (AppRegistry check)
    const { appRegistryService } = await import('./app-registry.service.js');
    const { config } = await import('../config/index.js');
    
    if (!appRegistryService.isInitialized()) {
      // If AppRegistry is required but not initialized, reject the request
      if (config.requireAppRegistry) {
        logger.error('AppRegistry not initialized but is required by node config');
        return {
          authorized: false,
          error: 'AppRegistry validation required but service not initialized',
          details: {
            requireAppRegistry: config.requireAppRegistry
          }
        };
      }
      logger.warn('AppRegistry not initialized, skipping appId validation (requireAppRegistry=false)');
    } else {
      // Verify the app is registered and sender is authorized
      const isAuthorized = await appRegistryService.isAuthorized(
        authorization.appId,
        authorization.sender
      );
      
      if (!isAuthorized) {
        logger.warn('AppRegistry authorization failed', {
          appId: authorization.appId.slice(0, 16) + '...',
          sender: authorization.sender
        });
        return {
          authorized: false,
          error: 'Sender not authorized for this appId or app not registered',
          details: {
            appId: authorization.appId,
            sender: authorization.sender
          }
        };
      }
      logger.debug('✅ AppRegistry authorization verified', {
        appId: authorization.appId.slice(0, 16) + '...',
        sender: authorization.sender
      });
    }
    
    // 3b. Check if this node accepts storage for this app (node-level filtering)
    if (config.allowedApps.length > 0) {
      // Extract app name from appId (format: "hashd" or full hash)
      // For now, we'll use the appId directly for comparison
      const appName = authorization.appId.toLowerCase();
      const isAllowed = config.allowedApps.some(allowed => 
        appName.includes(allowed.toLowerCase()) || allowed === '*'
      );
      
      if (!isAllowed) {
        logger.warn('App not in node allowedApps list', {
          appId: authorization.appId,
          allowedApps: config.allowedApps
        });
        return {
          authorized: false,
          error: 'This node does not accept storage for this app',
          details: {
            appId: authorization.appId,
            allowedApps: config.allowedApps
          }
        };
      }
      logger.debug('✅ App allowed by node config', {
        appId: authorization.appId.slice(0, 16) + '...'
      });
    }

    // 4. Verify timestamp is within tolerance
    const now = Date.now();
    if (Math.abs(now - authorization.timestamp) > this.TIMESTAMP_TOLERANCE_MS) {
      return {
        authorized: false,
        error: 'Timestamp expired or invalid',
        details: { 
          provided: authorization.timestamp, 
          current: now,
          tolerance: this.TIMESTAMP_TOLERANCE_MS 
        }
      };
    }

    // 5. Verify content hash matches
    if (authorization.contentHash.toLowerCase() !== actualContentHash.toLowerCase()) {
      return {
        authorized: false,
        error: 'Content hash mismatch',
        details: {
          provided: authorization.contentHash,
          actual: actualContentHash
        }
      };
    }

    // 6. Check nonce hasn't been used (replay protection)
    const nonceKey = `${authorization.sender}:${authorization.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      return {
        authorized: false,
        error: 'Nonce already used (replay attack prevented)'
      };
    }

    // 7. Verify signature (includes appId and contentType)
    const signatureValid = this.verifySignature(authorization);
    if (!signatureValid) {
      return {
        authorized: false,
        error: 'Invalid signature'
      };
    }

    // 8. Verify on-chain authorization based on type
    const onChainResult = await this.verifyOnChainAuthorization(authorization);
    if (!onChainResult.authorized) {
      return onChainResult;
    }

    // 9. Record nonce as used
    this.usedNonces.set(nonceKey, Date.now());

    return {
      authorized: true,
      sender: authorization.sender
    };
  }

  /**
   * Verify the EIP-191 signature (v3 - numerical sharding, content-agnostic)
   */
  private verifySignature(authorization: StorageAuthorization): boolean {
    try {
      const message = SIGNATURE_MESSAGE_TEMPLATE
        .replace('{contentHash}', authorization.contentHash)
        .replace('{timestamp}', authorization.timestamp.toString())
        .replace('{nonce}', authorization.nonce);

      const recoveredAddress = ethers.verifyMessage(message, authorization.signature);
      const isValid = recoveredAddress.toLowerCase() === authorization.sender.toLowerCase();
      
      if (!isValid) {
        logger.warn('Signature verification failed', {
          expected: authorization.sender,
          recovered: recoveredAddress
        });
      }
      
      return isValid;
    } catch (error) {
      logger.error('Signature verification error', error);
      return false;
    }
  }

  /**
   * Verify on-chain authorization (simplified for numerical sharding)
   * With numerical sharding, authorization is signature-based only.
   * Content-type specific checks are obsolete.
   */
  private async verifyOnChainAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    // Numerical sharding: signature verification is sufficient
    // No content-type specific on-chain checks needed
    return {
      authorized: true,
      sender: authorization.sender
    };
  }

  /**
   * Clean up expired nonces
   */
  private cleanupExpiredNonces(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, timestamp] of this.usedNonces.entries()) {
      if (now - timestamp > this.NONCE_EXPIRY_MS) {
        this.usedNonces.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug('Cleaned expired nonces', { count: cleaned });
    }
  }

  /**
   * Check if service is ready
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
export const storageAuthorizationService = new StorageAuthorizationService();
