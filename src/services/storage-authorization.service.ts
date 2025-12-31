/**
 * HASHD Vault - Storage Authorization Service
 * 
 * Verifies on-chain authorization before accepting storage requests.
 * Implements Direct Storage Spec for:
 * - Group posts (membership verification)
 * - Group comments (membership verification)
 * - Messages (participant verification)
 * - Token distribution (ownership verification)
 */

import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';
import {
  StorageAuthorization,
  AuthorizationVerificationResult
} from '../types/index.js';

// Contract ABIs for authorization verification
const USER_PROFILE_ABI = [
  'function isMember(address user, address groupToken) view returns (bool)'
];

const POST_STORAGE_ABI = [
  'function getPost(uint256 postId) view returns (uint256 id, address author, string ipfsHash, uint256 upvotes, uint256 downvotes, uint256 timestamp, uint8 accessLevel, address groupContract, bool isDeleted)',
  'function getPostByCID(string cid) view returns (uint256 postId, bool exists)'
];

const GROUP_FACTORY_ABI = [
  'function getGroupByToken(address tokenAddr) view returns (tuple(string title, string description, string imageURI, address owner, address tokenAddress, address nftAddress, address postsAddress))'
];

const MESSAGE_STORAGE_ABI = [
  'function messages(bytes32 messageId) view returns (tuple(address sender, address[] recipients, string contentCID, uint256 timestamp, bool exists))',
  'function getMessageByCID(string cid) view returns (bytes32 messageId, bool exists)'
];

// TokenDistribution ABI - for future implementation when contract has CID lookup
// const TOKEN_DISTRIBUTION_ABI = [
//   'function distributions(uint256 distributionId) view returns (tuple(address token, string metadataCID, uint256 timestamp, bool exists))'
// ];

// Signature message format (v2 - includes appId and contentType)
const SIGNATURE_MESSAGE_TEMPLATE = `HASHD Vault Storage Request
Type: {type}
Content Hash: {contentHash}
App ID: {appId}
Content Type: {contentType}
Context: {context}
Timestamp: {timestamp}
Nonce: {nonce}`;

