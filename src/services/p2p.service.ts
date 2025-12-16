/**
 * ByteCave Core - P2P Service
 * 
 * libp2p-based peer-to-peer discovery and communication
 * Works alongside the existing HTTP API for node-to-node communication
 */

import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { pipe } from 'it-pipe';
import { fromString, toString } from 'uint8arrays';
import { multiaddr } from '@multiformats/multiaddr';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

const ANNOUNCE_TOPIC = 'bytecave-announce';
const ANNOUNCE_INTERVAL = 60000; // 1 minute

export interface P2PPeerInfo {
  peerId: string;
  multiaddrs: string[];
  httpEndpoint?: string;
  contentTypes: string[] | 'all';
  latency?: number;
  lastSeen: number;
  reputation: number;
}

export interface P2PConfig {
  enableP2P: boolean;
  listenAddresses: string[];
  bootstrapPeers: string[];
  enableDHT: boolean;
  enableMDNS: boolean;
  enableRelay: boolean;
}

class P2PService extends EventEmitter {
  private node: Libp2p | null = null;
  private knownPeers: Map<string, P2PPeerInfo> = new Map();
  private announceTimer: NodeJS.Timeout | null = null;
  private started = false;

  async start(p2pConfig: P2PConfig): Promise<void> {
    if (!p2pConfig.enableP2P) {
      logger.info('P2P discovery disabled');
      return;
    }

    if (this.started) {
      logger.warn('P2P service already started');
      return;
    }

    logger.info('Starting P2P discovery service...');

    try {
      const services: any = {
        identify: identify()
      };

      const peerDiscovery: any[] = [];

      if (p2pConfig.enableDHT) {
        services.dht = kadDHT({
          clientMode: false
        });
      }

      services.pubsub = gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true
      });

      if (p2pConfig.enableMDNS) {
        peerDiscovery.push(mdns());
      }

      if (p2pConfig.bootstrapPeers.length > 0) {
        peerDiscovery.push(bootstrap({
          list: p2pConfig.bootstrapPeers
        }));
      }

      const transports = [tcp(), webSockets()];
      
      if (p2pConfig.enableRelay) {
        transports.push(circuitRelayTransport());
        services.relay = circuitRelayServer();
        services.dcutr = dcutr();
      }

      this.node = await createLibp2p({
        addresses: {
          listen: p2pConfig.listenAddresses
        },
        transports,
        connectionEncryption: [noise()],
        streamMuxers: [yamux()],
        services,
        peerDiscovery: peerDiscovery.length > 0 ? peerDiscovery : undefined
      });

      // Set up event listeners
      this.setupEventListeners();

      // Set up pubsub subscription
      await this.setupPubsub();

      // Start the node
      await this.node.start();

      this.started = true;

      const peerId = this.node.peerId.toString();
      const addrs = this.node.getMultiaddrs().map(ma => ma.toString());

      logger.info('P2P service started', {
        peerId,
        addresses: addrs,
        dht: p2pConfig.enableDHT,
        mdns: p2pConfig.enableMDNS,
        relay: p2pConfig.enableRelay
      });

      // Start periodic announcements
      this.startAnnouncements();

