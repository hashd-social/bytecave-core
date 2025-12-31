/**
 * App Registry Service
 * 
 * Interacts with the AppRegistry contract to verify:
 * - App is registered
 * - Sender is authorized for the appId
 * 
 * Security: Prevents malicious actors from spoofing appIds
 */

import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

const APP_REGISTRY_ABI = [
  'function isAuthorized(bytes32 appId, address sender) external view returns (bool)',
  'function getApp(bytes32 appId) external view returns (string appName, address owner, bool active, uint256 registeredAt)',
  'function computeAppId(string appName) external pure returns (bytes32)'
];

class AppRegistryService {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private contractAddress: string | null = null;

  /**
   * Initialize the service with RPC provider and contract address
   */
  async initialize(rpcUrl: string, contractAddress: string): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.contractAddress = contractAddress;
      this.contract = new ethers.Contract(contractAddress, APP_REGISTRY_ABI, this.provider);
      
      logger.info('AppRegistry service initialized', { contractAddress });
    } catch (error: any) {
      logger.error('Failed to initialize AppRegistry service', { error: error.message });
      throw error;
    }
  }

  /**
   * Check if a sender is authorized to store data for an appId
   * 
   * @param appId - keccak256(appName)
   * @param sender - Ethereum address of the sender
   * @returns true if authorized, false otherwise
   */
  async isAuthorized(appId: string, sender: string): Promise<boolean> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized, skipping authorization check');
      return false;
    }

    try {
      const authorized = await this.contract.isAuthorized(appId, sender);
      logger.debug('AppRegistry authorization check', { 
        appId: appId.slice(0, 16) + '...',
        sender,
        authorized 
      });
      return authorized;
    } catch (error: any) {
      logger.error('Failed to check AppRegistry authorization', { 
        appId: appId.slice(0, 16) + '...',
        sender,
        error: error.message 
      });
      // Fail closed - if we can't verify, reject
      return false;
    }
  }

  /**
   * Get app details from the registry
   * 
   * @param appId - keccak256(appName)
   * @returns App details or null if not found
   */
  async getApp(appId: string): Promise<{
    appName: string;
    owner: string;
    active: boolean;
    registeredAt: number;
  } | null> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized');
      return null;
    }

    try {
      const [appName, owner, active, registeredAt] = await this.contract.getApp(appId);
      
      // If owner is zero address, app doesn't exist
      if (owner === ethers.ZeroAddress) {
        return null;
      }

      return {
        appName,
        owner,
        active,
        registeredAt: Number(registeredAt)
      };
    } catch (error: any) {
      logger.error('Failed to get app from AppRegistry', { 
        appId: appId.slice(0, 16) + '...',
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Compute appId from app name (client-side helper)
   * 
   * @param appName - Human-readable app name
   * @returns keccak256(appName)
   */
  computeAppId(appName: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(appName));
  }

  /**
   * Check if the service is initialized
   */
  isInitialized(): boolean {
    return this.contract !== null;
  }
}

// Singleton instance
export const appRegistryService = new AppRegistryService();
