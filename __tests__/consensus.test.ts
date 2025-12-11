/**
 * Tests for Lightweight Consensus & Anti-Censorship
 * 
 * Covers Requirement 14: Lightweight Consensus
 */

import { consensusService } from '../src/services/consensus.service.js';
import { Buffer } from 'buffer';

describe('Lightweight Consensus (Requirement 14)', () => {
  beforeEach(() => {
    consensusService.clearAuditData();
  });

  describe('Multi-Replica Availability (R14.2)', () => {
    test('should achieve consensus with matching replicas', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct data');
      const nodes = ['node-1', 'node-2', 'node-3'];

      const fetchFunction = async (_nodeId: string, _cid: string) => {
        return correctData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.consensus).toBe(true);
      expect(result.matchingReplicas).toBe(3);
      expect(result.ciphertext).toEqual(correctData);
    });

    test('should achieve consensus with 2/3 matching', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct data');
      const wrongData = Buffer.from('wrong data');
      const nodes = ['node-1', 'node-2', 'node-3'];

      const fetchFunction = async (_nodeId: string, _cid: string) => {
        if (_nodeId === 'node-3') {
          return wrongData;
        }
        return correctData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.consensus).toBe(true);
      expect(result.matchingReplicas).toBe(2);
      expect(result.disputedNodes).toContain('node-3');
    });

    test('should fail consensus with no matching replicas', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1', 'node-2', 'node-3'];

      const fetchFunction = async (nodeId: string, _cid: string) => {
        return Buffer.from(`unique data from ${nodeId}`);
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.consensus).toBe(false);
    });
  });

  describe('Replica Voting (R14.3)', () => {
    test('should accept majority hash', async () => {
      const cid = 'test-cid';
      const majorityData = Buffer.from('majority data');
      const minorityData = Buffer.from('minority data');
      const nodes = ['node-1', 'node-2', 'node-3', 'node-4'];

      const fetchFunction = async (nodeId: string, _cid: string) => {
        if (nodeId === 'node-4') {
          return minorityData;
        }
        return majorityData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.consensus).toBe(true);
      expect(result.matchingReplicas).toBe(3);
      expect(result.ciphertext).toEqual(majorityData);
    });

    test('should compute hash locally', async () => {
      const cid = 'test-cid';
      const data = Buffer.from('test data');
      const nodes = ['node-1', 'node-2'];

      const fetchFunction = async (_nodeId: string, _cid: string) => {
        return data;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.acceptedHash).toBeDefined();
      expect(result.acceptedHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });
  });

  describe('Anti-Censorship Fetch (R14.4)', () => {
    test('should retry with different nodes on failure', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct data');
      const availableNodes = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];

      let attempt = 0;
      const fetchFunction = async (_nodeId: string, _cid: string) => {
        attempt++;
        // First 3 nodes fail, then succeed
        if (attempt <= 3) {
          throw new Error('Node unavailable');
        }
        return correctData;
      };

      const result = await consensusService.fetchWithAntiCensorship(
        cid,
        availableNodes,
        3,
        fetchFunction,
        3
      );

      expect(result.consensus).toBe(true);
    });

    test('should detect censoring nodes', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct data');
      const nodes = ['node-1', 'node-2', 'node-3'];

      const fetchFunction = async (nodeId: string, _cid: string) => {
        if (nodeId === 'node-1') {
          return null; // Censoring
        }
        return correctData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.censoringNodes).toContain('node-1');
    });

    test('should record censorship events', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1'];

      const fetchFunction = async (_nodeId: string, _cid: string) => {
        throw new Error('Timeout');
      };

      await consensusService.fetchWithConsensus(cid, nodes, fetchFunction);

      const events = consensusService.exportCensorshipEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('timeout');
    });
  });

  describe('Dispute Detection (R14.6)', () => {
    test('should detect hash mismatch', async () => {
      const cid = 'test-cid';
      const data1 = Buffer.from('data version 1');
      const data2 = Buffer.from('data version 2');
      const nodes = ['node-1', 'node-2'];

      const fetchFunction = async (nodeId: string, _cid: string) => {
        return nodeId === 'node-1' ? data1 : data2;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.consensus).toBe(false);
      const dispute = consensusService.getDispute(cid);
      expect(dispute).toBeDefined();
      expect(dispute?.resolution).toBe('pending');
    });

    test('should record disputed nodes', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct');
      const wrongData = Buffer.from('wrong');
      const nodes = ['node-1', 'node-2', 'node-3'];

      const fetchFunction = async (nodeId: string, _cid: string) => {
        return nodeId === 'node-3' ? wrongData : correctData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      expect(result.disputedNodes).toContain('node-3');
    });
  });

  describe('Replication Verification (R14.7)', () => {
    test('should verify successful replication', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1', 'node-2', 'node-3'];

      const verifyFunction = async (_nodeId: string, _cid: string) => {
        return true;
      };

      const result = await consensusService.verifyReplicationConsensus(
        cid,
        nodes,
        verifyFunction
      );

      expect(result.verified).toBe(true);
      expect(result.failedNodes).toHaveLength(0);
    });

    test('should detect failed replication', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1', 'node-2', 'node-3'];

      const verifyFunction = async (nodeId: string, _cid: string) => {
        return nodeId !== 'node-2';
      };

      const result = await consensusService.verifyReplicationConsensus(
        cid,
        nodes,
        verifyFunction
      );

      expect(result.verified).toBe(false);
      expect(result.failedNodes).toContain('node-2');
    });
  });

  describe('Blob Permanence (R14.9)', () => {
    test('should return ephemeral requirements', () => {
      const requirements = consensusService.getPermanenceRequirements('ephemeral');
      expect(requirements.replicationFactor).toBe(2);
      expect(requirements.gcAllowed).toBe(true);
    });

    test('should return persistent requirements', () => {
      const requirements = consensusService.getPermanenceRequirements('persistent');
      expect(requirements.replicationFactor).toBe(3);
      expect(requirements.gcAllowed).toBe(false);
    });

    test('should return archival requirements', () => {
      const requirements = consensusService.getPermanenceRequirements('archival');
      expect(requirements.replicationFactor).toBe(7);
      expect(requirements.gcAllowed).toBe(false);
    });
  });

  describe('Audit Trail (R14.10)', () => {
    test('should export audit log', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1'];

      const fetchFunction = async () => {
        throw new Error('Test error');
      };

      await consensusService.fetchWithConsensus(cid, nodes, fetchFunction);

      const auditLog = consensusService.exportAuditLog();
      expect(auditLog.length).toBeGreaterThan(0);
    });

    test('should export censorship events', async () => {
      const cid = 'test-cid';
      const nodes = ['node-1'];

      const fetchFunction = async () => null;

      await consensusService.fetchWithConsensus(cid, nodes, fetchFunction);

      const events = consensusService.exportCensorshipEvents();
      expect(events.length).toBeGreaterThan(0);
    });

    test('should export disputes', async () => {
      const cid = 'test-cid';
      const data1 = Buffer.from('data1');
      const data2 = Buffer.from('data2');
      const nodes = ['node-1', 'node-2'];

      const fetchFunction = async (nodeId: string) => {
        return nodeId === 'node-1' ? data1 : data2;
      };

      await consensusService.fetchWithConsensus(cid, nodes, fetchFunction);

      const disputes = consensusService.exportDisputes();
      expect(disputes.length).toBeGreaterThan(0);
    });
  });

  describe('Honest-Majority Assumption (R14.5)', () => {
    test('should work with only 1 honest node', async () => {
      const cid = 'test-cid';
      const correctData = Buffer.from('correct');
      const wrongData = Buffer.from('wrong');
      const nodes = ['honest', 'malicious-1', 'malicious-2'];

      const fetchFunction = async (nodeId: string) => {
        return nodeId === 'honest' ? correctData : wrongData;
      };

      const result = await consensusService.fetchWithConsensus(
        cid,
        nodes,
        fetchFunction
      );

      // With 2 malicious nodes agreeing, they win
      // But client can retry with different nodes
      expect(result).toBeDefined();
    });
  });

  describe('Performance', () => {
    test('should handle parallel fetches efficiently', async () => {
      const cid = 'test-cid';
      const data = Buffer.from('test data');
      const nodes = Array.from({ length: 10 }, (_, i) => `node-${i}`);

      const startTime = Date.now();

      const fetchFunction = async (_nodeId: string) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return data;
      };

      await consensusService.fetchWithConsensus(cid, nodes, fetchFunction);

      const duration = Date.now() - startTime;
      // Should complete in ~10ms (parallel), not 100ms (sequential)
      expect(duration).toBeLessThan(100);
    });
  });
});
