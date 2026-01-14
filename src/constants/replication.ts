/**
 * Replication Constants
 * 
 * Replication factor is read from the VaultNodesRegistry contract.
 * This allows the network owner to adjust replication dynamically.
 */

/**
 * Cached replication factor from contract
 * This is updated periodically by the replication service
 * Initialized to 0 until first fetch from contract
 */
let cachedReplicationFactor: number = 0;

/**
 * Get current replication factor
 * Returns cached value from contract (0 if not yet fetched)
 */
export function getReplicationFactor(): number {
  return cachedReplicationFactor;
}

/**
 * Update cached replication factor
 * Called by replication service when fetching from contract
 */
export function updateReplicationFactor(factor: number): void {
  if (factor >= 3) {
    cachedReplicationFactor = factor;
  }
}

/**
 * Default replication timeout in milliseconds
 * 
 * How long to wait for replication requests to complete
 * before considering them failed.
 * 
 * @constant {number}
 */
export const REPLICATION_TIMEOUT_MS = 5000;
