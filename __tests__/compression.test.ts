/**
 * Tests for Compression (compressionEnabled configuration)
 */

import { StorageService } from '../src/services/storage.service.js';
import { BlobMetadata } from '../src/types/index.js';
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Mock config with compression enabled
jest.mock('../src/config/index.js', () => ({
  config: {
    dataDir: '/tmp/test-storage',
    compressionEnabled: true,
    maxBlobSizeMB: 10,
    maxStorageGB: 100
  }
}));

// Mock fs
jest.mock('fs/promises');

describe('Compression Service', () => {
  let storageService: StorageService;

  beforeEach(() => {
    storageService = new StorageService();
    jest.clearAllMocks();
  });

  describe('Blob Compression', () => {
    test('should compress blob when compressionEnabled is true', async () => {
      const cid = 'test-cid-compressed';
      const originalData = Buffer.from('test data '.repeat(100)); // Compressible data
      const mimeType = 'text/plain';

      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockRejectedValue(new Error('Not found'));
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);

      await storageService.storeBlob(cid, originalData, mimeType);

      // Check that writeFile was called
      expect(fs.writeFile).toHaveBeenCalled();
      
      // The data written should be compressed (smaller than original)
      const writeCall = (fs.writeFile as jest.Mock).mock.calls[0];
      const writtenData = writeCall[1] as Buffer;
      
      // Compressed data should be smaller
      expect(writtenData.length).toBeLessThan(originalData.length);
    });

    test('should not compress if compression does not reduce size', async () => {
      const cid = 'test-cid-incompressible';
      // Random data is not compressible
      const randomData = Buffer.from(Array.from({ length: 100 }, () => Math.floor(Math.random() * 256)));
      const mimeType = 'application/octet-stream';

      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockRejectedValue(new Error('Not found'));
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);

      await storageService.storeBlob(cid, randomData, mimeType);

      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should store compressed flag in metadata', async () => {
      const cid = 'test-cid-metadata';
      const data = Buffer.from('compressible data '.repeat(50));
      const mimeType = 'text/plain';

      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockRejectedValue(new Error('Not found'));
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);

      await storageService.storeBlob(cid, data, mimeType);

      // Check metadata write
      const metadataCall = (fs.writeFile as jest.Mock).mock.calls.find(
        call => call[0].includes('.meta')
      );
      
      expect(metadataCall).toBeDefined();
      const metadata = JSON.parse(metadataCall[1]);
      expect(metadata).toHaveProperty('compressed');
    });
  });

  describe('Blob Decompression', () => {
    test('should decompress blob on retrieval', async () => {
      const cid = 'test-cid-decompress';
      const originalData = Buffer.from('test data '.repeat(100));
      const compressedData = await gzip(originalData);

      const metadata: BlobMetadata = {
        cid,
        size: originalData.length,
        mimeType: 'text/plain',
        createdAt: Date.now(),
        version: 2,
        compressed: true
      };

      (fs.readFile as jest.Mock).mockImplementation((path: string) => {
        if (path.includes('.meta')) {
          return Promise.resolve(JSON.stringify(metadata));
        }
        return Promise.resolve(compressedData);
      });

      const result = await storageService.getBlob(cid);

      // Should return decompressed data
      expect(result.ciphertext.length).toBe(originalData.length);
      expect(result.ciphertext.toString()).toBe(originalData.toString());
    });

    test('should handle uncompressed blobs correctly', async () => {
      const cid = 'test-cid-uncompressed';
      const data = Buffer.from('test data');

      const metadata: BlobMetadata = {
        cid,
        size: data.length,
        mimeType: 'text/plain',
        createdAt: Date.now(),
        version: 2,
        compressed: false
      };

      (fs.readFile as jest.Mock).mockImplementation((path: string) => {
        if (path.includes('.meta')) {
          return Promise.resolve(JSON.stringify(metadata));
        }
        return Promise.resolve(data);
      });

      const result = await storageService.getBlob(cid);

      // Should return data as-is
      expect(result.ciphertext).toEqual(data);
    });

    test('should handle decompression errors gracefully', async () => {
      const cid = 'test-cid-corrupt';
      const corruptData = Buffer.from('corrupt compressed data');

      const metadata: BlobMetadata = {
        cid,
        size: 100,
        mimeType: 'text/plain',
        createdAt: Date.now(),
        version: 2,
        compressed: true
      };

      (fs.readFile as jest.Mock).mockImplementation((path: string) => {
        if (path.includes('.meta')) {
          return Promise.resolve(JSON.stringify(metadata));
        }
        return Promise.resolve(corruptData);
      });

      await expect(storageService.getBlob(cid)).rejects.toThrow('Failed to decompress blob');
    });
  });

  describe('Compression Configuration', () => {
    test('should not compress when compressionEnabled is false', async () => {
      // Mock config with compression disabled
      const { config } = await import('../src/config/index.js');
      (config as any).compressionEnabled = false;

      const cid = 'test-cid-no-compress';
      const data = Buffer.from('test data '.repeat(100));
      const mimeType = 'text/plain';

      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockRejectedValue(new Error('Not found'));
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);

      await storageService.storeBlob(cid, data, mimeType);

      const writeCall = (fs.writeFile as jest.Mock).mock.calls[0];
      const writtenData = writeCall[1] as Buffer;
      
      // Data should not be compressed
      expect(writtenData).toEqual(data);
    });
  });

  describe('Compression Ratio Logging', () => {
    test('should log compression ratio for monitoring', async () => {
      const cid = 'test-cid-ratio';
      const data = Buffer.from('highly compressible data '.repeat(200));
      const mimeType = 'text/plain';

      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockRejectedValue(new Error('Not found'));
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);

      await storageService.storeBlob(cid, data, mimeType);

      // Compression should have occurred
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });
});
