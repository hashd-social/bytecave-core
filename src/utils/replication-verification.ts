/**
 * HASHD Vault - Replication Verification Utilities
 * 
 * Enhanced replication verification for GC (R8.7)
 * - Verify replicas are online
 * - Request and validate proofs from replicas
 * - Update replica lists dynamically
 */

import { logger } from './logger.js';
import { verifyProof } from './proof.js';
import { StorageProof } from '../types/index.js';

export interface ReplicaStatus {
  nodeId: string;
  url: string;
  online: boolean;
  hasValidProof: boolean;
  lastChecked: number;
  error?: string;
}

export interface ReplicationVerificationResult {
  totalReplicas: number;
  onlineReplicas: number;
  validProofs: number;
  replicas: ReplicaStatus[];
  sufficient: boolean;
}

/**
 * Verify that replicas are online and have valid proofs (R8.7)
 * 
 * @param cid Content identifier
 * @param replicaNodes List of node URLs that should have the blob
 * @param requiredReplicas Minimum number of valid replicas needed
 * @param verifyProofs Whether to request and verify proofs (optional)
 * @returns Verification result
 */
export async function verifyReplication(
  cid: string,
  replicaNodes: string[],
  requiredReplicas: number,
  verifyProofs = false
): Promise<ReplicationVerificationResult> {
  const replicas: ReplicaStatus[] = [];
  let onlineCount = 0;
  let validProofCount = 0;

  logger.debug('Verifying replication', {
    cid,
    replicaCount: replicaNodes.length,
    requiredReplicas,
    verifyProofs
  });

  // Check each replica
  for (const nodeUrl of replicaNodes) {
    const status = await checkReplica(cid, nodeUrl, verifyProofs);
    replicas.push(status);

    if (status.online) {
      onlineCount++;
    }

    if (status.hasValidProof) {
      validProofCount++;
    }
  }

  const sufficient = verifyProofs 
    ? validProofCount >= requiredReplicas
    : onlineCount >= requiredReplicas;

  logger.debug('Replication verification complete', {
    cid,
    totalReplicas: replicaNodes.length,
    onlineReplicas: onlineCount,
    validProofs: validProofCount,
    sufficient
  });

  return {
    totalReplicas: replicaNodes.length,
    onlineReplicas: onlineCount,
    validProofs: validProofCount,
    replicas,
    sufficient
  };
}

/**
 * Check if a single replica is online and has valid proof
 */
async function checkReplica(
  cid: string,
  nodeUrl: string,
  verifyProof: boolean
): Promise<ReplicaStatus> {
  const status: ReplicaStatus = {
    nodeId: extractNodeId(nodeUrl),
    url: nodeUrl,
    online: false,
    hasValidProof: false,
    lastChecked: Date.now()
  };

  try {
    // Check if node is online with health check
    const isOnline = await checkNodeHealth(nodeUrl);
    status.online = isOnline;

    if (!isOnline) {
      status.error = 'Node offline';
      return status;
    }

    // If proof verification is enabled, request and verify proof
    if (verifyProof) {
      const proof = await requestProof(nodeUrl, cid);
      
      if (proof) {
        const verification = await verifyStorageProof(proof);
        status.hasValidProof = verification.valid;
        
        if (!verification.valid) {
          status.error = 'Invalid proof';
        }
      } else {
        status.error = 'No proof available';
      }
    } else {
      // If not verifying proofs, just check if blob exists
      const hasBlob = await checkBlobExists(nodeUrl, cid);
      status.hasValidProof = hasBlob;
      
      if (!hasBlob) {
        status.error = 'Blob not found';
      }
    }
  } catch (error: any) {
    status.error = error.message;
    logger.debug('Replica check failed', {
      nodeUrl,
      cid,
      error: error.message
    });
  }

  return status;
}

/**
 * Check if node is online via health endpoint
 */
async function checkNodeHealth(nodeUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${nodeUrl}/health`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeout);

    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Check if blob exists on node
 */
async function checkBlobExists(nodeUrl: string, cid: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${nodeUrl}/blob/${cid}`, {
      method: 'HEAD',
      signal: controller.signal
    });

    clearTimeout(timeout);

    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Request storage proof from node
 */
async function requestProof(
  nodeUrl: string,
  cid: string,
  timeoutMs = 5000
): Promise<StorageProof | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${nodeUrl}/proofs/${cid}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const proof = await response.json() as StorageProof;
    return proof;
  } catch (error) {
    logger.debug('Failed to request proof', { nodeUrl, cid, error });
    return null;
  }
}

/**
 * Verify storage proof
 */
async function verifyStorageProof(proof: StorageProof): Promise<{ valid: boolean; reason?: string }> {
  try {
    const result = verifyProof(proof, proof.publicKey);
    return result;
  } catch (error: any) {
    return {
      valid: false,
      reason: error.message
    };
  }
}

/**
 * Extract node ID from URL
 */
function extractNodeId(nodeUrl: string): string {
  try {
    const url = new URL(nodeUrl);
    return url.hostname;
  } catch {
    return nodeUrl;
  }
}

/**
 * Get active replicas (online with valid proofs)
 */
export function getActiveReplicas(result: ReplicationVerificationResult): ReplicaStatus[] {
  return result.replicas.filter(r => r.online && r.hasValidProof);
}

/**
 * Get failed replicas (offline or invalid proofs)
 */
export function getFailedReplicas(result: ReplicationVerificationResult): ReplicaStatus[] {
  return result.replicas.filter(r => !r.online || !r.hasValidProof);
}

/**
 * Format verification result for logging
 */
export function formatVerificationResult(result: ReplicationVerificationResult): string {
  const active = getActiveReplicas(result);
  const failed = getFailedReplicas(result);

  return `${active.length}/${result.totalReplicas} active replicas (${failed.length} failed)`;
}
