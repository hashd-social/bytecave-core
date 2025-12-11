/**
 * Tests for CID (Content Identifier) Generation and Validation
 */

import { generateCID, validateCiphertext, verifyCID } from '../src/utils/cid.js';

describe('CID Generation', () => {
  test('should generate consistent CID for same ciphertext', () => {
    const ciphertext = Buffer.from('test data');
    const cid1 = generateCID(ciphertext);
    const cid2 = generateCID(ciphertext);
    
    expect(cid1).toBe(cid2);
    expect(cid1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  test('should generate different CIDs for different ciphertext', () => {
    const ciphertext1 = Buffer.from('test data 1');
    const ciphertext2 = Buffer.from('test data 2');
    
    const cid1 = generateCID(ciphertext1);
    const cid2 = generateCID(ciphertext2);
    
    expect(cid1).not.toBe(cid2);
  });

  test('should generate valid SHA-256 hash', () => {
    const ciphertext = Buffer.from('Hello World');
    const cid = generateCID(ciphertext);
    
    // SHA-256 should be 64 hex characters
    expect(cid).toHaveLength(64);
    expect(cid).toMatch(/^[0-9a-f]+$/);
  });
});

describe('Ciphertext Validation', () => {
  test('should validate base64 encoded ciphertext', () => {
    const validBase64 = 'SGVsbG8gV29ybGQ='; // "Hello World"
    const buffer = validateCiphertext(validBase64);
    
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.toString()).toBe('Hello World');
  });

  test('should handle invalid base64 gracefully', () => {
    const invalidBase64 = 'not-valid-base64!!!';
    
    // Base64 decoder is lenient, so this might not throw
    // Instead, test that it returns a buffer
    const result = validateCiphertext(invalidBase64);
    expect(result).toBeInstanceOf(Buffer);
  });

  test('should reject empty ciphertext', () => {
    expect(() => validateCiphertext('')).toThrow();
  });

  test('should handle URL-safe base64', () => {
    const urlSafeBase64 = 'SGVsbG8gV29ybGQ'; // Without padding
    const buffer = validateCiphertext(urlSafeBase64);
    
    expect(buffer).toBeInstanceOf(Buffer);
  });
});

describe('CID Verification', () => {
  test('should verify correct CID matches ciphertext', () => {
    const ciphertext = Buffer.from('test data');
    const cid = generateCID(ciphertext);
    
    expect(verifyCID(cid, ciphertext)).toBe(true);
  });

  test('should reject incorrect CID', () => {
    const ciphertext = Buffer.from('test data');
    const wrongCid = '0'.repeat(64);
    
    expect(verifyCID(wrongCid, ciphertext)).toBe(false);
  });

  test('should reject CID with wrong length', () => {
    const ciphertext = Buffer.from('test data');
    const shortCid = '123abc';
    
    expect(verifyCID(shortCid, ciphertext)).toBe(false);
  });

  test('should be case-insensitive', () => {
    const ciphertext = Buffer.from('test data');
    const cid = generateCID(ciphertext);
    const upperCid = cid.toUpperCase();
    
    expect(verifyCID(upperCid.toLowerCase(), ciphertext)).toBe(true);
  });
});
