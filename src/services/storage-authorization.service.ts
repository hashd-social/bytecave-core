/**
 * ByteCave - Storage Authorization Service (Numerical Sharding)
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
const SIGNATURE_MESSAGE_TEMPLATE = `ByteCave Storage Request for:
Content Hash: {contentHash}
App ID: {appId}
Timestamp: {timestamp}
Nonce: {nonce}`;

// Contract ABIs for on-chain verification
const MESSAGE_STORAGE_ABI = [
  'function getMessageByCID(string cid) view returns (tuple(bool exists, address sender, uint256 timestamp))'
];

const POST_STORAGE_ABI = [
  'function getPostByCID(string cid) view returns (tuple(bool exists, address author, uint256 timestamp))'
];

const CONTENT_REGISTRY_ABI = [
  'function isContentRegistered(bytes32 cid) external view returns (bool)'
];

export class StorageAuthorizationService {
  private provider: ethers.Provider | null = null;
  private messageStorageAddress: string | null = null;
  private postStorageAddress: string | null = null;
  private contentRegistryAddress: string | null = null;
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
  async initialize(rpcUrl: string, messageStorageAddress?: string, postStorageAddress?: string, contentRegistryAddress?: string) {
    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.messageStorageAddress = messageStorageAddress || null;
      this.postStorageAddress = postStorageAddress || null;
      this.contentRegistryAddress = contentRegistryAddress || null;
      this.initialized = true;
      
      logger.info('Storage authorization service initialized', {
        hasMessageStorage: !!this.messageStorageAddress,
        hasPostStorage: !!this.postStorageAddress,
        hasContentRegistry: !!this.contentRegistryAddress
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

      // Check ContentRegistry first (primary source for all content)
      if (this.contentRegistryAddress) {
        const contentRegistry = new ethers.Contract(
          this.contentRegistryAddress,
          CONTENT_REGISTRY_ABI,
          this.provider
        );

        try {
          // CID is already a SHA-256 hash (bytes32), just add 0x prefix
          const cidBytes32 = '0x' + cid;
          const isRegistered = await contentRegistry.isContentRegistered(cidBytes32);
          if (isRegistered) {
            const cacheEntry = { authorized: true, source: 'ContentRegistry', timestamp: Date.now() };
            this.cidVerificationCache.set(cid, cacheEntry);
            logger.info('CID verified on-chain', { cid, source: 'ContentRegistry' });
            return { authorized: true, source: 'ContentRegistry' };
          }
        } catch (error: any) {
          logger.debug('CID not found in ContentRegistry', { cid, error: error.message });
        }
      }

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
          contentRegistry: !!this.contentRegistryAddress,
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

    // 2. Verify appId is present (v2 requirement)
    if (!authorization.appId) {
      return {
        authorized: false,
        error: 'appId is required',
        details: {
          hasAppId: !!authorization.appId
        }
      };
    }

    // 3. Verify app authorization (two-step check)
    const { appRegistryService } = await import('./app-registry.service.js');
    const { config } = await import('../config/index.js');
    const hasAllowedAppsFilter = config.allowedApps && config.allowedApps.length > 0;
    
    // Step A: Verify app is registered on-chain (always required if AppRegistry is initialized)
    if (appRegistryService.isInitialized()) {
      const appDetails = await appRegistryService.getApp(authorization.appId);
      
      if (!appDetails || !appDetails.active) {
        logger.warn('AppRegistry check failed - app not registered or not active', {
          appId: authorization.appId,
          exists: !!appDetails,
          active: appDetails?.active
        });
        return {
          authorized: false,
          error: 'App not registered or not active in AppRegistry',
          details: {
            appId: authorization.appId
          }
        };
      }
      
      logger.debug('✅ App is registered on-chain', {
        appId: authorization.appId,
        appName: appDetails.appName,
        owner: appDetails.owner
      });
    } else {
      logger.warn('AppRegistry not initialized - cannot verify app registration', {
        appId: authorization.appId
      });
      // Fail closed - if AppRegistry is not initialized, reject storage
      return {
        authorized: false,
        error: 'AppRegistry not initialized - cannot verify app registration'
      };
    }
    
    // Step B: Check if app is in node's allowedApps filter (if configured)
    if (hasAllowedAppsFilter) {
      if (!config.allowedApps.includes(authorization.appId)) {
        logger.warn('App not in node allowedApps filter', {
          appId: authorization.appId,
          allowedApps: config.allowedApps
        });
        return {
          authorized: false,
          error: 'App not in node allowedApps filter',
          details: {
            appId: authorization.appId,
            allowedApps: config.allowedApps
          }
        };
      }
      
      logger.debug('✅ App is in node allowedApps filter', {
        appId: authorization.appId
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

    // 5. Verify content hash matches (normalize by removing 0x prefix if present)
    const normalizedAuthHash = authorization.contentHash.startsWith('0x') 
      ? authorization.contentHash.slice(2).toLowerCase()
      : authorization.contentHash.toLowerCase();
    const normalizedActualHash = actualContentHash.startsWith('0x')
      ? actualContentHash.slice(2).toLowerCase()
      : actualContentHash.toLowerCase();
    
    if (normalizedAuthHash !== normalizedActualHash) {
      return {
        authorized: false,
        error: 'Content hash mismatch',
        details: {
          provided: authorization.contentHash,
          actual: actualContentHash,
          normalizedProvided: normalizedAuthHash,
          normalizedActual: normalizedActualHash
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
        .replace('{appId}', authorization.appId || '')
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
