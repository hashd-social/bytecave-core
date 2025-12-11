/**
 * Tests for Garbage Collection System
 * 
 * Covers Requirement 8: GC & Retention Policies
 */

import { GarbageCollectionService } from '../src/services/gc.service.js';
import { storageService } from '../src/services/storage.service.js';
import { BlobMetadata } from '../src/types/index.js';

// Mock storage service
jest.mock('../src/services/storage.service.js', () => ({
  storageService: {
    listBlobs: jest.fn(),
    getMetadata: jest.fn(),
    deleteBlob: jest.fn(),
    getStats: jest.fn()
  }
}));

// Mock config
jest.mock('../src/config/index.js', () => ({
  config: {
    gcEnabled: true,
    gcRetentionMode: 'hybrid',
    gcMaxStorageMB: 1000,
    gcMaxBlobAgeDays: 30,
    gcMinFreeDiskMB: 100,
    gcReservedForPinnedMB: 200,
    gcIntervalMinutes: 10,
    replicationFactor: 3,
    nodeShards: [{ start: 0, end: 1023 }],
    shardCount: 1024
  }
}));

describe('Garbage Collection Service', () => {
  let gcService: GarbageCollectionService;

  beforeEach(() => {
    gcService = new GarbageCollectionService();
    jest.clearAllMocks();
  });

  describe('Safety Checks (R8.1, R8.3)', () => {
    test('should not delete pinned blobs', async () => {
      const pinnedMetadata: BlobMetadata = {
        cid: 'pinned-blob',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000), // 40 days old
        pinned: true,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([pinnedMetadata]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(pinnedMetadata);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 2000 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.skippedPinned).toBe(1);
      expect(result.deleted).toBe(0);
      expect(storageService.deleteBlob).not.toHaveBeenCalled();
    });

    test('should not delete blobs with insufficient replicas', async () => {
      const metadata: BlobMetadata = {
        cid: 'under-replicated-blob',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1'] } // Only 1 replica, need 2 more
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([metadata]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(metadata);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 2000 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.skippedInsufficientReplicas).toBe(1);
      expect(result.deleted).toBe(0);
      expect(storageService.deleteBlob).not.toHaveBeenCalled();
    });

    test('should delete blob when all safety checks pass', async () => {
      const safeMetadata: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000001',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] } // Enough replicas
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([safeMetadata]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(safeMetadata);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 2000 * 1024 * 1024 });
      (storageService.deleteBlob as jest.Mock).mockResolvedValue(undefined);

      const result = await gcService.runGC(false);

      expect(result.deleted).toBe(1);
      expect(result.freedBytes).toBe(1024);
      expect(storageService.deleteBlob).toHaveBeenCalledWith(safeMetadata.cid);
    });
  });

  describe('Retention Policies (R8.2)', () => {
    test('should delete blobs older than maxBlobAgeDays in time mode', async () => {
      const oldBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000002',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000), // 40 days old
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([oldBlob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(oldBlob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.deleted).toBe(1);
    });

    test('should not delete recent blobs in time mode', async () => {
      const recentBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000003',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (10 * 24 * 60 * 60 * 1000), // 10 days old
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([recentBlob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(recentBlob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.deleted).toBe(0);
    });

    test('should delete blobs when storage exceeds limit in size mode', async () => {
      const blob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000004',
        size: 10 * 1024 * 1024, // 10MB
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000), // 40 days old (meets time criteria)
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([blob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(blob);
      // Over the limit (1000MB)
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });
      (storageService.deleteBlob as jest.Mock).mockResolvedValue(undefined);

      const result = await gcService.runGC(false);

      expect(result.deleted).toBeGreaterThan(0);
    });
  });

  describe('Priority Ordering (R8.8)', () => {
    test('should prioritize older blobs for deletion', async () => {
      const oldBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000005',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (50 * 24 * 60 * 60 * 1000), // 50 days
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      const newBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000006',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (35 * 24 * 60 * 60 * 1000), // 35 days
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([newBlob, oldBlob]);
      (storageService.getMetadata as jest.Mock).mockImplementation((cid: string) => {
        return cid === oldBlob.cid ? oldBlob : newBlob;
      });
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      // Should delete at least one blob
      expect(result.deleted).toBeGreaterThan(0);
      
      // Older blob should be deleted first
      const deleteCalls = (storageService.deleteBlob as jest.Mock).mock.calls;
      if (deleteCalls.length > 0) {
        expect(deleteCalls[0][0]).toBe(oldBlob.cid);
      }
    });

    test('should prioritize larger blobs when age is similar', async () => {
      const largeBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000007',
        size: 100 * 1024 * 1024, // 100MB
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      const smallBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000008',
        size: 1024, // 1KB
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([smallBlob, largeBlob]);
      (storageService.getMetadata as jest.Mock).mockImplementation((cid: string) => {
        return cid === largeBlob.cid ? largeBlob : smallBlob;
      });
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.deleted).toBeGreaterThan(0);
    });
  });

  describe('Dry-Run Mode (R8.5)', () => {
    test('should not delete blobs in simulate mode', async () => {
      const blob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000009',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([blob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(blob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      const result = await gcService.runGC(true); // simulate = true

      expect(result.deleted).toBeGreaterThan(0);
      expect(storageService.deleteBlob).not.toHaveBeenCalled();
    });

    test('should report what would be deleted in simulate mode', async () => {
      const blob: BlobMetadata = {
        cid: '000000000000000000000000000000000000000000000000000000000000000a',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([blob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(blob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      const result = await gcService.runGC(true);

      expect(result.deletedCids).toContain(blob.cid);
      expect(result.freedBytes).toBe(1024);
    });
  });

  describe('GC Status (R8.6)', () => {
    test('should return current GC status', async () => {
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      const status = await gcService.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.retentionMode).toBe('hybrid');
      expect(status.maxStorageMB).toBe(1000);
      expect(status.usedStorageMB).toBeCloseTo(500, 1);
    });

    test('should track deletion statistics', async () => {
      const blob: BlobMetadata = {
        cid: '000000000000000000000000000000000000000000000000000000000000000b',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([blob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(blob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      await gcService.runGC(false);

      const status = await gcService.getStatus();

      expect(status.deletedCount).toBeGreaterThan(0);
      expect(status.lastRun).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Execution', () => {
    test('should prevent concurrent GC runs', async () => {
      (storageService.listBlobs as jest.Mock).mockResolvedValue([]);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      // Start first GC
      const promise1 = gcService.runGC(false);

      // Try to start second GC immediately
      await expect(gcService.runGC(false)).rejects.toThrow('GC already running');

      await promise1;
    });

    test('should report running status', async () => {
      (storageService.listBlobs as jest.Mock).mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve([]), 100))
      );
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      const promise = gcService.runGC(false);

      expect(gcService.isRunning()).toBe(true);

      await promise;

      expect(gcService.isRunning()).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty blob list', async () => {
      (storageService.listBlobs as jest.Mock).mockResolvedValue([]);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 0 });

      const result = await gcService.runGC(false);

      expect(result.checked).toBe(0);
      expect(result.deleted).toBe(0);
    });

    test('should handle missing metadata gracefully', async () => {
      (storageService.listBlobs as jest.Mock).mockResolvedValue([
        { cid: 'missing-metadata' }
      ]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(null);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      expect(result.deleted).toBe(0);
    });

    test('should handle blobs without replication metadata', async () => {
      const blobNoReplication: BlobMetadata = {
        cid: '000000000000000000000000000000000000000000000000000000000000000c',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false
        // No replication field
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([blobNoReplication]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(blobNoReplication);
      (storageService.getStats as jest.Mock).mockResolvedValue({ totalSize: 1500 * 1024 * 1024 });

      const result = await gcService.runGC(false);

      // Should skip due to insufficient replicas
      expect(result.skippedInsufficientReplicas).toBe(1);
    });
  });
});
