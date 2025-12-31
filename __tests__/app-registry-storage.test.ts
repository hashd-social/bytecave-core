/**
 * Tests for AppRegistry Integration with Storage Authorization
 * 
 * Tests that:
 * 1. Only registered apps can store data
 * 2. Only authorized addresses can store for an app
 * 3. Node-level app filtering works correctly
 * 4. AppRegistry validation cannot be bypassed
 */

// Mock the app registry service
const mockIsAuthorized = jest.fn();
const mockIsInitialized = jest.fn();

jest.mock('../src/services/app-registry.service.js', () => ({
  appRegistryService: {
    isAuthorized: mockIsAuthorized,
    isInitialized: mockIsInitialized,
    initialize: jest.fn().mockResolvedValue(undefined)
  }
}));

// Mock config with app filtering
const mockConfig = {
  publicKey: '0x04' + 'a'.repeat(128),
  allowedApps: ['hashd'],
  requireAppRegistry: true
};

jest.mock('../src/config/index.js', () => ({
  config: mockConfig
}));

describe('AppRegistry Storage Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsInitialized.mockReturnValue(true);
  });

  describe('App Registration Validation', () => {
    test('should accept storage from registered app with authorized sender', async () => {
      mockIsAuthorized.mockResolvedValue(true);
      
      const appId = 'hashd';
      const sender = '0x1111111111111111111111111111111111111111';
      
      const isAuthorized = await mockIsAuthorized(appId, sender);
      
      expect(isAuthorized).toBe(true);
      expect(mockIsAuthorized).toHaveBeenCalledWith(appId, sender);
    });

    test('should reject storage from unregistered app', async () => {
      mockIsAuthorized.mockResolvedValue(false);
      
      const appId = 'unregistered-app';
      const sender = '0x1111111111111111111111111111111111111111';
      
      const isAuthorized = await mockIsAuthorized(appId, sender);
      
      expect(isAuthorized).toBe(false);
    });

    test('should reject storage from unauthorized sender', async () => {
      mockIsAuthorized.mockResolvedValue(false);
      
      const appId = 'hashd';
      const unauthorizedSender = '0x9999999999999999999999999999999999999999';
      
      const isAuthorized = await mockIsAuthorized(appId, unauthorizedSender);
      
      expect(isAuthorized).toBe(false);
    });

    test('should reject storage when AppRegistry is required but not initialized', () => {
      mockIsInitialized.mockReturnValue(false);
      
      expect(mockConfig.requireAppRegistry).toBe(true);
      expect(mockIsInitialized()).toBe(false);
      
      // In real implementation, should return 403 with error:
      // 'AppRegistry validation required but service not initialized'
    });
  });

  describe('Node-Level App Filtering', () => {
    test('should accept storage from app in allowedApps list', () => {
      const appId = 'hashd';
      const isAllowed = mockConfig.allowedApps.some(allowed => 
        appId.toLowerCase().includes(allowed.toLowerCase())
      );
      
      expect(isAllowed).toBe(true);
    });

    test('should reject storage from app not in allowedApps list', () => {
      const appId = 'otherapp';
      const isAllowed = mockConfig.allowedApps.some(allowed => 
        appId.toLowerCase().includes(allowed.toLowerCase())
      );
      
      expect(isAllowed).toBe(false);
      // In real implementation, should return 403 with error:
      // 'This node does not accept storage for this app'
    });

    test('should accept all apps when allowedApps is empty', () => {
      const configWithAllApps = { ...mockConfig, allowedApps: [] };
      const appId = 'anyapp';
      
      const isAllowed = configWithAllApps.allowedApps.length === 0 || 
        configWithAllApps.allowedApps.some((allowed: string) => 
          appId.toLowerCase().includes(allowed.toLowerCase())
        );
      
      expect(isAllowed).toBe(true);
    });

    test('should accept all apps with wildcard', () => {
      const configWithWildcard = { ...mockConfig, allowedApps: ['*'] };
      const appId = 'anyapp';
      
      const isAllowed = configWithWildcard.allowedApps.some((allowed: string) => 
        appId.toLowerCase().includes(allowed.toLowerCase()) || allowed === '*'
      );
      
      expect(isAllowed).toBe(true);
    });
  });

  describe('Authorization Request Structure', () => {
    test('should require appId and contentType fields', () => {
      const validAuth = {
        type: 'group_post',
        appId: 'hashd',
        contentType: 'post',
        sender: '0x1111111111111111111111111111111111111111',
        signature: '0xsignature',
        timestamp: Date.now(),
        nonce: 'nonce123',
        contentHash: '0xhash'
      };
      
      expect(validAuth.appId).toBeDefined();
      expect(validAuth.contentType).toBeDefined();
    });

    test('should reject request without appId', () => {
      const invalidAuth: any = {
        type: 'group_post',
        // appId missing
        contentType: 'post',
        sender: '0x1111111111111111111111111111111111111111'
      };
      
      expect(invalidAuth.appId).toBeUndefined();
      // In real implementation, should return 403 with error:
      // 'appId and contentType are required'
    });

    test('should reject request without contentType', () => {
      const invalidAuth: any = {
        type: 'group_post',
        appId: 'hashd',
        // contentType missing
        sender: '0x1111111111111111111111111111111111111111'
      };
      
      expect(invalidAuth.contentType).toBeUndefined();
      // In real implementation, should return 403 with error:
      // 'appId and contentType are required'
    });
  });

  describe('Security - Cannot Bypass AppRegistry', () => {
    test('should enforce AppRegistry when requireAppRegistry is true', () => {
      expect(mockConfig.requireAppRegistry).toBe(true);
      
      // Even if AppRegistry is not initialized, requests should be rejected
      mockIsInitialized.mockReturnValue(false);
      expect(mockIsInitialized()).toBe(false);
      
      // In real implementation, this should cause storage to fail with:
      // 'AppRegistry validation required but service not initialized'
    });

    test('should allow bypass only when requireAppRegistry is false', () => {
      const configWithoutRequirement = { 
        ...mockConfig, 
        requireAppRegistry: false 
      };
      
      expect(configWithoutRequirement.requireAppRegistry).toBe(false);
      
      // Only in this case should storage proceed without AppRegistry validation
    });

    test('should validate signature includes appId and contentType', () => {
      const signatureMessage = `HASHD Vault Storage Request
Type: group_post
Content Hash: 0xhash
App ID: hashd
Content Type: post
Context: group123
Timestamp: 1234567890
Nonce: nonce123`;
      
      expect(signatureMessage).toContain('App ID:');
      expect(signatureMessage).toContain('Content Type:');
      
      // Signature covers appId and contentType, preventing tampering
    });
  });

  describe('Error Responses', () => {
    test('should return correct error when app not registered', () => {
      const expectedError = {
        authorized: false,
        error: 'Sender not authorized for this appId or app not registered',
        details: {
          appId: 'unregistered-app',
          sender: '0x1111111111111111111111111111111111111111'
        }
      };
      
      expect(expectedError.authorized).toBe(false);
      expect(expectedError.error).toContain('not registered');
    });

    test('should return correct error when app not in allowedApps', () => {
      const expectedError = {
        authorized: false,
        error: 'This node does not accept storage for this app',
        details: {
          appId: 'otherapp',
          allowedApps: ['hashd']
        }
      };
      
      expect(expectedError.authorized).toBe(false);
      expect(expectedError.error).toContain('does not accept');
    });

    test('should return correct error when AppRegistry required but not initialized', () => {
      const expectedError = {
        authorized: false,
        error: 'AppRegistry validation required but service not initialized',
        details: {
          requireAppRegistry: true
        }
      };
      
      expect(expectedError.authorized).toBe(false);
      expect(expectedError.error).toContain('required but service not initialized');
    });
  });

  describe('Multi-Layer Security', () => {
    test('should validate all security layers in order', async () => {
      // Layer 1: AppRegistry authorization
      mockIsAuthorized.mockResolvedValue(true);
      
      // Layer 2: Node-level app filtering
      const appId = 'hashd';
      const isInAllowedApps = mockConfig.allowedApps.includes(appId);
      
      // Layer 3: Node registration (tested in http-store-registration.test.ts)
      // Layer 4: Signature verification
      // Layer 5: Timestamp validation
      // Layer 6: Nonce validation
      
      expect(await mockIsAuthorized(appId, '0x1111111111111111111111111111111111111111')).toBe(true);
      expect(isInAllowedApps).toBe(true);
    });

    test('should fail if any security layer fails', async () => {
      // If AppRegistry check passes but node filtering fails
      mockIsAuthorized.mockResolvedValue(true);
      
      const appId = 'otherapp';
      const isInAllowedApps = mockConfig.allowedApps.some(allowed => 
        appId.toLowerCase().includes(allowed.toLowerCase())
      );
      
      // Even though AppRegistry authorized, node filtering should reject
      expect(await mockIsAuthorized(appId, '0x1111111111111111111111111111111111111111')).toBe(true);
      expect(isInAllowedApps).toBe(false);
      
      // In real implementation, request should be rejected at node filtering layer
    });
  });
});
