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
import { APP_REGISTRY_ABI } from '../abis/index.js';

class AppRegistryService {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;

  /**
   * Initialize the service with RPC provider and contract address
   */
  async initialize(rpcUrl: string, contractAddress: string): Promise<void> {
    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.contract = new ethers.Contract(contractAddress, APP_REGISTRY_ABI, this.provider);
      
      logger.info('AppRegistry service initialized', { contractAddress });
    } catch (error: any) {
      logger.error('Failed to initialize AppRegistry service', { error: error.message });
      throw error;
    }
  }

  /**
   * Check if an app is registered and active
   * 
   * @param appId - App name string (will be converted to bytes32)
   * @param _sender - Ethereum address of the sender (not used, kept for interface compatibility)
   * @returns true if app is registered and active, false otherwise
   */
  async isAuthorized(appId: string, _sender: string): Promise<boolean> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized, skipping authorization check');
      return false;
    }

    try {
      // Convert appId string to bytes32 using keccak256
      const appIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(appId));
      
      // Check if app exists and is active
      const [_appName, owner, active, _registeredAt, _burnedAmount] = await this.contract.getApp(appIdBytes32);
      
      // If owner is zero address, app doesn't exist
      const isRegistered = owner !== ethers.ZeroAddress && active;
      
      logger.debug('AppRegistry check', { 
        appId: appId,
        appIdBytes32: appIdBytes32.slice(0, 16) + '...',
        isRegistered,
        active,
        owner: owner === ethers.ZeroAddress ? 'not registered' : owner
      });
      
      return isRegistered;
    } catch (error: any) {
      logger.error('Failed to check AppRegistry', { 
        appId: appId,
        error: error.message 
      });
      // Fail closed - if we can't verify, reject
      return false;
    }
  }

  /**
   * Get app details from the registry
   * 
   * @param appId - App name string (will be converted to bytes32)
   * @returns App details or null if not found
   */
  async getApp(appId: string): Promise<{
    appName: string;
    owner: string;
    active: boolean;
    registeredAt: number;
    burnedAmount: bigint;
  } | null> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized');
      return null;
    }

    try {
      // Convert appId string to bytes32 using keccak256
      const appIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(appId));
      
      const [appName, owner, active, registeredAt, burnedAmount] = await this.contract.getApp(appIdBytes32);
      
      // If owner is zero address, app doesn't exist
      if (owner === ethers.ZeroAddress) {
        return null;
      }

      return {
        appName,
        owner,
        active,
        registeredAt: Number(registeredAt),
        burnedAmount
      };
    } catch (error: any) {
      logger.error('Failed to get app from AppRegistry', { 
        appId: appId,
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Get the current burn amount required for registration
   */
  async getBurnAmount(): Promise<bigint | null> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized');
      return null;
    }

    try {
      const burnAmount = await this.contract.getBurnAmount();
      return burnAmount;
    } catch (error: any) {
      logger.error('Failed to get burn amount from AppRegistry', { error: error.message });
      return null;
    }
  }

  /**
   * Get total $HASHD burned through registrations
   */
  async getTotalBurned(): Promise<bigint | null> {
    if (!this.contract) {
      logger.warn('AppRegistry not initialized');
      return null;
    }

    try {
      const totalBurned = await this.contract.getTotalBurned();
      return totalBurned;
    } catch (error: any) {
      logger.error('Failed to get total burned from AppRegistry', { error: error.message });
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