      this.emit('started', { peerId, addresses: addrs });
    } catch (error) {
      logger.error('Failed to start P2P service', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started || !this.node) {
      return;
    }

    logger.info('Stopping P2P service...');

    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }

    await this.node.stop();
    this.node = null;
    this.started = false;
    this.knownPeers.clear();

    logger.info('P2P service stopped');
    this.emit('stopped');
  }

  private setupEventListeners(): void {
    if (!this.node) return;

    this.node.addEventListener('peer:connect', (event) => {
      const peerId = event.detail.toString();
      logger.info('Peer connected via P2P', { peerId });
      this.emit('peer:connect', peerId);
    });

    this.node.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      logger.info('Peer disconnected', { peerId });
      this.emit('peer:disconnect', peerId);
    });

    this.node.addEventListener('peer:discovery', (event) => {
      const peerId = event.detail.id.toString();
      const addrs = event.detail.multiaddrs.map((ma: any) => ma.toString());
      logger.debug('Peer discovered', { peerId, addresses: addrs });
      
      // Update known peers
      const existing = this.knownPeers.get(peerId);
      this.knownPeers.set(peerId, {
        peerId,
        multiaddrs: addrs,
        contentTypes: existing?.contentTypes || 'all',
        lastSeen: Date.now(),
        reputation: existing?.reputation || 100
      });

      this.emit('peer:discovery', { peerId, addresses: addrs });
    });
  }

  private async setupPubsub(): Promise<void> {
    if (!this.node) return;

    const pubsub = this.node.services.pubsub as any;
    if (!pubsub) return;

    // Subscribe to announcement topic
    pubsub.subscribe(ANNOUNCE_TOPIC);

    pubsub.addEventListener('message', (event: any) => {
      if (event.detail.topic !== ANNOUNCE_TOPIC) return;

      try {
        const data = toString(event.detail.data);
        const announcement = JSON.parse(data);
        this.handleAnnouncement(announcement);
      } catch (error) {
        logger.warn('Failed to parse announcement', { error });
      }
    });
  }

  private handleAnnouncement(announcement: {
    peerId: string;
    httpEndpoint?: string;
    contentTypes: string[] | 'all';
    availableStorage: number;
    blobCount: number;
  }): void {
    const existing = this.knownPeers.get(announcement.peerId);

    const peerInfo: P2PPeerInfo = {
      peerId: announcement.peerId,
      multiaddrs: existing?.multiaddrs || [],
      httpEndpoint: announcement.httpEndpoint,
      contentTypes: announcement.contentTypes,
      lastSeen: Date.now(),
      reputation: existing?.reputation || 100
    };

    this.knownPeers.set(announcement.peerId, peerInfo);
    this.emit('peer:announce', peerInfo);

    logger.debug('Received peer announcement', {
      peerId: announcement.peerId,
      httpEndpoint: announcement.httpEndpoint,
      contentTypes: announcement.contentTypes
    });
  }

  private startAnnouncements(): void {
    // Announce immediately
    this.announce();

    // Then announce periodically
    this.announceTimer = setInterval(() => {
      this.announce();
    }, ANNOUNCE_INTERVAL);
  }

  private async announce(): Promise<void> {
    if (!this.node) return;

    const pubsub = this.node.services.pubsub as any;
    if (!pubsub) return;

    try {
      const announcement = {
        peerId: this.node.peerId.toString(),
        httpEndpoint: config.nodeUrl,
        contentTypes: config.contentTypes || 'all',
        availableStorage: config.gcMaxStorageMB * 1024 * 1024,
        blobCount: 0, // Will be updated by storage service
        timestamp: Date.now()
      };

      await pubsub.publish(
        ANNOUNCE_TOPIC,
        fromString(JSON.stringify(announcement))
      );

      logger.debug('Published P2P announcement');
    } catch (error) {
      logger.warn('Failed to publish announcement', { error });
    }
  }

  // Public API

  getPeerId(): string | null {
    return this.node?.peerId.toString() || null;
  }

  getMultiaddrs(): string[] {
    return this.node?.getMultiaddrs().map(ma => ma.toString()) || [];
  }

  getKnownPeers(): P2PPeerInfo[] {
    return Array.from(this.knownPeers.values());
  }

  getConnectedPeers(): string[] {
    if (!this.node) return [];
    return this.node.getPeers().map(p => p.toString());
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Get peers that accept a specific content type
   */
  getPeersForContentType(contentType: string): P2PPeerInfo[] {
    return Array.from(this.knownPeers.values()).filter(peer => {
      if (peer.contentTypes === 'all') return true;
      return peer.contentTypes.includes(contentType);
    });
  }

  /**
   * Get HTTP endpoints of known peers (for fallback/hybrid mode)
   */
  getHttpEndpoints(): string[] {
    return Array.from(this.knownPeers.values())
      .filter(p => p.httpEndpoint)
      .map(p => p.httpEndpoint!);
  }

  /**
   * Connect to a peer by multiaddr
   */
  async connectToPeer(addr: string): Promise<boolean> {
    if (!this.node) return false;

    try {
      const ma = multiaddr(addr);
      await this.node.dial(ma);
      return true;
    } catch (error) {
      logger.warn('Failed to connect to peer', { addr, error });
      return false;
    }
  }

  /**
   * Update announcement with current storage stats
   */
  updateStorageStats(blobCount: number, storageUsed: number): void {
    // This will be included in the next announcement
    // For now, just trigger an immediate announcement
    this.announce();
  }
}

export const p2pService = new P2PService();
