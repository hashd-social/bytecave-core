/**
 * ByteCave - NordVPN Meshnet Service
 * Provides VPN-friendly P2P connection fallbacks using NordVPN Meshnet hostnames
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

/**
 * Service for handling NordVPN Meshnet hostname fallbacks
 * Allows nodes behind VPNs to connect directly via Meshnet
 */
class MeshnetService {
  /**
   * Add Meshnet hostname as fallback multiaddr if configured
   * @param peerId - Peer ID to add fallback for
   * @param multiaddrs - Existing multiaddrs
   * @returns Enhanced multiaddrs with Meshnet fallback if available
   */
  addMeshnetFallback(peerId: string, multiaddrs: string[]): string[] {
    if (!config.meshnetAddress) {
      return multiaddrs;
    }

    // Check if we already have a Meshnet address
    const hasMeshnet = multiaddrs.some(addr => addr.includes(config.meshnetAddress!));
    if (hasMeshnet) {
      return multiaddrs;
    }

    // Add Meshnet fallback addresses
    // Format: /dns4/{meshnet-hostname}/tcp/{port}/p2p/{peerId}
    const meshnetAddrs = [
      `/dns4/${config.meshnetAddress}/tcp/4001/p2p/${peerId}`,
      `/dns4/${config.meshnetAddress}/tcp/4001/ws/p2p/${peerId}`
    ];

    logger.debug('Adding Meshnet fallback addresses', {
      peerId: peerId.substring(0, 8),
      meshnetAddress: config.meshnetAddress,
      addedAddrs: meshnetAddrs.length
    });

    return [...multiaddrs, ...meshnetAddrs];
  }

  /**
   * Check if Meshnet is configured
   */
  isConfigured(): boolean {
    return !!config.meshnetAddress;
  }

  /**
   * Get the configured Meshnet hostname
   */
  getMeshnetAddress(): string | undefined {
    return config.meshnetAddress;
  }
}

export const meshnetService = new MeshnetService();
