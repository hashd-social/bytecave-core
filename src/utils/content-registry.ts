/**
 * ByteCave - ContentRegistry Utilities
 * Helper functions for ContentRegistry interactions
 */

import { ethers } from 'ethers';

/**
 * Convert a CID string to bytes32 hash for ContentRegistry
 * This matches the contract's hashing: keccak256(abi.encodePacked(cid))
 */
export function cidToBytes32(cid: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(cid));
}

/**
 * Convert an appId string to bytes32 hash for ContentRegistry
 * This matches the contract's hashing: keccak256(abi.encodePacked(appId))
 */
export function appIdToBytes32(appId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(appId));
}

/**
 * Convert multiple appIds to bytes32 hashes
 * Useful for comparing allowedApps lists with on-chain appId hashes
 */
export function appIdsToBytes32(appIds: string[]): string[] {
  return appIds.map(appId => appIdToBytes32(appId));
}
