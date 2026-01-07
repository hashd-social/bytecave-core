/**
 * Replication Constants
 * 
 * These are protocol-level constants that ensure consistent behavior
 * across all nodes in the ByteCave network.
 */

/**
 * Network-wide replication factor
 * 
 * All nodes maintain this many copies of each blob for redundancy.
 * This is a protocol constant to ensure:
 * - Consistent replication strategy across the network
 * - Predictable redundancy levels
 * - No coordination issues between nodes
 * - Efficient resource usage
 * 
 * @constant {number}
 */
export const REPLICATION_FACTOR = 3;

/**
 * Default replication timeout in milliseconds
 * 
 * How long to wait for replication requests to complete
 * before considering them failed.
 * 
 * @constant {number}
 */
export const REPLICATION_TIMEOUT_MS = 5000;
