/**
 * Node ID Calculation Utilities
 * 
 * Provides consistent nodeId calculation across the codebase.
 * The nodeId is derived from the secp256k1 public key using keccak256.
 */

import { ethers } from 'ethers';

/**
 * Calculate nodeId from secp256k1 public key
 * 
 * @param secp256k1PublicKey - 64-byte uncompressed secp256k1 public key (hex string with 0x prefix)
 * @returns nodeId - keccak256 hash of the public key
 */
export function calculateNodeId(secp256k1PublicKey: string): string {
  if (!secp256k1PublicKey.startsWith('0x')) {
    throw new Error('Public key must start with 0x');
  }
  
  // Remove 0x prefix and check length
  const pubKeyHex = secp256k1PublicKey.slice(2);
  if (pubKeyHex.length !== 128) { // 64 bytes = 128 hex chars
    throw new Error(`Invalid public key length: expected 128 hex chars (64 bytes), got ${pubKeyHex.length}`);
  }
  
  return ethers.keccak256(secp256k1PublicKey);
}

/**
 * Get the secp256k1 public key from the P2P service
 * This is the canonical source for the node's public key
 */
export async function getNodePublicKey(): Promise<string | null> {
  try {
    const { p2pService } = await import('../services/p2p.service.js');
    return p2pService.getSecp256k1PublicKey();
  } catch {
    return null;
  }
}

/**
 * Calculate this node's nodeId using the P2P service's secp256k1 public key
 */
export async function getThisNodeId(): Promise<string | null> {
  const publicKey = await getNodePublicKey();
  if (!publicKey) {
    return null;
  }
  return calculateNodeId(publicKey);
}
