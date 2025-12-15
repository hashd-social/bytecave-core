/**
 * HASHD Vault - Contract Integration Service
 * 
 * Bridges vault services with on-chain smart contracts:
 * - VaultNodeRegistry (node registration & discovery)
 * - VaultIncentives (optional rewards & reputation)
 * - Guild contracts (posting rules & allowlists)
 */

import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

// ABI fragments for the contracts we need
const NODE_REGISTRY_ABI = [
  'function getNode(bytes32 nodeId) view returns (tuple(address owner, bytes publicKey, string url, bytes32 metadataHash, uint256 registeredAt, bool active))',
  'function getAllNodes(uint256 offset, uint256 limit) view returns (bytes32[])',
  'function getActiveNodes() view returns (bytes32[])',
  'function getNodeByOwner(address owner) view returns (bytes32)',
  'function isNodeActive(bytes32 nodeId) view returns (bool)',
  'function getNodeCount() view returns (uint256 total, uint256 active)',
  'function registerNode(bytes publicKey, string url, bytes32 metadataHash) returns (bytes32)',
  'function updateNode(string url, bytes32 metadataHash)',
  'function unregisterNode()',
  'event NodeRegistered(bytes32 indexed nodeId, address indexed owner)',
  'event NodeUpdated(bytes32 indexed nodeId)',
  'event NodeUnregistered(bytes32 indexed nodeId)'
];

const INCENTIVES_ABI = [
  'function getReputation(bytes32 nodeId) view returns (tuple(uint256 totalProofs, uint256 validProofs, uint256 invalidProofs, uint256 missedProofs, uint256 lastActiveBlock, uint256 reliabilityScore, bool blacklisted))',
  'function canSubmitProof(bytes32 nodeId) view returns (bool)',
  'function getClaimableRewards(bytes32 nodeId) view returns (uint256)',
  'function submitProof(bytes32 nodeId, bytes32 cid, uint256 timestamp, bytes32 challenge, bytes signature)',
  'function claimRewards(bytes32 nodeId)',
  'function incentivesEnabled() view returns (bool)',
  'event ProofSubmitted(bytes32 indexed nodeId, bytes32 indexed cid, bool valid)',
  'event RewardsClaimed(bytes32 indexed nodeId, uint256 amount)'
];

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

  /**
   * Initialize contract integration
   */
  async initialize(config: {
    rpcUrl: string;
    privateKey?: string;
    registryAddress: string;
    incentivesAddress?: string;
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

      logger.info('Contract integration initialized', {
        registry: config.registryAddress,
        incentives: config.incentivesAddress || 'not configured'
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
  async getNode(nodeId: string): Promise<NodeInfo | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');

    try {
      const node = await this.nodeRegistry.getNode(nodeId);
      
      return {
        nodeId,
        owner: node.owner,
        publicKey: node.publicKey,
        url: node.url,
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
   * Register a new node (requires signer)
   */
  async registerNode(
    publicKey: string,
    url: string,
    metadataHash: string
  ): Promise<string | null> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');
    if (!this.signer) throw new Error('Signer required for registration');

    try {
      const tx = await this.nodeRegistry.registerNode(publicKey, url, metadataHash);
      const receipt = await tx.wait();

      // Extract nodeId from event
      const event = receipt.logs.find((log: any) => {
        try {
          const parsed = this.nodeRegistry!.interface.parseLog(log);
          return parsed?.name === 'NodeRegistered';
        } catch {
          return false;
        }
      });

      if (event) {
        const parsed = this.nodeRegistry.interface.parseLog(event);
        const nodeId = parsed?.args.nodeId;
        logger.info('Node registered', { nodeId, url });
        return nodeId;
      }

      return null;
    } catch (error: any) {
      logger.error('Failed to register node', error);
      throw error;
    }
  }

  /**
   * Update node metadata (requires signer)
   */
  async updateNode(url: string, metadataHash: string): Promise<boolean> {
    if (!this.nodeRegistry) throw new Error('Registry not initialized');
    if (!this.signer) throw new Error('Signer required for update');

    try {
      const tx = await this.nodeRegistry.updateNode(url, metadataHash);
      await tx.wait();
      logger.info('Node updated', { url });
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

  /**
   * Listen for node registration events
   */
  onNodeRegistered(callback: (nodeId: string, owner: string) => void): void {
    if (!this.nodeRegistry) return;

    this.nodeRegistry.on('NodeRegistered', (nodeId, owner) => {
      callback(nodeId, owner);
    });
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
