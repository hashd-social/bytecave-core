/**
 * HASHD Vault - Proof Service
 * 
 * Manages storage proof generation, storage, and retention (R4.7)
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { generateChallenge, signProof, generateProofData, truncateToHour } from '../utils/proof.js';
import { StorageProof } from '../types/index.js';

export class ProofService {
  private proofsDir: string;
  private privateKey: Buffer | null = null;
  private publicKey: Buffer | null = null;
  private initialized = false;

  constructor() {
    this.proofsDir = path.join(config.dataDir, 'proofs');
  }

  /**
   * Initialize proof service and load/generate keys
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create proofs directory
      await fs.mkdir(this.proofsDir, { recursive: true });

      // Load or generate node keys
      await this.loadOrGenerateKeys();

      this.initialized = true;
      logger.info('Proof service initialized', {
        proofsDir: this.proofsDir,
        hasKeys: !!this.privateKey
      });
    } catch (error) {
      logger.error('Failed to initialize proof service', error);
      throw error;
    }
  }

  /**
   * Load or generate Ed25519 key pair
   */
  private async loadOrGenerateKeys(): Promise<void> {
    const keyPath = path.join(config.dataDir, 'node-key.json');

    try {
      // Try to load existing keys
      const keyData = await fs.readFile(keyPath, 'utf8');
      const keys = JSON.parse(keyData);
      
      this.privateKey = Buffer.from(keys.privateKey, 'hex');
      this.publicKey = Buffer.from(keys.publicKey, 'hex');
      
      logger.info('Loaded existing node keys');
    } catch (error) {
      // Generate new keys
      const crypto = await import('crypto');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      });

      this.privateKey = Buffer.from(privateKey);
      this.publicKey = Buffer.from(publicKey);

      // Save keys
      await fs.writeFile(
        keyPath,
        JSON.stringify({
          publicKey: this.publicKey.toString('hex'),
          privateKey: this.privateKey.toString('hex'),
          generated: Date.now()
        }, null, 2)
      );

      logger.info('Generated new node keys', { keyPath });
    }
  }

  /**
   * Generate a storage proof for a CID (R4.1, R4.2)
   * @param cid Content identifier
   * @param challenge Challenge hash
   * @returns Storage proof
   */
  async generateProof(cid: string, challenge: string): Promise<StorageProof> {
    if (!this.initialized || !this.privateKey) {
      throw new Error('Proof service not initialized');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nodeId = config.nodeId;

    // Sign the proof
    const signature = signProof(this.privateKey, cid, challenge, nodeId);

    const proof: StorageProof = {
      cid,
      nodeId,
      timestamp,
      challenge,
      signature,
      publicKey: this.publicKey!.toString('hex')
    };

    // Store proof for retention (R4.7)
    await this.storeProof(proof);

    logger.debug('Generated storage proof', {
      cid,
      nodeId,
      timestamp
    });

    return proof;
  }

  /**
   * Store proof for retention (R4.7)
   */
  private async storeProof(proof: StorageProof): Promise<void> {
    try {
      const hourTimestamp = truncateToHour(proof.timestamp);
      const proofFile = path.join(
        this.proofsDir,
        `${proof.cid}-${hourTimestamp}.json`
      );

      await fs.writeFile(proofFile, JSON.stringify(proof, null, 2));
    } catch (error) {
      logger.warn('Failed to store proof', { error, cid: proof.cid });
      // Don't throw - proof generation succeeded
    }
  }

  /**
   * Get stored proofs for a CID
   */
  async getProofs(cid: string): Promise<StorageProof[]> {
    try {
      const files = await fs.readdir(this.proofsDir);
      const proofFiles = files.filter(f => f.startsWith(cid) && f.endsWith('.json'));
      
      const proofs: StorageProof[] = [];
      for (const file of proofFiles) {
        try {
          const data = await fs.readFile(path.join(this.proofsDir, file), 'utf8');
          proofs.push(JSON.parse(data));
        } catch (error) {
          logger.warn('Failed to read proof file', { file, error });
        }
      }

      return proofs.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      logger.error('Failed to get proofs', { cid, error });
      return [];
    }
  }

  /**
   * Clean up old proofs (R4.7)
   * @param retentionWindows Number of hour windows to retain
   */
  async cleanupOldProofs(retentionWindows: number = 24): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = truncateToHour(now) - (retentionWindows * 3600);

      const files = await fs.readdir(this.proofsDir);
      let deleted = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        // Extract timestamp from filename: {cid}-{timestamp}.json
        const match = file.match(/-(\d+)\.json$/);
        if (!match) continue;

        const timestamp = parseInt(match[1]);
        if (timestamp < cutoff) {
          await fs.unlink(path.join(this.proofsDir, file));
          deleted++;
        }
      }

      if (deleted > 0) {
        logger.info('Cleaned up old proofs', { deleted, cutoff });
      }
    } catch (error) {
      logger.error('Failed to cleanup proofs', error);
    }
  }

  /**
   * Get node's public key
   */
  getPublicKey(): string {
    if (!this.publicKey) {
      throw new Error('Keys not initialized');
    }
    return this.publicKey.toString('hex');
  }

  /**
   * Get proof statistics
   */
  async getStats(): Promise<{ totalProofs: number; oldestProof: number; newestProof: number }> {
    try {
      const files = await fs.readdir(this.proofsDir);
      const proofFiles = files.filter(f => f.endsWith('.json'));

      if (proofFiles.length === 0) {
        return { totalProofs: 0, oldestProof: 0, newestProof: 0 };
      }

      const timestamps = proofFiles
        .map(f => {
          const match = f.match(/-(\d+)\.json$/);
          return match ? parseInt(match[1]) : 0;
        })
        .filter(t => t > 0);

      return {
        totalProofs: proofFiles.length,
        oldestProof: Math.min(...timestamps),
        newestProof: Math.max(...timestamps)
      };
    } catch (error) {
      return { totalProofs: 0, oldestProof: 0, newestProof: 0 };
    }
  }
}

// Singleton instance
export const proofService = new ProofService();
