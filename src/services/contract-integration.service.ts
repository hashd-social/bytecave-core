/**
 * ByteCave - Contract Integration Service
 * 
 * Bridges vault services with on-chain smart contracts:
 * - VaultNodeRegistry (node registration & discovery)
 * - VaultIncentives (optional rewards & reputation)
 * - Guild contracts (posting rules & allowlists)
 */

import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';
import { appIdsToBytes32 } from '../utils/content-registry.js';
import { NODE_REGISTRY_ABI, INCENTIVES_ABI, CONTENT_REGISTRY_ABI } from '../abis/index.js';

// ABI fragments for the contracts we need

export interface NodeInfo {
  nodeId: string;
  owner: string;
  publicKey: string;
  url: string;
  metadataHash: string;
  registeredAt: number;
  active: boolean;
}

export interface NodeReputation {
  totalProofs: bigint;
  validProofs: bigint;
  invalidProofs: bigint;
  missedProofs: bigint;
  lastActiveBlock: bigint;
  reliabilityScore: bigint;
  blacklisted: boolean;
}

export class ContractIntegrationService {
  private provider: ethers.Provider | null = null;
  private signer: ethers.Signer | null = null;
  private nodeRegistry: ethers.Contract | null = null;
  private incentives: ethers.Contract | null = null;
  private contentRegistry: ethers.Contract | null = null;

