/**
 * Deregistration Cleanup Utility
 * 
 * Handles cleanup of blobs and metadata when a node is deregistered.
 * This is called when the health endpoint or other code detects deregistration.
 */

import { logger } from './logger.js';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';

let isCleaningUp = false;
let hasBeenDeregistered = false;

/**
 * Perform cleanup after node deregistration
 * This deletes all blobs, metadata, and proof files
 */
export async function performDeregistrationCleanup(): Promise<void> {
  if (isCleaningUp) {
    logger.warn('Cleanup already in progress');
    return;
  }

  if (hasBeenDeregistered) {
    logger.debug('Cleanup already performed after deregistration');
    return;
  }

  isCleaningUp = true;
  hasBeenDeregistered = true;

  try {
    logger.warn('='.repeat(60));
    logger.warn('NODE DEREGISTERED - STARTING DATA CLEANUP');
    logger.warn('='.repeat(60));

    // 1. Delete all blobs
    await deleteAllBlobs();

    // 2. Delete all metadata
    await deleteAllMetadata();

    // 3. Clear proof files
    await clearProofFiles();

    logger.warn('='.repeat(60));
    logger.warn('DATA CLEANUP COMPLETED');
    logger.warn('Node will continue running but with empty storage');
    logger.warn('Re-register the node to resume normal operation');
    logger.warn('='.repeat(60));
  } catch (error) {
    logger.error('Failed to complete cleanup after deregistration', error);
  } finally {
    isCleaningUp = false;
  }
}

/**
 * Delete all stored blobs
 */
async function deleteAllBlobs(): Promise<void> {
  try {
    const blobsDir = path.join(config.dataDir, 'blobs');
    
    try {
      await fs.access(blobsDir);
    } catch {
      logger.info('Blobs directory does not exist');
      return;
    }

    const files = await fs.readdir(blobsDir);
    let deletedCount = 0;

    for (const file of files) {
      try {
        await fs.unlink(path.join(blobsDir, file));
        deletedCount++;
      } catch (error) {
        logger.error(`Failed to delete blob file: ${file}`, error);
      }
    }

    logger.warn(`Deleted ${deletedCount} blob files`);
  } catch (error) {
    logger.error('Failed to delete blobs', error);
    throw error;
  }
}

/**
 * Delete all metadata files
 */
async function deleteAllMetadata(): Promise<void> {
  try {
    const metaDir = path.join(config.dataDir, 'meta');
    
    try {
      await fs.access(metaDir);
    } catch {
      logger.info('Meta directory does not exist');
      return;
    }

    const files = await fs.readdir(metaDir);
    let deletedCount = 0;

    for (const file of files) {
      try {
        await fs.unlink(path.join(metaDir, file));
        deletedCount++;
      } catch (error) {
        logger.error(`Failed to delete metadata file: ${file}`, error);
      }
    }

    logger.warn(`Deleted ${deletedCount} metadata files`);
  } catch (error) {
    logger.error('Failed to delete metadata', error);
    throw error;
  }
}

/**
 * Clear proof files
 */
async function clearProofFiles(): Promise<void> {
  try {
    const proofsDir = path.join(config.dataDir, 'proofs');
    
    try {
      await fs.access(proofsDir);
    } catch {
      logger.info('Proofs directory does not exist');
      return;
    }

    const files = await fs.readdir(proofsDir);
    let deletedCount = 0;

    for (const file of files) {
      try {
        await fs.unlink(path.join(proofsDir, file));
        deletedCount++;
      } catch (error) {
        logger.error(`Failed to delete proof file: ${file}`, error);
      }
    }

    logger.warn(`Deleted ${deletedCount} proof files`);
  } catch (error) {
    logger.error('Failed to clear proof files', error);
    throw error;
  }
}

/**
 * Reset the cleanup state (for testing)
 */
export function resetCleanupState(): void {
  hasBeenDeregistered = false;
  isCleaningUp = false;
}
