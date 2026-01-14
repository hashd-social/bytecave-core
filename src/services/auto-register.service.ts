/**
 * Auto-Registration Service
 * Handles automatic on-chain registration/deregistration on node startup
 */

import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export class AutoRegisterService {
  private static instance: AutoRegisterService;

  private constructor() {}

  static getInstance(): AutoRegisterService {
    if (!AutoRegisterService.instance) {
      AutoRegisterService.instance = new AutoRegisterService();
    }
    return AutoRegisterService.instance;
  }

  /**
   * Perform auto-registration or deregistration based on config
   * Called after P2P service has started and peer ID is available
   */
  async handleAutoRegistration(peerId: string, publicKeyHex: string): Promise<void> {
    // Check if auto-registration is configured
    if (config.autoRegisterOnChain === undefined) {
      logger.info('Auto-registration not configured (REGISTER_ON_CHAIN not set)');
      return;
    }

    // Validate required config
    if (!config.privateKey) {
      logger.error('Auto-registration failed: PRIVATE_KEY not configured');
      return;
    }

    if (!config.registryAddress) {
      logger.error('Auto-registration failed: VAULT_REGISTRY_ADDRESS not configured');
      return;
    }

    if (!config.hashdTokenAddress) {
      logger.error('Auto-registration failed: HASHD_TOKEN_ADDRESS not configured');
      return;
    }

    if (config.autoRegisterOnChain) {
      await this.autoRegister(peerId, publicKeyHex);
    } else {
      await this.autoDeregister();
    }
  }

  /**
   * Auto-register node on-chain
   */
  private async autoRegister(peerId: string, publicKeyHex: string): Promise<void> {
    logger.info('🔄 Auto-registration enabled - registering node on-chain...');
    logger.warn('⚠️  This will stake 1000 HASHD tokens from the configured wallet');

    try {
      // Connect to blockchain
      const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
        staticNetwork: true,
        batchMaxCount: 1
      });
      const wallet = new ethers.Wallet(config.privateKey, provider);

      logger.info(`Wallet address: ${wallet.address}`);

      // Get HASHD token contract
      const hashdAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function balanceOf(address owner) view returns (uint256)'
      ];
      const hashd = new ethers.Contract(config.hashdTokenAddress, hashdAbi, wallet);

      // Check balance
      const balance = await hashd.balanceOf(wallet.address);
      const stakeAmount = ethers.parseEther('1000');
      
      if (balance < stakeAmount) {
        logger.error(`Insufficient HASHD balance: ${ethers.formatEther(balance)} HASHD (need 1000 HASHD)`);
        return;
      }

      logger.info(`HASHD balance: ${ethers.formatEther(balance)} HASHD`);

      // Get registry contract
      const registryAbi = [
        'function registerNode(bytes publicKey, string peerId, bytes32 metadataHash, uint256 stakeAmount, bytes signature) returns (bytes32)',
        'function getNodeByOwner(address owner) view returns (bytes32)',
        'function getNode(bytes32 nodeId) view returns (tuple(address owner, bytes publicKey, string peerId, bytes32 metadataHash, uint256 stakedAmount, uint256 registeredAt, bool active))'
      ];
      const registry = new ethers.Contract(config.registryAddress, registryAbi, wallet);

      // Check if already registered
      try {
        const existingNodeId = await registry.getNodeByOwner(wallet.address);
        if (existingNodeId !== ethers.ZeroHash) {
          const nodeInfo = await registry.getNode(existingNodeId);
          if (nodeInfo.active) {
            logger.info(`✅ Node already registered on-chain (nodeId: ${existingNodeId.slice(0, 16)}...)`);
            return;
          }
        }
      } catch (error: any) {
        // Node not registered yet - this is expected, continue with registration
        logger.info('Node not yet registered, proceeding with registration...');
      }

      // Approve tokens if needed
      const currentAllowance = await hashd.allowance(wallet.address, config.registryAddress);
      if (currentAllowance < stakeAmount) {
        logger.info('Approving HASHD tokens for registry...');
        const approveTx = await hashd.approve(config.registryAddress, stakeAmount);
        await approveTx.wait();
        logger.info('Token approval confirmed');
        
        // Wait for blockchain to update
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Create metadata hash
      const metadata = {
        version: '1.0.0',
        capabilities: ['storage', 'replication'],
        timestamp: Date.now()
      };
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(metadata)));

      // Empty signature (not enforced yet)
      const emptySignature = '0x';

      // Get fresh nonce
      const nonce = await provider.getTransactionCount(wallet.address, 'latest');

      logger.info('Submitting registration transaction...', {
        peerId: peerId.slice(0, 16) + '...',
        publicKey: publicKeyHex.slice(0, 16) + '...',
        stakeAmount: '1000 HASHD',
        nonce
      });

      // Register node
      const tx = await registry.registerNode(
        publicKeyHex,
        peerId,
        metadataHash,
        stakeAmount,
        emptySignature,
        { nonce }
      );

      logger.info(`Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      logger.info(`✅ Node registered successfully! (tx: ${receipt.hash})`);
      logger.info(`   Staked: 1000 HASHD tokens`);

    } catch (error: any) {
      logger.error('Auto-registration failed:', error.message);
      if (error.data) {
        logger.error('Error data:', error.data);
      }
    }
  }

  /**
   * Auto-deregister node from chain
   */
  private async autoDeregister(): Promise<void> {
    logger.info('🔄 Auto-deregistration enabled - deregistering node from chain...');
    logger.info('⚠️  This will return staked HASHD tokens to the wallet');

    try {
      // Connect to blockchain
      const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
        staticNetwork: true,
        batchMaxCount: 1
      });
      const wallet = new ethers.Wallet(config.privateKey, provider);

      logger.info(`Wallet address: ${wallet.address}`);

      // Get registry contract
      const registryAbi = [
        'function deregisterNode() returns (bool)',
        'function getNodeByOwner(address owner) view returns (bytes32)',
        'function getNode(bytes32 nodeId) view returns (tuple(address owner, bytes publicKey, string peerId, bytes32 metadataHash, uint256 stakedAmount, uint256 registeredAt, bool active))'
      ];
      const registry = new ethers.Contract(config.registryAddress, registryAbi, wallet);

      // Check if registered
      const nodeId = await registry.getNodeByOwner(wallet.address);
      if (nodeId === ethers.ZeroHash) {
        logger.info('Node is not registered on-chain (nothing to deregister)');
        return;
      }

      const nodeInfo = await registry.getNode(nodeId);
      if (!nodeInfo.active) {
        logger.info('Node is already deregistered');
        return;
      }

      logger.info(`Deregistering node (nodeId: ${nodeId.slice(0, 16)}...)`);
      logger.info(`Will return ${ethers.formatEther(nodeInfo.stakedAmount)} HASHD tokens`);

      // Deregister
      const tx = await registry.deregisterNode();
      logger.info(`Transaction sent: ${tx.hash}`);
      
      const receipt = await tx.wait();
      logger.info(`✅ Node deregistered successfully! (tx: ${receipt.hash})`);
      logger.info(`   Returned: ${ethers.formatEther(nodeInfo.stakedAmount)} HASHD tokens`);

    } catch (error: any) {
      logger.error('Auto-deregistration failed:', error.message);
      if (error.data) {
        logger.error('Error data:', error.data);
      }
    }
  }
}

export const autoRegisterService = AutoRegisterService.getInstance();
