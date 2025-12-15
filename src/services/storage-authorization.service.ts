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

const GROUP_POSTS_ABI = [
  'function groupToken() view returns (address)',
  'function userProfile() view returns (address)',
  'function groupOwner() view returns (address)'
];

const GROUP_FACTORY_ABI = [
  'function getGroupByToken(address tokenAddr) view returns (tuple(string title, string description, string imageURI, address owner, address tokenAddress, address nftAddress, address postsAddress))'
];

// Signature message format
const SIGNATURE_MESSAGE_TEMPLATE = `HASHD Vault Storage Request
Type: {type}
Content Hash: {contentHash}
Context: {context}
Timestamp: {timestamp}
Nonce: {nonce}`;

export class StorageAuthorizationService {
  private provider: ethers.Provider | null = null;
  private groupFactoryAddress: string | null = null;
  private initialized = false;
  
  // Timestamp tolerance (5 minutes)
  private readonly TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
  
  // Nonce cache to prevent replay attacks (in production, use Redis)
  private usedNonces: Map<string, number> = new Map();
  private readonly NONCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

  /**
   * Initialize the service with RPC and contract addresses
   */
  async initialize(config: {
    rpcUrl: string;
    groupFactoryAddress: string;
  }): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
      this.groupFactoryAddress = config.groupFactoryAddress;
      this.initialized = true;
      
      logger.info('Storage authorization service initialized', {
        groupFactory: config.groupFactoryAddress
      });
      
      // Start nonce cleanup interval
      setInterval(() => this.cleanupExpiredNonces(), 60000);
    } catch (error) {
      logger.error('Failed to initialize storage authorization service', error);
      throw error;
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

    // 2. Verify timestamp is within tolerance
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

    // 3. Verify content hash matches
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

    // 4. Check nonce hasn't been used (replay protection)
    const nonceKey = `${authorization.sender}:${authorization.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      return {
        authorized: false,
        error: 'Nonce already used (replay attack prevented)'
      };
    }

    // 5. Verify signature
    const signatureValid = this.verifySignature(authorization);
    if (!signatureValid) {
      return {
        authorized: false,
        error: 'Invalid signature'
      };
    }

    // 6. Verify on-chain authorization based on type
    const onChainResult = await this.verifyOnChainAuthorization(authorization);
    if (!onChainResult.authorized) {
      return onChainResult;
    }

    // 7. Record nonce as used
    this.usedNonces.set(nonceKey, Date.now());

    return {
      authorized: true,
      sender: authorization.sender
    };
  }

  /**
   * Verify the EIP-191 signature
   */
  private verifySignature(authorization: StorageAuthorization): boolean {
    try {
      const context = this.getContextString(authorization);
      const message = SIGNATURE_MESSAGE_TEMPLATE
        .replace('{type}', authorization.type)
        .replace('{contentHash}', authorization.contentHash)
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

    // Verify sender is in participants list
    const senderLower = authorization.sender.toLowerCase();
    const isParticipant = authorization.participants.some(
      p => p.toLowerCase() === senderLower
    );

    if (!isParticipant) {
      return {
        authorized: false,
        error: 'Sender is not in participants list',
        details: {
          sender: authorization.sender,
          participants: authorization.participants
        }
      };
    }

    // Verify threadId matches sorted participants hash
    const sortedParticipants = [...authorization.participants]
      .map(p => p.toLowerCase())
      .sort();
    const expectedThreadId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address[]'],
        [sortedParticipants]
      )
    );

    if (authorization.threadId.toLowerCase() !== expectedThreadId.toLowerCase()) {
      return {
        authorized: false,
        error: 'threadId does not match participants hash',
        details: {
          provided: authorization.threadId,
          expected: expectedThreadId
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
