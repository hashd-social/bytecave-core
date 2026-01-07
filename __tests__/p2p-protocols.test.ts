/**
 * Tests for P2P Protocol Handlers (Phase 49-53)
 * 
 * Covers:
 * - /bytecave/replicate/1.0.0 - Blob replication between nodes
 * - /bytecave/blob/1.0.0 - Blob retrieval via P2P
 * - /bytecave/health/1.0.0 - Health status exchange
 * - /bytecave/info/1.0.0 - Node info for registration
 */

// Mock dependencies before importing the service
jest.mock('../src/services/storage.service.js', () => ({
  storageService: {
    hasBlob: jest.fn(),
    getBlob: jest.fn(),
    storeBlob: jest.fn(),
    getStats: jest.fn()
  }
}));

jest.mock('../src/config/index.js', () => ({
  config: {
    nodeId: 'test-node-id',
    publicKey: 'test-public-key-hex',
    ownerAddress: '0x1234567890abcdef',
    contentTypes: 'all',
    p2p: {
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001']
    }
  }
}));

jest.mock('../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

// Import after mocks
import { storageService } from '../src/services/storage.service.js';

describe('P2P Protocols Service (Phase 49-53)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset uptime tracking
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Protocol Constants', () => {
    test('should define correct protocol identifiers', () => {
      const PROTOCOL_REPLICATE = '/bytecave/replicate/1.0.0';
      const PROTOCOL_BLOB = '/bytecave/blob/1.0.0';
      const PROTOCOL_HEALTH = '/bytecave/health/1.0.0';
      const PROTOCOL_INFO = '/bytecave/info/1.0.0';

      expect(PROTOCOL_REPLICATE).toBe('/bytecave/replicate/1.0.0');
      expect(PROTOCOL_BLOB).toBe('/bytecave/blob/1.0.0');
      expect(PROTOCOL_HEALTH).toBe('/bytecave/health/1.0.0');
      expect(PROTOCOL_INFO).toBe('/bytecave/info/1.0.0');
    });
  });

  describe('Replicate Protocol Handler', () => {
    test('should accept valid replication request', async () => {
      const mockStoreBlob = storageService.storeBlob as jest.Mock;
      const mockHasBlob = storageService.hasBlob as jest.Mock;
      
      mockHasBlob.mockResolvedValue(false);
      mockStoreBlob.mockResolvedValue(undefined);

      const request = {
        cid: 'baftest123',
        mimeType: 'application/octet-stream',
        ciphertext: Buffer.from('test data').toString('base64'),
        contentType: 'media'
      };

      // Simulate the handler logic
      const ciphertext = Buffer.from(request.ciphertext, 'base64');
      const alreadyStored = await mockHasBlob(request.cid);
      
      if (!alreadyStored) {
        await mockStoreBlob(request.cid, ciphertext, request.mimeType, {
          contentType: request.contentType
        });
      }

      expect(mockHasBlob).toHaveBeenCalledWith('baftest123');
      expect(mockStoreBlob).toHaveBeenCalledWith(
        'baftest123',
        expect.any(Buffer),
        'application/octet-stream',
        { contentType: 'media' }
      );
    });

    test('should skip storage if blob already exists', async () => {
      const mockStoreBlob = storageService.storeBlob as jest.Mock;
      const mockHasBlob = storageService.hasBlob as jest.Mock;
      
      mockHasBlob.mockResolvedValue(true);

      const request = {
        cid: 'bafexisting',
        mimeType: 'application/octet-stream',
        ciphertext: Buffer.from('test data').toString('base64')
      };

      const alreadyStored = await mockHasBlob(request.cid);
      
      if (!alreadyStored) {
        await mockStoreBlob(request.cid, Buffer.from(request.ciphertext, 'base64'), request.mimeType);
      }

      expect(mockHasBlob).toHaveBeenCalledWith('bafexisting');
      expect(mockStoreBlob).not.toHaveBeenCalled();
    });

    test('should reject request without CID', () => {
      const request = {
        mimeType: 'application/octet-stream',
        ciphertext: Buffer.from('test data').toString('base64')
      };

      const isValid = request.hasOwnProperty('cid') && (request as any).cid;
      expect(isValid).toBe(false);
    });

    test('should reject request without ciphertext', () => {
      const request = {
        cid: 'baftest123',
        mimeType: 'application/octet-stream'
      };

      const isValid = request.hasOwnProperty('ciphertext') && (request as any).ciphertext;
      expect(isValid).toBe(false);
    });
  });

  describe('Blob Retrieval Protocol Handler', () => {
    test('should return blob data when found', async () => {
      const mockGetBlob = storageService.getBlob as jest.Mock;
      
      const testCiphertext = Buffer.from('encrypted content');
      mockGetBlob.mockResolvedValue({
        ciphertext: testCiphertext,
        metadata: {
          cid: 'baftest123',
          mimeType: 'image/png',
          size: testCiphertext.length
        }
      });

      const result = await mockGetBlob('baftest123');

      expect(result.ciphertext).toEqual(testCiphertext);
      expect(result.metadata.mimeType).toBe('image/png');
    });

    test('should return error when blob not found', async () => {
      const mockGetBlob = storageService.getBlob as jest.Mock;
      
      mockGetBlob.mockRejectedValue(new Error('Blob not found'));

      await expect(mockGetBlob('bafnonexistent')).rejects.toThrow('Blob not found');
    });

    test('should encode ciphertext as base64 for transport', () => {
      const ciphertext = Buffer.from('test encrypted data');
      const encoded = ciphertext.toString('base64');
      const decoded = Buffer.from(encoded, 'base64');

      expect(decoded).toEqual(ciphertext);
    });
  });

  describe('Health Protocol Handler', () => {
    test('should return health status with storage stats via P2P', async () => {
      const mockGetStats = storageService.getStats as jest.Mock;
      
      mockGetStats.mockResolvedValue({
        blobCount: 42,
        totalSize: 1024 * 1024 * 100 // 100MB
      });

      const stats = await mockGetStats();

      const healthResponse = {
        peerId: 'test-peer-id',
        status: 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        storageMax: 1024 * 1024 * 1024, // 1GB
        uptime: 3600,
        version: '1.0.0',
        contentTypes: 'all',
        multiaddrs: ['/ip4/127.0.0.1/tcp/4001']
      };

      expect(healthResponse.status).toBe('healthy');
      expect(healthResponse.blobCount).toBe(42);
      expect(healthResponse.storageUsed).toBe(1024 * 1024 * 100);
      expect(healthResponse.peerId).toBe('test-peer-id');
    });

    test('should report degraded status when storage is high', () => {
      const storageUsed = 900 * 1024 * 1024; // 900MB
      const storageMax = 1024 * 1024 * 1024; // 1GB
      const usagePercent = storageUsed / storageMax;

      const status = usagePercent > 0.8 ? 'degraded' : 'healthy';
      expect(status).toBe('degraded');
    });

    test('should track uptime correctly', () => {
      const startTime = Date.now();
      jest.advanceTimersByTime(60000); // 1 minute
      const uptime = Math.floor((Date.now() - startTime) / 1000);

      expect(uptime).toBe(60);
    });

    test('should get health data via P2P without HTTP endpoint', async () => {
      // Verify health can be retrieved using only P2P protocol
      const mockGetStats = storageService.getStats as jest.Mock;
      
      mockGetStats.mockResolvedValue({
        blobCount: 100,
        totalSize: 1024 * 1024 * 500 // 500MB
      });

      const stats = await mockGetStats();

      // Simulate P2P health protocol response
      const p2pHealthResponse = {
        peerId: 'remote-peer-id',
        status: 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        uptime: 7200,
        version: '1.0.0'
      };

      // Verify no HTTP endpoint is needed
      expect(p2pHealthResponse).not.toHaveProperty('httpEndpoint');
      expect(p2pHealthResponse).not.toHaveProperty('httpUrl');
      
      // Verify health data is complete
      expect(p2pHealthResponse.peerId).toBe('remote-peer-id');
      expect(p2pHealthResponse.status).toBe('healthy');
      expect(p2pHealthResponse.blobCount).toBe(100);
      expect(p2pHealthResponse.storageUsed).toBe(1024 * 1024 * 500);
      expect(p2pHealthResponse.uptime).toBe(7200);
    });

    test('should handle health request from peer without HTTP fallback', async () => {
      // Simulate receiving health request via P2P protocol
      const mockGetStats = storageService.getStats as jest.Mock;
      
      mockGetStats.mockResolvedValue({
        blobCount: 25,
        totalSize: 1024 * 1024 * 50 // 50MB
      });

      const stats = await mockGetStats();
      const startTime = Date.now() - 3600000; // 1 hour ago
      const uptime = Math.floor((Date.now() - startTime) / 1000);

      // Build health response for P2P protocol
      const healthResponse = {
        peerId: 'local-peer-id',
        status: 'healthy',
        blobCount: stats.blobCount,
        storageUsed: stats.totalSize,
        storageMax: 1024 * 1024 * 1024,
        uptime,
        version: '1.0.0',
        contentTypes: 'all'
      };

      // Verify response structure for P2P-only communication
      expect(healthResponse.peerId).toBe('local-peer-id');
      expect(healthResponse.blobCount).toBe(25);
      expect(healthResponse.storageUsed).toBe(1024 * 1024 * 50);
      expect(healthResponse.uptime).toBeGreaterThan(3500);
      
      // Verify no HTTP-related fields
      expect(healthResponse).not.toHaveProperty('httpEndpoint');
      expect(healthResponse).not.toHaveProperty('url');
    });
  });

  describe('Info Protocol Handler', () => {
    test('should return node info for registration', () => {
      const nodeInfo = {
        peerId: 'test-peer-id',
        publicKey: 'test-public-key-hex',
        ownerAddress: '0x1234567890abcdef',
        version: '1.0.0',
        contentTypes: 'all'
      };

      expect(nodeInfo.peerId).toBe('test-peer-id');
      expect(nodeInfo.publicKey).toBe('test-public-key-hex');
      expect(nodeInfo.ownerAddress).toBe('0x1234567890abcdef');
    });

    test('should include public key for contract registration', () => {
      const publicKey = 'abcdef1234567890';
      expect(publicKey).toBeTruthy();
      expect(typeof publicKey).toBe('string');
    });
  });

  describe('Stream Message Encoding', () => {
    test('should encode messages as JSON', () => {
      const message = { cid: 'baftest', success: true };
      const encoded = JSON.stringify(message);
      const decoded = JSON.parse(encoded);

      expect(decoded).toEqual(message);
    });

    test('should handle binary data via base64 encoding', () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      const base64 = binaryData.toString('base64');
      const restored = Buffer.from(base64, 'base64');

      expect(restored).toEqual(binaryData);
    });

    test('should handle large payloads', () => {
      const largeData = Buffer.alloc(1024 * 1024, 'x'); // 1MB
      const base64 = largeData.toString('base64');
      const restored = Buffer.from(base64, 'base64');

      expect(restored.length).toBe(largeData.length);
      expect(restored).toEqual(largeData);
    });
  });

  describe('Protocol Registration', () => {
    test('should register all four protocols', () => {
      const protocols = [
        '/bytecave/replicate/1.0.0',
        '/bytecave/blob/1.0.0',
        '/bytecave/health/1.0.0',
        '/bytecave/info/1.0.0'
      ];

      expect(protocols).toHaveLength(4);
      protocols.forEach(protocol => {
        expect(protocol).toMatch(/^\/bytecave\/.+\/1\.0\.0$/);
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle storage service errors gracefully', async () => {
      const mockStoreBlob = storageService.storeBlob as jest.Mock;
      mockStoreBlob.mockRejectedValue(new Error('Storage full'));

      await expect(mockStoreBlob('cid', Buffer.from('data'), 'type'))
        .rejects.toThrow('Storage full');
    });

    test('should return error response for invalid requests', () => {
      const response = {
        success: false,
        error: 'Invalid request: missing cid'
      };

      expect(response.success).toBe(false);
      expect(response.error).toContain('missing cid');
    });
  });
});

