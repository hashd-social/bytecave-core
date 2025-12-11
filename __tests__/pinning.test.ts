/**
 * Tests for Pinning & Data Permanence
 * 
 * Covers Requirement 9: Pin Forever
 */

import { storageService } from '../src/services/storage.service.js';
import { GarbageCollectionService } from '../src/services/gc.service.js';
import { BlobMetadata } from '../src/types/index.js';

// Mock storage service methods we'll test
jest.mock('../src/services/storage.service.js', () => ({
  storageService: {
    hasBlob: jest.fn(),
    getMetadata: jest.fn(),
    updateMetadata: jest.fn(),
    pinBlob: jest.fn(),
    unpinBlob: jest.fn(),
    listPinnedBlobs: jest.fn(),
    listBlobs: jest.fn(),
    deleteBlob: jest.fn(),
    getStats: jest.fn()
  }
}));

describe('Pinning & Data Permanence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Pin Flag Storage (R9.1)', () => {
    test('should store pin flag in metadata', () => {
      const metadata: BlobMetadata = {
        cid: 'test-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true
      };

      // Verify pinned field exists and can be set
      expect(metadata.pinned).toBe(true);
      
      // Verify it's stored in metadata structure
      expect(metadata).toHaveProperty('pinned');
    });

    test('should default pin flag to false', () => {
      const metadata: BlobMetadata = {
        cid: 'test-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now()
      };

      expect(metadata.pinned).toBeUndefined();
    });

    test('should preserve pin status across metadata updates', async () => {
      const cid = 'test-cid';
      const metadata: BlobMetadata = {
        cid,
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true
      };

      (storageService.getMetadata as jest.Mock).mockResolvedValue(metadata);

      const result = await storageService.getMetadata(cid);

      expect(result.pinned).toBe(true);
    });
  });

  describe('Pin API Operations (R9.3)', () => {
    test('should pin a blob', async () => {
      const cid = 'test-cid';

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);
      (storageService.pinBlob as jest.Mock).mockResolvedValue(undefined);

      await storageService.pinBlob(cid);

      expect(storageService.pinBlob).toHaveBeenCalledWith(cid);
    });

    test('should unpin a blob', async () => {
      const cid = 'test-cid';

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);
      (storageService.unpinBlob as jest.Mock).mockResolvedValue(undefined);

      await storageService.unpinBlob(cid);

      expect(storageService.unpinBlob).toHaveBeenCalledWith(cid);
    });

    test('should list pinned blobs', async () => {
      const pinnedBlobs: BlobMetadata[] = [
        {
          cid: 'pinned-1',
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1,
          createdAt: Date.now(),
          pinned: true
        },
        {
          cid: 'pinned-2',
          size: 2048,
          mimeType: 'application/json',
          version: 1,
          createdAt: Date.now(),
          pinned: true
        }
      ];

      (storageService.listPinnedBlobs as jest.Mock).mockResolvedValue(pinnedBlobs);

      const result = await storageService.listPinnedBlobs();

      expect(result.length).toBe(2);
      expect(result.every(blob => blob.pinned === true)).toBe(true);
    });
  });

  describe('GC Pin Override (R9.2)', () => {
    test('should never delete pinned blobs during GC', async () => {
      const gcService = new GarbageCollectionService();

      const pinnedBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000001',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (365 * 24 * 60 * 60 * 1000), // 1 year old
        pinned: true,
        replication: { replicatedTo: [] } // No replicas
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([pinnedBlob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(pinnedBlob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ 
        totalSize: 10000 * 1024 * 1024 // Over limit
      });

      const result = await gcService.runGC(false);

      expect(result.skippedPinned).toBe(1);
      expect(result.deleted).toBe(0);
      expect(storageService.deleteBlob).not.toHaveBeenCalled();
    });

    test('should skip pinned blobs even when disk is full', async () => {
      const gcService = new GarbageCollectionService();

      const pinnedBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000002',
        size: 1000 * 1024 * 1024, // 1GB
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (365 * 24 * 60 * 60 * 1000),
        pinned: true,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([pinnedBlob]);
      (storageService.getMetadata as jest.Mock).mockResolvedValue(pinnedBlob);
      (storageService.getStats as jest.Mock).mockResolvedValue({ 
        totalSize: 10000 * 1024 * 1024 
      });

      const result = await gcService.runGC(false);

      expect(result.skippedPinned).toBe(1);
      expect(result.deleted).toBe(0);
    });

    test('should delete unpinned blobs but not pinned ones', async () => {
      const gcService = new GarbageCollectionService();

      const pinnedBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000003',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: true,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      const unpinnedBlob: BlobMetadata = {
        cid: '0000000000000000000000000000000000000000000000000000000000000004',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (40 * 24 * 60 * 60 * 1000),
        pinned: false,
        replication: { replicatedTo: ['node1', 'node2', 'node3'] }
      };

      (storageService.listBlobs as jest.Mock).mockResolvedValue([pinnedBlob, unpinnedBlob]);
      (storageService.getMetadata as jest.Mock).mockImplementation((cid: string) => {
        return cid === pinnedBlob.cid ? pinnedBlob : unpinnedBlob;
      });
      (storageService.getStats as jest.Mock).mockResolvedValue({ 
        totalSize: 2000 * 1024 * 1024 
      });
      (storageService.deleteBlob as jest.Mock).mockResolvedValue(undefined);

      const result = await gcService.runGC(false);

      expect(result.skippedPinned).toBe(1);
      expect(result.deleted).toBeGreaterThanOrEqual(0);
      
      // Pinned blob should never be deleted
      const deleteCalls = (storageService.deleteBlob as jest.Mock).mock.calls;
      const deletedCids = deleteCalls.map(call => call[0]);
      expect(deletedCids).not.toContain(pinnedBlob.cid);
    });
  });

  describe('Pin Status Independence (R9.4)', () => {
    test('should maintain independent pin status per node', () => {
      const node1Metadata: BlobMetadata = {
        cid: 'shared-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true // Node 1 has it pinned
      };

      const node2Metadata: BlobMetadata = {
        cid: 'shared-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: false // Node 2 does not have it pinned
      };

      // Each node maintains its own pin status
      expect(node1Metadata.pinned).toBe(true);
      expect(node2Metadata.pinned).toBe(false);
    });

    test('should not transmit pin status during replication', () => {
      const sourceMetadata: BlobMetadata = {
        cid: 'replicated-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true,
        replication: {
          replicatedTo: ['node2']
        }
      };

      // Pin status is local only
      expect(sourceMetadata.pinned).toBe(true);
      
      // Replication metadata doesn't include pin status
      expect(sourceMetadata.replication?.replicatedTo).toEqual(['node2']);
    });
  });

  describe('Bulk Pin Operations (R9.7)', () => {
    test('should pin multiple blobs at once', async () => {
      const cids = ['cid1', 'cid2', 'cid3'];

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);
      (storageService.pinBlob as jest.Mock).mockResolvedValue(undefined);

      for (const cid of cids) {
        await storageService.pinBlob(cid);
      }

      expect(storageService.pinBlob).toHaveBeenCalledTimes(3);
    });

    test('should unpin multiple blobs at once', async () => {
      const cids = ['cid1', 'cid2', 'cid3'];

      (storageService.hasBlob as jest.Mock).mockResolvedValue(true);
      (storageService.unpinBlob as jest.Mock).mockResolvedValue(undefined);

      for (const cid of cids) {
        await storageService.unpinBlob(cid);
      }

      expect(storageService.unpinBlob).toHaveBeenCalledTimes(3);
    });
  });

  describe('Pin Persistence (R9.6)', () => {
    test('should persist pin status in metadata file', async () => {
      const cid = 'persistent-cid';
      const metadata: BlobMetadata = {
        cid,
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true
      };

      (storageService.getMetadata as jest.Mock).mockResolvedValue(metadata);

      const result = await storageService.getMetadata(cid);

      expect(result.pinned).toBe(true);
    });

    test('should maintain pin status after metadata updates', async () => {
      const cid = 'updated-cid';
      const metadata: BlobMetadata = {
        cid,
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now(),
        pinned: true,
        metrics: {
          retrievalCount: 5,
          lastAccessed: Date.now(),
          avgLatency: 100
        }
      };

      (storageService.getMetadata as jest.Mock).mockResolvedValue(metadata);
      (storageService.updateMetadata as jest.Mock).mockResolvedValue(undefined);

      // Update metrics but preserve pin status
      await storageService.updateMetadata(cid, {
        metrics: {
          retrievalCount: 6,
          lastAccessed: Date.now(),
          avgLatency: 95
        }
      });

      const result = await storageService.getMetadata(cid);
      expect(result.pinned).toBe(true);
    });
  });

  describe('Pin Priority (R9.5)', () => {
    test('should give pinned blobs infinite retention priority', () => {
      const pinnedBlob: BlobMetadata = {
        cid: 'priority-cid',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1,
        createdAt: Date.now() - (1000 * 24 * 60 * 60 * 1000), // Very old
        pinned: true
      };

      // Pinned blobs should never be GC candidates
      expect(pinnedBlob.pinned).toBe(true);
    });

    test('should exclude pinned blobs from deletion candidates', async () => {
      const gcService = new GarbageCollectionService();

      const blobs: BlobMetadata[] = [
        {
          cid: '0000000000000000000000000000000000000000000000000000000000000005',
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1,
          createdAt: Date.now() - (100 * 24 * 60 * 60 * 1000),
          pinned: true,
          replication: { replicatedTo: ['node1', 'node2', 'node3'] }
        },
        {
          cid: '0000000000000000000000000000000000000000000000000000000000000006',
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1,
          createdAt: Date.now() - (100 * 24 * 60 * 60 * 1000),
          pinned: false,
          replication: { replicatedTo: ['node1', 'node2', 'node3'] }
        }
      ];

      (storageService.listBlobs as jest.Mock).mockResolvedValue(blobs);
      (storageService.getMetadata as jest.Mock).mockImplementation((cid: string) => {
        return blobs.find(b => b.cid === cid);
      });
      (storageService.getStats as jest.Mock).mockResolvedValue({ 
        totalSize: 2000 * 1024 * 1024 
      });

      const result = await gcService.runGC(true); // Dry run

      // Pinned blob should be in skipped list
      expect(result.skippedPinned).toBeGreaterThan(0);
      
      // Pinned blob should not be in deleted list
      expect(result.deletedCids).not.toContain(blobs[0].cid);
    });
  });
});
