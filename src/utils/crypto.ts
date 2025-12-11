/**
 * HASHD Vault - Crypto Utilities
 * 
 * Signature verification for feed events
 */

import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

/**
 * Verify Ed25519 signature
 * 
 * @param message - Message that was signed
 * @param signature - Hex-encoded signature
 * @param publicKey - Hex-encoded public key
 * @returns true if signature is valid
 */
export function verifySignature(
  message: string,
  signature: string,
  publicKey: string
): boolean {
  try {
    const messageBytes = Buffer.from(message, 'utf-8');
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(publicKey, 'hex');

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes
    );
  } catch (error) {
    return false;
  }
}

/**
 * Sign message with Ed25519 private key
 * 
 * @param message - Message to sign
 * @param privateKey - Hex-encoded private key
 * @returns Hex-encoded signature
 */
export function signMessage(message: string, privateKey: string): string {
  const messageBytes = Buffer.from(message, 'utf-8');
  const privateKeyBytes = Buffer.from(privateKey, 'hex');

  const signature = nacl.sign.detached(messageBytes, privateKeyBytes);
  return Buffer.from(signature).toString('hex');
}