  /**
   * Initialize contract integration
   */
  async initialize(config: {
    rpcUrl: string;
    privateKey?: string;
    registryAddress: string;
    incentivesAddress?: string;
    contentRegistryAddress?: string;
  }): Promise<void> {
    try {
      // Setup provider
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);

      // Setup signer if private key provided
      if (config.privateKey) {
        this.signer = new ethers.Wallet(config.privateKey, this.provider);
      }

      // Initialize node registry contract
      this.nodeRegistry = new ethers.Contract(
        config.registryAddress,
        NODE_REGISTRY_ABI,
        this.signer || this.provider
      );

      // Initialize incentives contract if provided
      if (config.incentivesAddress) {
        this.incentives = new ethers.Contract(
          config.incentivesAddress,
          INCENTIVES_ABI,
          this.signer || this.provider
        );
      }

      // Initialize content registry contract if provided
      if (config.contentRegistryAddress) {
        this.contentRegistry = new ethers.Contract(
          config.contentRegistryAddress,
          CONTENT_REGISTRY_ABI,
          this.provider // Read-only, no signer needed
        );
      }

      logger.info('Contract integration initialized', {
        registry: config.registryAddress,
        incentives: config.incentivesAddress || 'not configured',
        contentRegistry: config.contentRegistryAddress || 'not configured'
      });
    } catch (error: any) {
      logger.error('Failed to initialize contract integration', error);
      throw error;
    }
  }

  /**
   * Check if contracts are initialized
   */
  isInitialized(): boolean {
    return this.nodeRegistry !== null;
  }

  // ============================================
  // NODE REGISTRY METHODS
  // ============================================

  /**
   * Get node information from registry
   */
  async getNode(nodeId: string): Promise<{
    nodeId: string;
    owner: string;
    publicKey: string;
    peerId: string;
    metadataHash: string;
    registeredAt: number;
    active: boolean;
  } | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const node = await this.nodeRegistry.getNode(nodeId);
      
      return {
        nodeId,
        owner: node.owner,
        publicKey: ethers.hexlify(node.publicKey),
        peerId: node.peerId,
        metadataHash: node.metadataHash,
        registeredAt: Number(node.registeredAt),
        active: node.active
      };
    } catch (error: any) {
      logger.error('Failed to get node', { nodeId, error: error.message });
      return null;
    }
  }

  /**
   * Get node ID by owner address
   */
  async getNodeByOwner(owner: string): Promise<string | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const nodeId = await this.nodeRegistry.getNodeByOwner(owner);
      // Check if nodeId is zero (not registered)
      if (nodeId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        return null;
      }
      return nodeId;
    } catch (error: any) {
      logger.error('Failed to get node by owner', { owner, error: error.message });
      return null;
    }
  }

  /**
   * Check if current node is registered on-chain
   * Returns the node ID if registered, null otherwise
   */
  async checkCurrentNodeRegistration(publicKey: string, ownerAddress?: string): Promise<{
    registered: boolean;
    nodeId: string | null;
  }> {
    if (!this.nodeRegistry) {
      logger.warn('Registry not initialized - cannot check registration');
      return { registered: false, nodeId: null };
    }

    try {
      // Normalize public key format (ensure 0x prefix for comparison)
      const normalizedPublicKey = publicKey.startsWith('0x') ? publicKey : `0x${publicKey}`;
      
      // Try to find by owner address first if provided
      if (ownerAddress) {
        logger.info('Checking registration by owner address', { owner: ownerAddress });
        const nodeId = await this.getNodeByOwner(ownerAddress);
        logger.info('getNodeByOwner result', { nodeId: nodeId || 'null' });
        
        if (nodeId) {
          const node = await this.getNode(nodeId);
          logger.info('getNode result', { 
            nodeId: nodeId.slice(0, 16) + '...',
            active: node?.active,
            owner: node?.owner,
            publicKey: node?.publicKey?.slice(0, 32) + '...'
          });
          
          if (node && node.active) {
            // IMPORTANT: Verify the public key matches this node
            // Multiple nodes can have the same owner, but only one public key per node
            const nodePublicKey = node.publicKey.startsWith('0x') ? node.publicKey : `0x${node.publicKey}`;
            const publicKeysMatch = nodePublicKey.toLowerCase() === normalizedPublicKey.toLowerCase();
            
            logger.info('Verifying public key match', {
              nodePublicKey: nodePublicKey.slice(0, 32) + '...',
              searchPublicKey: normalizedPublicKey.slice(0, 32) + '...',
              match: publicKeysMatch
            });
            
            if (publicKeysMatch) {
              logger.info('Node found by owner address with matching public key', { 
                nodeId: nodeId.slice(0, 16) + '...', 
                owner: ownerAddress 
              });
              return { registered: true, nodeId };
            } else {
              logger.warn('Node found by owner but public key does not match - different node', {
                nodeId: nodeId.slice(0, 16) + '...',
                registeredKey: nodePublicKey.slice(0, 32) + '...',
                currentKey: normalizedPublicKey.slice(0, 32) + '...'
              });
            }
          } else {
            logger.warn('Node found by owner but not active', {
              nodeId: nodeId.slice(0, 16) + '...',
              active: node?.active
            });
          }
        } else {
          logger.info('No node found for owner address', { owner: ownerAddress });
        }
      }

      // Fallback: search all active nodes by public key
      const activeNodeIds = await this.getActiveNodes();
      logger.info('Checking registration by public key', { 
        publicKey: normalizedPublicKey.slice(0, 16) + '...', 
        totalActiveNodes: activeNodeIds.length 
      });
      
      for (const nodeId of activeNodeIds) {
        try {
          const node = await this.getNode(nodeId);
          if (!node) continue;
          
          // Compare normalized public keys (both with 0x prefix)
          const nodePublicKey = node.publicKey.startsWith('0x') ? node.publicKey : `0x${node.publicKey}`;
          
          logger.info('Comparing public keys', {
            nodeId: nodeId.slice(0, 16) + '...',
            registryKey: nodePublicKey.slice(0, 32) + '...',
            searchKey: normalizedPublicKey.slice(0, 32) + '...',
            match: nodePublicKey.toLowerCase() === normalizedPublicKey.toLowerCase()
          });
          
          if (nodePublicKey.toLowerCase() === normalizedPublicKey.toLowerCase()) {
            logger.info('Node found by public key', { 
              nodeId: nodeId.slice(0, 16) + '...',
              publicKey: normalizedPublicKey.slice(0, 16) + '...'
            });
            return { registered: true, nodeId };
          }
        } catch (err) {
          // Skip nodes that fail to load
          continue;
        }
      }

      logger.warn('Node not found in registry', { 
        publicKey: normalizedPublicKey.slice(0, 16) + '...',
        ownerAddress 
      });
      return { registered: false, nodeId: null };
    } catch (error) {
      logger.error('Failed to check node registration', error);
      return { registered: false, nodeId: null };
    }
  }

  /**
   * Get node ID by peer ID
   */
  async getNodeByPeerId(peerId: string): Promise<string | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      // Get all active nodes and check if any match this peer ID
      const nodeIds = await this.nodeRegistry.getActiveNodes();
      logger.info('Checking peer ID registration', { 
        lookingFor: peerId,
        totalNodes: nodeIds.length 
      });
      
      for (const nodeId of nodeIds) {
        try {
          const node = await this.nodeRegistry.getNode(nodeId);
          logger.info('Comparing peer IDs', {
            nodeId: nodeId.slice(0, 10) + '...',
            registered: node.peerId,
            current: peerId,
            match: node.peerId === peerId,
            active: node.active
          });
          
          if (node.peerId === peerId && node.active) {
            logger.info('Found matching peer ID registration', { nodeId, peerId: peerId.slice(0, 12) + '...' });
            return nodeId;
          }
        } catch (error: any) {
          logger.warn('Failed to fetch node for comparison', { nodeId: nodeId.slice(0, 10) + '...', error: error.message });
          continue;
        }
      }
      
      logger.warn('No matching peer ID found in registry', { peerId: peerId.slice(0, 12) + '...' });
      return null;
    } catch (error) {
      logger.warn('Failed to get node by peer ID', { peerId: peerId.slice(0, 12) + '...', error });
      return null;
    }
  }

  /**
   * Get all active nodes
   */
  async getActiveNodes(): Promise<string[]> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const nodeIds = await this.nodeRegistry.getActiveNodes();
      return nodeIds;
    } catch (error: any) {
      logger.error('Failed to get active nodes', error);
      return [];
    }
  }

  /**
   * Get all nodes with pagination
   */
  async getAllNodes(offset = 0, limit = 100): Promise<string[]> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const nodeIds = await this.nodeRegistry.getAllNodes(offset, limit);
      return nodeIds;
    } catch (error: any) {
      logger.error('Failed to get all nodes', error);
      return [];
    }
  }

  /**
   * Get node count
   */
  async getNodeCount(): Promise<{ total: number; active: number }> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const [total, active] = await this.nodeRegistry.getNodeCount();
      return {
        total: Number(total),
        active: Number(active)
      };
    } catch (error: any) {
      logger.error('Failed to get node count', error);
      return { total: 0, active: 0 };
    }
  }

  /**
   * Check if node is active
   */
  async isNodeActive(nodeId: string): Promise<boolean> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      return await this.nodeRegistry.isNodeActive(nodeId);
    } catch (error: any) {
      logger.error('Failed to check node active status', { nodeId, error: error.message });
      return false;
    }
  }

  /**
   * Get minimum required version from contract
   * Returns null if contract is not available or doesn't have minVersion set
   */
  async getMinVersion(): Promise<string | null> {
    if (!this.nodeRegistry) {
      logger.warn('Registry not initialized, cannot check min version');
      return null;
    }

    try {
      const version = await this.nodeRegistry.minVersion();
      // Empty string means not set
      if (!version || version === '') {
        return null;
      }
      return version;
    } catch (error: any) {
      logger.warn('Failed to get min version from contract', { error: error.message });
      return null;
    }
  }

  /**
   * Get network-wide replication factor from contract
   * Returns 0 if contract is not available or not set
   */
  async getReplicationFactor(): Promise<number> {
    if (!this.nodeRegistry) {
      logger.warn('Registry not initialized, cannot get replication factor');
      return 0;
    }

    try {
      const factor = await this.nodeRegistry.replicationFactor();
      const factorNum = Number(factor);
      
      if (factorNum === 0) {
        logger.warn('Replication factor not set in contract');
        return 0;
      }
      
      logger.info('Replication factor from contract', { factor: factorNum });
      return factorNum;
    } catch (error: any) {
      logger.error('Failed to get replication factor from contract', { error: error.message });
      return 0;
    }
  }

  /**
   * Register a new node (requires signer)
   */
  async registerNode(
    publicKey: string,
    peerId: string,
    metadataHash: string,
    stakeAmount: bigint,
    signature: string
  ): Promise<string | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');
    if (!this.signer) throw new Error('Signer required for registration');

    try {
      const tx = await this.nodeRegistry.registerNode(publicKey, peerId, metadataHash, stakeAmount, signature);
      const receipt = await tx.wait();

      // Extract nodeId from event
      const event = receipt.logs
        .map((log: any) => {
          try {
            return this.nodeRegistry!.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e && e.name === 'NodeRegistered');

      if (event) {
        const nodeId = event.args.nodeId;
        logger.info('Node registered', { nodeId, peerId });
        return nodeId;
      }

      return null;
    } catch (error: any) {
      logger.error('Failed to register node', { message: error.message, stack: error.stack });
      throw error;
    }
  }

  /**
   * Update node metadata (requires signer)
   */
  async updateNode(peerId: string, metadataHash: string): Promise<boolean> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');
    if (!this.signer) throw new Error('Signer required for update');

    try {
      const tx = await this.nodeRegistry.updateNode(peerId, metadataHash);
      await tx.wait();
      logger.info('Node updated', { peerId });
      return true;
    } catch (error: any) {
      logger.error('Failed to update node', error);
      return false;
    }
  }

  /**
   * Unregister node (requires signer)
   */
  async unregisterNode(): Promise<boolean> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');
    if (!this.signer) throw new Error('Signer required for unregistration');

    try {
      const tx = await this.nodeRegistry.unregisterNode();
      await tx.wait();
      logger.info('Node unregistered');
      return true;
    } catch (error: any) {
      logger.error('Failed to unregister node', error);
      return false;
    }
  }

  // ============================================
  // INCENTIVES METHODS (Optional)
  // ============================================

  /**
   * Check if incentives are enabled
   */
  async incentivesEnabled(): Promise<boolean> {
    if (!this.incentives) return false;

    try {
      return await this.incentives.incentivesEnabled();
    } catch (error: any) {
      return false;
    }
  }

  /**
   * Get node reputation
   */
  async getReputation(nodeId: string): Promise<NodeReputation | null> {
    if (!this.incentives) return null;

    try {
      const rep = await this.incentives.getReputation(nodeId);
      return {
        totalProofs: rep.totalProofs,
        validProofs: rep.validProofs,
        invalidProofs: rep.invalidProofs,
        missedProofs: rep.missedProofs,
        lastActiveBlock: rep.lastActiveBlock,
        reliabilityScore: rep.reliabilityScore,
        blacklisted: rep.blacklisted
      };
    } catch (error: any) {
      logger.error('Failed to get reputation', { nodeId, error: error.message });
      return null;
    }
  }

  /**
   * Check if node can submit proofs
   */
  async canSubmitProof(nodeId: string): Promise<boolean> {
    if (!this.incentives) return false;

    try {
      return await this.incentives.canSubmitProof(nodeId);
    } catch (error: any) {
      return false;
    }
  }

  /**
   * Get claimable rewards
   */
  async getClaimableRewards(nodeId: string): Promise<bigint> {
    if (!this.incentives) return BigInt(0);

    try {
      return await this.incentives.getClaimableRewards(nodeId);
    } catch (error: any) {
      return BigInt(0);
    }
  }

  /**
   * Submit storage proof (requires signer)
   */
  async submitProof(
    nodeId: string,
    cid: string,
    timestamp: number,
    challenge: string,
    signature: string
  ): Promise<boolean> {
    if (!this.incentives) throw new Error('Incentives not configured');
    if (!this.signer) throw new Error('Signer required for proof submission');

    try {
      const tx = await this.incentives.submitProof(
        nodeId,
        cid,
        timestamp,
        challenge,
        signature
      );
      await tx.wait();
      logger.info('Proof submitted', { nodeId, cid });
      return true;
    } catch (error: any) {
      logger.error('Failed to submit proof', error);
      return false;
    }
  }

  /**
   * Claim rewards (requires signer)
   */
  async claimRewards(nodeId: string): Promise<boolean> {
    if (!this.incentives) throw new Error('Incentives not configured');
    if (!this.signer) throw new Error('Signer required for claiming');

    try {
      const tx = await this.incentives.claimRewards(nodeId);
      await tx.wait();
      logger.info('Rewards claimed', { nodeId });
      return true;
    } catch (error: any) {
      logger.error('Failed to claim rewards', error);
      return false;
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    if (!this.provider) return 0;
    return await this.provider.getBlockNumber();
  }

  /**
   * Get signer address
   */
  async getSignerAddress(): Promise<string | null> {
    if (!this.signer) return null;
    return await this.signer.getAddress();
  }

  // ============================================
  // CONTENT REGISTRY METHODS
  // ============================================

  /**
   * Verify if a CID is registered on-chain
   * Used during replication 
   */
  async isContentRegistered(cid: string): Promise<boolean> {
    if (!this.contentRegistry) {
      logger.warn('[CONTRACT] ContentRegistry not configured - skipping CID verification');
      return false;
    }

    try {
      // CID is already a SHA-256 hash (bytes32), just add 0x prefix
      const cidBytes32 = '0x' + cid;
      const isRegistered = await this.contentRegistry.isContentRegistered(cidBytes32);
      return isRegistered;
    } catch (error: any) {
      logger.error('[CONTRACT] Failed to verify CID registration', { cid, error: error.message });
      return false;
    }
  }

  /**
   * Get content record from ContentRegistry
   */
  async getContentRecord(cid: string): Promise<{ owner: string; appId: string; timestamp: number } | null> {
    if (!this.contentRegistry) {
      logger.warn('[CONTRACT] ContentRegistry not configured');
      return null;
    }

    try {
      // CID is already a SHA-256 hash (bytes32), just add 0x prefix
      const cidBytes32 = '0x' + cid;
      const record = await this.contentRegistry.getContentRecord(cidBytes32);
      
      // Check if owner is zero address (content doesn't exist)
      if (record.owner === '0x0000000000000000000000000000000000000000') {
        return null;
      }
      
      return {
        owner: record.owner,
        appId: record.appId,
        timestamp: Number(record.timestamp)
      };
    } catch (error: any) {
      logger.error('[CONTRACT] Failed to get content record', { cid, error: error.message });
      return null;
    }
  }

  /**
   * Verify content is registered in ContentRegistry and check app authorization
   * Returns the appId if registered and authorized, null otherwise
   */
  async verifyContentRegistration(cid: string, allowedApps?: string[]): Promise<{ 
    authorized: boolean; 
    appId?: string; 
    error?: string 
  }> {
    if (!this.contentRegistry) {
      return { 
        authorized: false, 
        error: 'ContentRegistry not configured' 
      };
    }

    try {
      // Check if content is registered
      const isRegistered = await this.isContentRegistered(cid);
      
      if (!isRegistered) {
        return { 
          authorized: false, 
          error: 'Content not registered in ContentRegistry' 
        };
      }

      // Get the content record to check appId
      const record = await this.getContentRecord(cid);
      
      if (!record) {
        return { 
          authorized: false, 
          error: 'Could not retrieve content record' 
        };
      }

      // If allowedApps filter is set, verify appId is in the list
      // Note: record.appId is a bytes32 hash, so we need to hash the allowedApps for comparison
      if (allowedApps && allowedApps.length > 0) {
        const allowedAppHashes = appIdsToBytes32(allowedApps);
        
        if (!allowedAppHashes.includes(record.appId)) {
          return { 
            authorized: false, 
            appId: record.appId,
            error: `App '${record.appId}' not in allowed list` 
          };
        }
      }

      // All checks passed
      return { 
        authorized: true, 
        appId: record.appId 
      };
    } catch (error: any) {
      logger.error('[CONTRACT] Content verification failed', { cid, error: error.message });
      return { 
        authorized: false, 
        error: `Verification failed: ${error.message}` 
      };
    }
  }

  /**
   * Listen for node registration events
   */
  onNodeRegistered(callback: (nodeId: string, owner: string) => void): void {
    if (!this.nodeRegistry) {
      logger.warn('[CONTRACT] Cannot set up NodeRegistered listener - nodeRegistry not initialized');
      return;
    }

    logger.info('[CONTRACT] Setting up NodeRegistered event listener on contract');
    this.nodeRegistry.on('NodeRegistered', (nodeId, owner) => {
      logger.info('[CONTRACT] NodeRegistered event received from blockchain', {
        nodeId: nodeId.slice(0, 16) + '...',
        owner: owner.slice(0, 10) + '...'
      });
      callback(nodeId, owner);
    });
    logger.info('[CONTRACT] NodeRegistered listener attached successfully');
  }

  /**
   * Listen for proof submission events
   */
  onProofSubmitted(callback: (nodeId: string, cid: string, valid: boolean) => void): void {
    if (!this.incentives) return;

    this.incentives.on('ProofSubmitted', (nodeId, cid, valid) => {
      callback(nodeId, cid, valid);
    });
  }

  /**
   * Stop listening to events
   */
  removeAllListeners(): void {
    this.nodeRegistry?.removeAllListeners();
    this.incentives?.removeAllListeners();
  }
}

export const contractIntegrationService = new ContractIntegrationService();