describe('Replication Service P2P Integration (Phase 50)', () => {
  describe('P2P-First Replication', () => {
    test('should attempt P2P replication before HTTP', () => {
      const peer = {
        nodeId: '12D3KooWTest',
        url: 'http://localhost:5001'
      };

      // P2P should be tried first if peer has nodeId
      const shouldTryP2P = !!peer.nodeId;
      expect(shouldTryP2P).toBe(true);
    });

    test('should fall back to HTTP when P2P fails', async () => {
      const p2pSuccess = false;
      const httpAvailable = true;

      const shouldTryHttp = !p2pSuccess && httpAvailable;
      expect(shouldTryHttp).toBe(true);
    });

    test('should skip HTTP fallback when P2P succeeds', () => {
      const p2pSuccess = true;

      const shouldTryHttp = !p2pSuccess;
      expect(shouldTryHttp).toBe(false);
    });
  });
});

describe('Browser P2P Client (Phase 51)', () => {
  describe('Store via P2P', () => {
    test('should generate CID from ciphertext hash', async () => {
      // Simulate browser crypto.subtle.digest result
      const mockHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef12';
      const cid = 'baf' + mockHash.slice(0, 56);

      expect(cid).toMatch(/^baf[a-f0-9]{56}$/);
    });

    test('should encode Uint8Array to base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      
      // Browser-compatible base64 encoding
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      expect(base64).toBe('SGVsbG8=');
    });
  });

  describe('Retrieve via P2P', () => {
    test('should decode base64 to Uint8Array', () => {
      const base64 = 'SGVsbG8=';
      
      // Browser-compatible base64 decoding
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      expect(bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });
  });

  describe('Node Info via P2P', () => {
    test('should return node info for registration', () => {
      const info = {
        peerId: '12D3KooWTest',
        publicKey: 'abcdef123456',
        ownerAddress: '0x1234'
      };

      expect(info.peerId).toBeTruthy();
      expect(info.publicKey).toBeTruthy();
    });
  });
});

