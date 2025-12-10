/**
 * HASHD Vault - Metrics Service
 * 
 * Tracks node performance metrics for reputation scoring
 */

import { config } from '../config/index.js';
import { Metrics } from '../types/index.js';

export class MetricsService {
  private metrics: Metrics;
  private requestTimestamps: number[] = [];
  private latencies: number[] = [];
  private readonly MAX_LATENCY_SAMPLES = 1000;

  constructor() {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      requestsLastHour: 0,
      bandwidthServed: 0,
      replicationCount: 0,
      replicationFailures: 0,
      startTime: Date.now()
    };
  }

  /**
   * Record a request
   */
  recordRequest(success: boolean, latency: number, bytesServed: number = 0): void {
    if (!config.metricsEnabled) return;

    this.metrics.totalRequests++;
    
    if (success) {
      this.metrics.successfulRequests++;
    } else {
      this.metrics.failedRequests++;
    }

    this.metrics.bandwidthServed += bytesServed;

    // Track latency
    this.latencies.push(latency);
    if (this.latencies.length > this.MAX_LATENCY_SAMPLES) {
      this.latencies.shift();
    }
    this.metrics.avgLatency = this.calculateAvgLatency();

    // Track request timestamp
    const now = Date.now();
    this.requestTimestamps.push(now);

    // Clean old timestamps (older than 1 hour)
    const oneHourAgo = now - 3600000;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > oneHourAgo);
    this.metrics.requestsLastHour = this.requestTimestamps.length;
  }

  /**
   * Record replication
   */
  recordReplication(success: boolean): void {
    if (!config.metricsEnabled) return;

    if (success) {
      this.metrics.replicationCount++;
    } else {
      this.metrics.replicationFailures++;
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): Metrics {
    return { ...this.metrics };
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.metrics.startTime) / 1000);
  }

  /**
   * Get success rate
   */
  getSuccessRate(): number {
    if (this.metrics.totalRequests === 0) return 1.0;
    return this.metrics.successfulRequests / this.metrics.totalRequests;
  }

  /**
   * Get replication success rate
   */
  getReplicationSuccessRate(): number {
    const total = this.metrics.replicationCount + this.metrics.replicationFailures;
    if (total === 0) return 1.0;
    return this.metrics.replicationCount / total;
  }

  /**
   * Reset metrics
   */
  reset(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgLatency: 0,
      requestsLastHour: 0,
      bandwidthServed: 0,
      replicationCount: 0,
      replicationFailures: 0,
      startTime: Date.now()
    };
    this.requestTimestamps = [];
    this.latencies = [];
  }

  /**
   * Private helper methods
   */

  private calculateAvgLatency(): number {
    if (this.latencies.length === 0) return 0;
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    return sum / this.latencies.length;
  }
}

export const metricsService = new MetricsService();
