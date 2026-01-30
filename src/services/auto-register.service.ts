/**
 * Auto-Registration Service
 * Handles automatic on-chain registration/deregistration on node startup
 */

import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { contractIntegrationService } from './contract-integration.service.js';
import { storageWebSocketService } from './storage-websocket.service.js';
import { HASHD_TOKEN_ABI } from '../abis/index.js';

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
  async handleAutoRegistration(peerId: string, publicKeyHex: string, p2pService?: any): Promise<void> {
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
      await this.autoRegister(peerId, publicKeyHex, p2pService);
    } else {
      await this.autoDeregister(p2pService);
    }
  }

  /**
   * Auto-register node on-chain
   */
  private async autoRegister(peerId: string, publicKeyHex: string, p2pService?: any): Promise<void> {
    logger.info('🔄 Auto-registration enabled - registering node on-chain...');
    logger.warn('⚠️  This will stake 1000 HASHD tokens from the configured wallet');

    try {
      // Initialize contract integration service if not already done
      if (!contractIntegrationService.isInitialized()) {
        await contractIntegrationService.initialize({
          rpcUrl: config.rpcUrl,
          privateKey: config.privateKey,
          registryAddress: config.registryAddress,
          incentivesAddress: process.env.VAULT_INCENTIVES_ADDRESS
        });
      }

      const signerAddress = await contractIntegrationService.getSignerAddress();
      if (!signerAddress) {
        logger.error('No signer configured for auto-registration');
        return;
      }

      logger.info(`Wallet address: ${signerAddress}`);

      // Connect to blockchain for token operations
      const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, {
        staticNetwork: true,
        batchMaxCount: 1
      });
      const wallet = new ethers.Wallet(config.privateKey, provider);

      // Get HASHD token contract
      const hashd = new ethers.Contract(config.hashdTokenAddress, HASHD_TOKEN_ABI, wallet);

      // Check balance
      const balance = await hashd.balanceOf(wallet.address);
      const stakeAmount = ethers.parseEther('1000');
      
      if (balance < stakeAmount) {
        logger.error(`Insufficient HASHD balance: ${ethers.formatEther(balance)} HASHD (need 1000 HASHD)`);
        return;
      }

      logger.info(`HASHD balance: ${ethers.formatEther(balance)} HASHD`);

      // Check if already registered using contract integration service
      const existingNodeId = await contractIntegrationService.getNodeByOwner(wallet.address);
      if (existingNodeId) {
        const nodeInfo = await contractIntegrationService.getNode(existingNodeId);
        if (nodeInfo && nodeInfo.active) {
          logger.info(`✅ Node already registered on-chain (nodeId: ${existingNodeId.slice(0, 16)}...)`);
          return;
        }
      }

      // Approve tokens if needed
      let currentAllowance;
      try {
        logger.info('Checking current allowance...', {
          owner: wallet.address,
          spender: config.registryAddress,
          hashdToken: config.hashdTokenAddress
        });
        currentAllowance = await hashd.allowance(wallet.address, config.registryAddress);
        logger.info(`Current allowance: ${ethers.formatEther(currentAllowance)} HASHD`);
      } catch (error: any) {
        logger.error('Failed to check allowance, will attempt approval anyway', {
          error: error.message,
          code: error.code,
          data: error.data
        });
        // Assume zero allowance if check fails
        currentAllowance = 0n;
      }
      
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

      // Generate signature with wallet (node operator's Ethereum account)
      // Contract validates that signature comes from the wallet calling registerNode
      const messageHash = ethers.keccak256(ethers.solidityPacked(['address'], [wallet.address]));
      const signature = await wallet.signMessage(ethers.getBytes(messageHash));

      logger.info('Submitting registration transaction...', {
        peerId: peerId.slice(0, 16) + '...',
        publicKey: publicKeyHex.slice(0, 16) + '...',
        stakeAmount: '1000 HASHD'
      });

      // Register node using contract integration service
      const nodeId = await contractIntegrationService.registerNode(
        publicKeyHex,
        peerId,
        metadataHash,
        stakeAmount,
        signature
      );

      if (nodeId) {
        logger.info(`✅ Node registered successfully! (nodeId: ${nodeId.slice(0, 16)}...)`);
        logger.info(`   Staked: 1000 HASHD tokens`);
        
        // Update relay with new registration status
        storageWebSocketService.updateRegistrationStatus(true);
        logger.info('📡 Updated relay with registration status');
        
        // Announce immediately so network knows about registration
        if (p2pService) {
          p2pService.announce();
          logger.info('📢 Announced registration to network');
        }
      } else {
        logger.error('Registration failed: no nodeId returned');
      }

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
  private async autoDeregister(p2pService?: any): Promise<void> {
    logger.info('🔄 Auto-deregistration enabled - deregistering node from chain...');
    logger.info('⚠️  This will return staked HASHD tokens to the wallet');

    try {
      // Initialize contract integration service if not already done
      if (!contractIntegrationService.isInitialized()) {
        await contractIntegrationService.initialize({
          rpcUrl: config.rpcUrl,
          privateKey: config.privateKey,
          registryAddress: config.registryAddress,
          incentivesAddress: process.env.VAULT_INCENTIVES_ADDRESS
        });
      }

      const signerAddress = await contractIntegrationService.getSignerAddress();
      if (!signerAddress) {
        logger.error('No signer configured for auto-deregistration');
        return;
      }

      logger.info(`Wallet address: ${signerAddress}`);

      // Calculate nodeId from secp256k1 public key (same as registration)
      const { getNodePublicKey } = await import('../utils/node-id.js');
      const { calculateNodeId } = await import('../utils/node-id.js');
      
      const publicKey = await getNodePublicKey();
      if (!publicKey) {
        logger.error('Cannot deregister: No secp256k1 public key available');
        return;
      }
      
      const nodeId = calculateNodeId(publicKey);
      logger.info(`Calculated nodeId from public key: ${nodeId.slice(0, 16)}...`);

      // Check if this nodeId is registered
      const nodeInfo = await contractIntegrationService.getNode(nodeId);
      if (!nodeInfo || !nodeInfo.active) {
        logger.info('Node is not registered on-chain (nothing to deregister)');
        return;
      }

      logger.info(`Deregistering node (nodeId: ${nodeId.slice(0, 16)}...)`);

      // Deregister using contract integration service (unregisterNode doesn't take nodeId)
      const success = await contractIntegrationService.unregisterNode();

      if (success) {
        logger.info(`✅ Node deregistered successfully!`);
        logger.info(`   Staked tokens returned to wallet`);
        
        // Announce immediately so network knows about deregistration
        if (p2pService) {
          p2pService.announce();
          logger.info('📢 Announced deregistration to network');
        }
      } else {
        logger.error('Deregistration failed');
      }

    } catch (error: any) {
      logger.error('Auto-deregistration failed:', error.message);
      if (error.data) {
        logger.error('Error data:', error.data);
      }
    }
  }
}

export const autoRegisterService = AutoRegisterService.getInstance();