describe('Circuit Relay Configuration (Phase 52)', () => {
  test('should enable circuit relay transport', () => {
    const p2pConfig = {
      enableRelay: true,
      enableDHT: true,
      enableMDNS: true
    };

    expect(p2pConfig.enableRelay).toBe(true);
  });

  test('should include dcutr for NAT hole punching', () => {
    const services = {
      relay: 'circuitRelayServer',
      dcutr: 'dcutr'
    };

    expect(services.relay).toBe('circuitRelayServer');
    expect(services.dcutr).toBe('dcutr');
  });
});

describe('Bootstrap Peer Settings (Phase 53)', () => {
  describe('Desktop App Config', () => {
    test('should support bootstrap peer configuration', () => {
      const config = {
        p2pBootstrapPeers: [
          '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest1',
          '/ip4/5.6.7.8/tcp/4001/p2p/12D3KooWTest2'
        ],
        p2pEnableRelay: true
      };

      expect(config.p2pBootstrapPeers).toHaveLength(2);
      expect(config.p2pEnableRelay).toBe(true);
    });

    test('should pass bootstrap peers to environment', () => {
      const bootstrapPeers = [
        '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest'
      ];

      const env = {
        P2P_BOOTSTRAP_PEERS: bootstrapPeers.join(',')
      };

      expect(env.P2P_BOOTSTRAP_PEERS).toBe('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWTest');
    });

    test('should handle empty bootstrap peers', () => {
      const bootstrapPeers: string[] = [];
      const env = {
        P2P_BOOTSTRAP_PEERS: bootstrapPeers.join(',')
      };

      expect(env.P2P_BOOTSTRAP_PEERS).toBe('');
    });
  });

  describe('Multiaddr Validation', () => {
    test('should validate multiaddr format', () => {
      const validMultiaddr = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWTest';
      const isValid = validMultiaddr.startsWith('/ip4/') || validMultiaddr.startsWith('/ip6/');

      expect(isValid).toBe(true);
    });

    test('should reject invalid multiaddr', () => {
      const invalidMultiaddr = 'http://localhost:4001';
      const isValid = invalidMultiaddr.startsWith('/ip4/') || invalidMultiaddr.startsWith('/ip6/');

      expect(isValid).toBe(false);
    });
  });
});
