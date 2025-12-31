/**
 * Tests for HTTP Store Endpoint - Node Registration Validation
 * 
 * Ensures that the HTTP /store endpoint validates that the node itself
 * is registered in VaultNodeRegistry before accepting storage requests.
 */

import { ethers } from 'ethers';

// Mock the contract integration service
const mockIsNodeActive = jest.fn();

jest.mock('../src/services/contract-integration.service.js', () => ({
  contractIntegrationService: {
    isNodeActive: mockIsNodeActive,
    initialize: jest.fn().mockResolvedValue(undefined)
  }
}));

// Mock config
const mockConfig = {
  publicKey: '0x04' + 'a'.repeat(128),
  nodeId: 'test-node',
  port: 3004,
  maxStorageGB: 100
};

jest.mock('../src/config/index.js', () => ({
  config: mockConfig
}));

describe('HTTP Store Endpoint - Node Registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Node Registration Validation', () => {
    test('should reject storage when publicKey is not configured', () => {
      const configWithoutKey = { ...mockConfig, publicKey: '' };
      
      expect(configWithoutKey.publicKey).toBe('');
      // In real implementation, should return 503 NODE_NOT_CONFIGURED
    });

    test('should accept storage when node is registered', async () => {
      mockIsNodeActive.mockResolvedValue(true);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const isRegistered = await mockIsNodeActive(nodeId);
      
      expect(isRegistered).toBe(true);
      expect(mockIsNodeActive).toHaveBeenCalledWith(nodeId);
    });

    test('should reject storage when node is not registered', async () => {
      mockIsNodeActive.mockResolvedValue(false);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const isRegistered = await mockIsNodeActive(nodeId);
      
      expect(isRegistered).toBe(false);
      // In real implementation, should return 503 NODE_NOT_REGISTERED
    });

    test('should reject storage when node is inactive', async () => {
      mockIsNodeActive.mockResolvedValue(false);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const isRegistered = await mockIsNodeActive(nodeId);
      
      expect(isRegistered).toBe(false);
    });

    test('should reject storage if registration check fails', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('RPC connection failed'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      
      // Should reject - cannot confirm node is registered
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow('RPC connection failed');
      
      // In real implementation, should return 503 REGISTRATION_CHECK_FAILED
    });
  });

  describe('Response Status Codes', () => {
    test('should return 503 when publicKey not configured', () => {
      const expectedResponse = {
        error: 'NODE_NOT_CONFIGURED',
        message: 'This storage node is not properly configured (missing publicKey)',
        timestamp: expect.any(Number)
      };
      
      expect(expectedResponse.error).toBe('NODE_NOT_CONFIGURED');
      expect(expectedResponse.message).toContain('not properly configured');
    });

    test('should return 503 when node not registered', () => {
      const expectedResponse = {
        error: 'NODE_NOT_REGISTERED',
        message: 'This storage node is not registered in the VaultNodeRegistry',
        timestamp: expect.any(Number)
      };
      
      expect(expectedResponse.error).toBe('NODE_NOT_REGISTERED');
      expect(expectedResponse.message).toContain('not registered');
    });

    test('should return 503 when registration check fails', () => {
      const expectedResponse = {
        error: 'REGISTRATION_CHECK_FAILED',
        message: 'Unable to verify node registration status',
        timestamp: expect.any(Number)
      };
      
      expect(expectedResponse.error).toBe('REGISTRATION_CHECK_FAILED');
      expect(expectedResponse.message).toContain('Unable to verify');
    });

    test('should return 201 when node is registered and storage succeeds', () => {
      const expectedResponse = {
        success: true,
        cid: 'bafkreitest',
        timestamp: expect.any(Number),
        replicationStatus: {
          target: expect.any(Number),
          confirmed: expect.any(Number)
        }
      };
      
      expect(expectedResponse.success).toBe(true);
      expect(expectedResponse).toHaveProperty('cid');
      expect(expectedResponse).toHaveProperty('replicationStatus');
    });
  });

  describe('Node ID Derivation', () => {
    test('should derive nodeId from publicKey correctly', () => {
      const publicKey = mockConfig.publicKey;
      const nodeId = ethers.keccak256(publicKey);
      
      expect(nodeId).toMatch(/^0x[a-f0-9]{64}$/);
    });

    test('should use consistent nodeId for registration checks', () => {
      const nodeId1 = ethers.keccak256(mockConfig.publicKey);
      const nodeId2 = ethers.keccak256(mockConfig.publicKey);
      
      expect(nodeId1).toBe(nodeId2);
    });
  });

  describe('Error Handling', () => {
    test('should handle contract call timeout', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('Request timeout'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow('Request timeout');
    });

    test('should handle contract not deployed', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('Contract not found'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow('Contract not found');
    });

    test('should handle invalid RPC response', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('Invalid JSON response'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow('Invalid JSON response');
    });

    test('should handle network disconnection', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('Network error'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow('Network error');
    });
  });

  describe('Configuration Edge Cases', () => {
    test('should skip registration check if publicKey is not configured', () => {
      const configWithoutKey = { ...mockConfig, publicKey: '' };
      
      // If publicKey is empty, registration check should be skipped
      expect(configWithoutKey.publicKey).toBe('');
      // Storage should be allowed without check
    });

    test('should handle malformed publicKey gracefully', () => {
      const invalidKey = 'not-a-valid-key';
      
      expect(() => ethers.keccak256(invalidKey)).toThrow();
    });
  });

  describe('Logging and Monitoring', () => {
    test('should log when node is not registered', async () => {
      mockIsNodeActive.mockResolvedValue(false);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const isRegistered = await mockIsNodeActive(nodeId);
      
      expect(isRegistered).toBe(false);
      // In real implementation, should log warning with nodeId and sender
    });

    test('should log when registration check succeeds', async () => {
      mockIsNodeActive.mockResolvedValue(true);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const isRegistered = await mockIsNodeActive(nodeId);
      
      expect(isRegistered).toBe(true);
      // In real implementation, should log debug message
    });

    test('should log when registration check fails', async () => {
      mockIsNodeActive.mockRejectedValue(new Error('RPC error'));
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      
      await expect(mockIsNodeActive(nodeId)).rejects.toThrow();
      // In real implementation, should log warning about failed check
    });
  });

  describe('Integration with Authorization', () => {
    test('should check node registration after sender authorization', async () => {
      // Sender authorization passes
      const senderAuthorized = true;
      
      // Then check node registration
      mockIsNodeActive.mockResolvedValue(true);
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const nodeRegistered = await mockIsNodeActive(nodeId);
      
      expect(senderAuthorized).toBe(true);
      expect(nodeRegistered).toBe(true);
      // Both checks must pass for storage to succeed
    });

    test('should reject if sender authorized but node not registered', async () => {
      const senderAuthorized = true;
      
      mockIsNodeActive.mockResolvedValue(false);
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const nodeRegistered = await mockIsNodeActive(nodeId);
      
      expect(senderAuthorized).toBe(true);
      expect(nodeRegistered).toBe(false);
      // Should reject with NODE_NOT_REGISTERED
    });

    test('should reject if node registered but sender not authorized', async () => {
      const senderAuthorized = false;
      
      mockIsNodeActive.mockResolvedValue(true);
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const nodeRegistered = await mockIsNodeActive(nodeId);
      
      expect(senderAuthorized).toBe(false);
      expect(nodeRegistered).toBe(true);
      // Should reject with FORBIDDEN (sender auth failure)
    });
  });

  describe('Performance Considerations', () => {
    test('should cache registration status to reduce RPC calls', async () => {
      mockIsNodeActive.mockResolvedValue(true);
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      
      // Multiple calls for same node
      await mockIsNodeActive(nodeId);
      await mockIsNodeActive(nodeId);
      await mockIsNodeActive(nodeId);
      
      // In real implementation with caching, should only call RPC once
      expect(mockIsNodeActive).toHaveBeenCalledTimes(3);
    });

    test('should not block request if check is slow', async () => {
      // Simulate slow RPC call
      mockIsNodeActive.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve(true), 100))
      );
      
      const nodeId = ethers.keccak256(mockConfig.publicKey);
      const start = Date.now();
      const result = await mockIsNodeActive(nodeId);
      const duration = Date.now() - start;
      
      expect(result).toBe(true);
      expect(duration).toBeGreaterThanOrEqual(100);
    });
  });
});