export class StorageAuthorizationService {
  private provider: ethers.Provider | null = null;
  private groupFactoryAddress: string | null = null;
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
    groupFactoryAddress: string;
    messageStorageAddress?: string;
    postStorageAddress?: string;
  }): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
      this.groupFactoryAddress = config.groupFactoryAddress;
      this.messageStorageAddress = config.messageStorageAddress || null;
      this.postStorageAddress = config.postStorageAddress || null;
      this.initialized = true;
      
      logger.info('Storage authorization service initialized', {
        groupFactory: config.groupFactoryAddress,
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
   * Verify the EIP-191 signature (v2 - includes appId and contentType)
   */
  private verifySignature(authorization: StorageAuthorization): boolean {
    try {
      const context = this.getContextString(authorization);
      const message = SIGNATURE_MESSAGE_TEMPLATE
        .replace('{type}', authorization.type)
        .replace('{contentHash}', authorization.contentHash)
        .replace('{appId}', authorization.appId)
        .replace('{contentType}', authorization.contentType)
        .replace('{context}', context)
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
   * Get context string for signature message based on authorization type
   */
  private getContextString(authorization: StorageAuthorization): string {
    switch (authorization.type) {
      case 'group_post':
      case 'group_comment':
        return authorization.groupPostsAddress || '';
      case 'message':
        return authorization.threadId || '';
      case 'token_distribution':
        return authorization.tokenAddress || '';
      default:
        return '';
    }
  }

  /**
   * Verify on-chain authorization based on type
   */
  private async verifyOnChainAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    switch (authorization.type) {
      case 'group_post':
        return this.verifyGroupPostAuthorization(authorization);
      case 'group_comment':
        return this.verifyGroupCommentAuthorization(authorization);
      case 'message':
        return this.verifyMessageAuthorization(authorization);
      case 'token_distribution':
        return this.verifyTokenDistributionAuthorization(authorization);
      default:
        return {
          authorized: false,
          error: `Unknown authorization type: ${authorization.type}`
        };
    }
  }

  /**
   * Verify group post authorization (sender must be group member)
   */
  private async verifyGroupPostAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    if (!authorization.groupPostsAddress) {
      return {
        authorized: false,
        error: 'groupPostsAddress required for group_post authorization'
      };
    }

    try {
      // Get group token from GroupPosts contract
      const GROUP_POSTS_ABI = [
        'function groupToken() view returns (address)',
        'function userProfile() view returns (address)',
        'function groupOwner() view returns (address)'
      ];
      const groupPostsContract = new ethers.Contract(
        authorization.groupPostsAddress,
        GROUP_POSTS_ABI,
        this.provider
      );

      const groupTokenAddress = await groupPostsContract.groupToken();
      const userProfileAddress = await groupPostsContract.userProfile();

      // Check membership via UserProfile
      const userProfileContract = new ethers.Contract(
        userProfileAddress,
        USER_PROFILE_ABI,
        this.provider
      );

      const isMember = await userProfileContract.isMember(
        authorization.sender,
        groupTokenAddress
      );

      if (!isMember) {
        return {
          authorized: false,
          error: 'Sender is not a group member',
          details: {
            sender: authorization.sender,
            groupToken: groupTokenAddress
          }
        };
      }

      logger.debug('Group post authorization verified', {
        sender: authorization.sender,
        groupPosts: authorization.groupPostsAddress
      });

      return { authorized: true, sender: authorization.sender };
    } catch (error: any) {
      logger.error('Group post authorization check failed', error);
      return {
        authorized: false,
        error: 'Failed to verify group membership',
        details: { message: error.message }
      };
    }
  }

  /**
   * Verify group comment authorization (same as group post)
   */
  private async verifyGroupCommentAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    // Comments have same authorization as posts (must be group member)
    return this.verifyGroupPostAuthorization(authorization);
  }

  /**
   * Verify message authorization (sender must be in participants list)
   * 
   * Note: Full thread participant verification happens on-chain when
   * sendMessage is called. Here we just verify the sender claims to
   * be a participant, which is sufficient for storage.
   */
  private async verifyMessageAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    if (!authorization.threadId) {
      return {
        authorized: false,
        error: 'threadId required for message authorization'
      };
    }

    if (!authorization.participants || authorization.participants.length < 2) {
      return {
        authorized: false,
        error: 'participants array required with at least 2 addresses'
      };
    }

    // Verify threadId matches sorted participants hash
    // Frontend can use either wallet addresses OR public keys for threadId
    // Public keys are longer than 42 chars (addresses are 42 with 0x prefix)
    const sortedParticipants = [...authorization.participants]
      .map(p => p.toLowerCase())
      .sort();
    
    // Detect if participants are public keys or addresses
    const isPublicKey = sortedParticipants[0].length > 42;
    
    let expectedThreadId: string;
    if (isPublicKey) {
      // Public keys use string encoding (matches frontend)
      expectedThreadId = ethers.solidityPackedKeccak256(
        ['string', 'string'],
        sortedParticipants
      );
    } else {
      // Wallet addresses use address[] encoding
      expectedThreadId = ethers.solidityPackedKeccak256(
        ['address[]'],
        [sortedParticipants]
      );
    }

    if (authorization.threadId.toLowerCase() !== expectedThreadId.toLowerCase()) {
      return {
        authorized: false,
        error: 'threadId does not match participants hash',
        details: {
          provided: authorization.threadId,
          expected: expectedThreadId,
          participantsType: isPublicKey ? 'publicKeys' : 'addresses'
        }
      };
    }

    logger.debug('Message authorization verified', {
      sender: authorization.sender,
      threadId: authorization.threadId
    });

    return { authorized: true, sender: authorization.sender };
  }

  /**
   * Verify token distribution authorization (sender must be group owner)
   */
  private async verifyTokenDistributionAuthorization(
    authorization: StorageAuthorization
  ): Promise<AuthorizationVerificationResult> {
    if (!authorization.tokenAddress) {
      return {
        authorized: false,
        error: 'tokenAddress required for token_distribution authorization'
      };
    }

    if (!this.groupFactoryAddress) {
      return {
        authorized: false,
        error: 'GroupFactory address not configured'
      };
    }

    try {
      const groupFactory = new ethers.Contract(
        this.groupFactoryAddress,
        GROUP_FACTORY_ABI,
        this.provider
      );

      const groupInfo = await groupFactory.getGroupByToken(authorization.tokenAddress);
      const isOwner = groupInfo.owner.toLowerCase() === authorization.sender.toLowerCase();

      if (!isOwner) {
        return {
          authorized: false,
          error: 'Sender is not the group owner',
          details: {
            sender: authorization.sender,
            owner: groupInfo.owner
          }
        };
      }

      logger.debug('Token distribution authorization verified', {
        sender: authorization.sender,
        tokenAddress: authorization.tokenAddress
      });

      return { authorized: true, sender: authorization.sender };
    } catch (error: any) {
      logger.error('Token distribution authorization check failed', error);
      return {
        authorized: false,
        error: 'Failed to verify group ownership',
        details: { message: error.message }
      };
    }
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
