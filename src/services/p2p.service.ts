/**
 * ByteCave Core - P2P Service
 * 
 * libp2p-based peer-to-peer discovery and communication
 * Works alongside the existing HTTP API for node-to-node communication
 */

import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
// webRTC import commented out - not needed for server-side nodes
// import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { floodsub } from '@libp2p/floodsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
// pipe imported for future protocol handlers
// import { pipe } from 'it-pipe';
import { fromString, toString } from 'uint8arrays';
import { multiaddr } from '@multiformats/multiaddr';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { config, getConfigManager } from '../config/index.js';
import { p2pProtocolsService } from './p2p-protocols.service.js';
import { peerCacheService } from './peer-cache.service.js';

const ANNOUNCE_TOPIC = 'bytecave-announce';
const BROADCAST_TOPIC = 'bytecave-broadcast';
const SIGNALING_TOPIC_PREFIX = 'bytecave-signaling-';
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
  relayPeers: string[];
  enableDHT: boolean;
  enableMDNS: boolean;
  enableRelay: boolean;
}

class P2PService extends EventEmitter {
  private node: Libp2p | null = null;
  private knownPeers: Map<string, P2PPeerInfo> = new Map();
  private announceTimer: NodeJS.Timeout | null = null;
  private started = false;

async start(): Promise<void> {
    if (this.started) {
      logger.warn('P2P service already started');
      return;
    }

    logger.info('Starting P2P service...');
    await peerCacheService.load();

    if (!config.p2pEnabled) {
      logger.info('P2P discovery disabled');
      return;
    }

    try {
      const peerDiscovery: any[] = [];

      // --- FIX 1: Aggressive Identify Service ---
      // We must explicitly configure identify to run immediately on connection
      const services: any = {
        identify: identify()
      };

      if (config.p2pEnableDHT) {
        services.dht = kadDHT({
          clientMode: false,
          // Optimizing DHT for local networks can help discovery speed
          kBucketSize: 20
        });
      }

      // Use FloodSub - simple flooding protocol that works reliably in small networks
      // No mesh formation complexity, messages flood to all connected peers
      services.pubsub = floodsub();

      // ... (Rest of Discovery logic: MDNS, Bootstrap - same as before) ...
      if (config.p2pEnableMDNS) peerDiscovery.push(mdns());

      const cachedPeers = peerCacheService.getBootstrapPeers();
      const allBootstrapPeers = [...config.p2pBootstrapPeers, ...config.p2pRelayPeers, ...cachedPeers];

      if (allBootstrapPeers.length > 0) {
        peerDiscovery.push(bootstrap({ list: allBootstrapPeers }));
      }

      // ... (Transports setup - same as before) ...
      const transports: any[] = [tcp(), webSockets()];
      if (config.p2pEnableRelay) {
        transports.push(circuitRelayTransport());
        services.relay = circuitRelayServer();
        services.dcutr = dcutr();
      }

      this.node = await createLibp2p({
        addresses: { listen: config.p2pListenAddresses },
        transports,
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services,
        peerDiscovery: peerDiscovery.length > 0 ? peerDiscovery : undefined,
        connectionManager: {
          maxConnections: 100,
          dialTimeout: 30000
        }
      });

      // Log identify completion for debugging
      this.node.addEventListener('peer:identify', (evt) => {
        const peerId = evt.detail.peerId;
        const protocols = evt.detail.protocols;
        const hasFloodsub = protocols.includes('/floodsub/1.0.0');
        
        logger.info('✅ Identify complete for peer', { 
          peerId: peerId.toString().slice(0, 16) + '...', 
          hasFloodsub
        });
      });

      this.setupEventListeners();
      await this.node.start();
      logger.info('Node started');

      // Setup pubsub immediately
      await this.setupPubsub();
      
      // Register custom protocols
      p2pProtocolsService.registerProtocols(this.node);

      this.started = true;
      this.startAnnouncements();
      
      const peerId = this.node.peerId.toString();
      const addrs = this.node.getMultiaddrs().map(ma => ma.toString());
      this.emit('started', { peerId, addresses: addrs });

    } catch (error) {
      logger.error('Failed to start P2P service', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    logger.info('Stopping P2P service...');

    // Flush peer cache before stopping
    await peerCacheService.flush();

    // Stop announcements
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }

    // Unregister protocol handlers
    if (this.node) {
      p2pProtocolsService.unregisterProtocols();
      await this.node.stop();
      this.node = null;
    }

    this.started = false;

    logger.info('P2P service stopped');
    this.emit('stopped');
  }

  private setupEventListeners(): void {
    if (!this.node) return;

    this.node.addEventListener('peer:connect', async (event) => {
      const peerId = event.detail.toString();
      
      // Log connection details including transport type
      const connections = this.node?.getConnections(event.detail);
      const connectionInfo = connections?.map(conn => ({
        remoteAddr: conn.remoteAddr?.toString(),
        transport: conn.remoteAddr?.toString().includes('/p2p-circuit/') ? 'RELAY' : 'DIRECT',
        protocols: conn.streams.map(s => s.protocol)
      }));
      
      logger.info('Peer connected', { 
        peerId: peerId.slice(0, 16) + '...',
        connectionCount: connections?.length || 0,
        connections: connectionInfo
      });
      
      // Cache this peer for future bootstrap
      const peer = this.node?.getPeers().find(p => p.toString() === peerId);
      if (peer) {
        const addrs = this.node?.getConnections(peer)
          .flatMap(conn => conn.remoteAddr ? [conn.remoteAddr.toString()] : []) || [];
        if (addrs.length > 0) {
          peerCacheService.addPeer(peerId, addrs);
          
          // Save discovered peer to bootstrap peers in config.json
          // This allows the node to reconnect to this peer on restart
          const configManager = getConfigManager(config.dataDir);
          for (const addr of addrs) {
            // Only save non-relay addresses (direct connections)
            if (!addr.includes('/p2p-circuit/')) {
              const fullAddr = addr.includes(peerId) ? addr : `${addr}/p2p/${peerId}`;
              const added = configManager.addBootstrapPeer(fullAddr);
              if (added) {
                logger.info('Saved peer to bootstrap peers', { multiaddr: fullAddr });
              }
            }
          }
        }
      }
      
      this.emit('peer:connect', peerId);
    });

    this.node.addEventListener('peer:disconnect', (event) => {
      const peerId = event.detail.toString();
      logger.info('Peer disconnected', { peerId: peerId.slice(0, 16) + '...' });
      this.emit('peer:disconnect', peerId);
    });

    // Listen for connection upgrades (DCUTR success)
    this.node.addEventListener('connection:open', (event) => {
      const conn = event.detail;
      const isRelay = conn.remoteAddr?.toString().includes('/p2p-circuit/');
      logger.info('Connection opened', {
        peerId: conn.remotePeer.toString().slice(0, 16) + '...',
        type: isRelay ? 'RELAY' : 'DIRECT',
        remoteAddr: conn.remoteAddr?.toString()
      });
    });

    this.node.addEventListener('connection:close', (event) => {
      const conn = event.detail;
      logger.info('Connection closed', {
        peerId: conn.remotePeer.toString().slice(0, 16) + '...',
        remoteAddr: conn.remoteAddr?.toString()
      });
    });

    this.node.addEventListener('peer:discovery', async (event) => {
      const peerId = event.detail.id.toString();
      const addrs = event.detail.multiaddrs.map((ma: any) => ma.toString());
      logger.info('Peer discovered via DHT', { peerId: peerId.slice(0, 16) + '...', addressCount: addrs.length });
      
      // Update known peers
      const existing = this.knownPeers.get(peerId);
      this.knownPeers.set(peerId, {
        peerId,
        multiaddrs: addrs,
        contentTypes: existing?.contentTypes || 'all',
        lastSeen: Date.now(),
        reputation: existing?.reputation || 100
      });

      // Automatically dial discovered peers to form mesh
      try {
        if (this.node && addrs.length > 0) {
          await this.node.dial(event.detail.id);
          logger.info('Connected to discovered peer', { peerId: peerId.slice(0, 16) + '...' });
        }
      } catch (error: any) {
        logger.debug('Failed to dial discovered peer', { peerId: peerId.slice(0, 16) + '...', error: error.message });
      }

      this.emit('peer:discovery', { peerId, addresses: addrs });
    });
  }

  private async setupPubsub(): Promise<void> {
    if (!this.node) return;

    const pubsub = this.node.services.pubsub as any;
    if (!pubsub) {
      logger.error('Pubsub service not found!');
      return;
    }

    // Subscribe to announcement topic
    pubsub.subscribe(ANNOUNCE_TOPIC);

    // Subscribe to broadcast topic for peer messages
    pubsub.subscribe(BROADCAST_TOPIC);
    logger.info('Subscribed to broadcast topic');

    // Log floodsub status periodically
    setInterval(() => {
      const subscribers = pubsub.getSubscribers?.(BROADCAST_TOPIC) || [];
      const allPubsubPeers = pubsub.getPeers?.() || [];
      const connectedPeers = this.node?.getPeers() || [];
      
      // Check which peers support floodsub protocol
      const peerProtocols = connectedPeers.map(peerId => {
        const conns = this.node?.getConnections(peerId) || [];
        const protocols = conns.flatMap(c => c.streams.map(s => s.protocol));
        return {
          peerId: peerId.toString().slice(0, 16) + '...',
          streamProtocols: [...new Set(protocols)],
          connectionCount: conns.length,
          streamCount: conns.reduce((sum, c) => sum + c.streams.length, 0),
          hasFloodsub: protocols.includes('/floodsub/1.0.0')
        };
      });
      
      logger.info('FloodSub status', {
        nodeId: config.nodeId,
        subscribers: subscribers.length,
        totalPubsubPeers: allPubsubPeers.length,
        totalConnectedPeers: connectedPeers.length,
        subscriberIds: subscribers.map((p: any) => p.toString().slice(0, 16) + '...'),
        pubsubPeerIds: allPubsubPeers.map((p: any) => p.toString().slice(0, 16) + '...'),
        peerProtocols
      });
    }, 10000);

    // Subscribe to our own signaling topic for WebRTC offers from browsers
    const mySignalingTopic = `${SIGNALING_TOPIC_PREFIX}${this.node.peerId.toString()}`;
    pubsub.subscribe(mySignalingTopic);
    logger.info('Subscribed to signaling topic', { topic: mySignalingTopic });

    pubsub.addEventListener('message', (event: any) => {
      const topic = event.detail.topic;
      
      // Handle announcements
      if (topic === ANNOUNCE_TOPIC) {
        try {
          const data = toString(event.detail.data);
          const announcement = JSON.parse(data);
          this.handleAnnouncement(announcement);
        } catch (error) {
          logger.warn('Failed to parse announcement', { error });
        }
        return;
      }

      // Handle broadcast messages
      if (topic === BROADCAST_TOPIC) {
        try {
          const data = toString(event.detail.data);
          const broadcast = JSON.parse(data);
          
          // Ignore bootstrap messages (mesh formation only)
          if (broadcast.type === 'bootstrap') {
            logger.debug('Received bootstrap message', {
              from: broadcast.from?.slice(0, 16) + '...'
            });
            return;
          }
          
          this.emit('broadcast', broadcast);
          logger.info('Received broadcast message', { 
            from: broadcast.from?.slice(0, 16) + '...',
            message: broadcast.message?.slice(0, 50) 
          });
        } catch (error) {
          logger.warn('Failed to parse broadcast message', { error });
        }
        return;
      }

      // Handle signaling messages (WebRTC offers from browsers)
      if (topic === mySignalingTopic) {
        try {
          const data = toString(event.detail.data);
          const signal = JSON.parse(data);
          this.handleSignalingMessage(signal);
        } catch (error) {
          logger.warn('Failed to parse signaling message', { error });
        }
        return;
      }
    });
  }

  private async handleSignalingMessage(signal: {
    type: 'offer' | 'answer' | 'ice-candidate';
    from: string;
    sdp?: string;
    candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number };
  }): Promise<void> {
    logger.info('Received signaling message', { type: signal.type, from: signal.from });
    
    // Emit event for external handling (e.g., by a WebRTC manager)
    this.emit('signaling', signal);
    
    // For now, just log - actual WebRTC handling will be added when browser client is ready
    // The browser will send SDP offers, and we'll respond with answers
  }

  /**
   * Send a signaling message to a specific peer (for WebRTC negotiation)
   */
  async sendSignalingMessage(targetPeerId: string, signal: {
    type: 'offer' | 'answer' | 'ice-candidate';
    sdp?: string;
    candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number };
  }): Promise<void> {
    if (!this.node) return;

    const pubsub = this.node.services.pubsub as any;
    if (!pubsub) return;

    const targetTopic = `${SIGNALING_TOPIC_PREFIX}${targetPeerId}`;
    const message = {
      ...signal,
      from: this.node.peerId.toString()
    };

    try {
      await pubsub.publish(targetTopic, fromString(JSON.stringify(message)));
      logger.debug('Sent signaling message', { targetPeerId, type: signal.type });
    } catch (error) {
      logger.warn('Failed to send signaling message', { targetPeerId, error });
    }
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
        nodeId: config.nodeId, // Add nodeId for identification
        httpEndpoint: config.nodeUrl,
        contentTypes: config.contentFilter.types || 'all',
        availableStorage: config.gcMaxStorageMB * 1024 * 1024,
        blobCount: 0, // Will be updated by storage service
        timestamp: Date.now()
      };

      await pubsub.publish(
        ANNOUNCE_TOPIC,
        fromString(JSON.stringify(announcement))
      );

      logger.info('Published P2P announcement', { 
        nodeId: announcement.nodeId,
        peerId: announcement.peerId.slice(0, 16) + '...',
        httpEndpoint: announcement.httpEndpoint 
      });
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
   * Broadcast a message to all connected peers
   */
  async broadcastMessage(message: string): Promise<void> {
    if (!this.node) throw new Error('P2P node not started');

    const pubsub = this.node.services.pubsub as any;
    if (!pubsub) throw new Error('Pubsub not available');

    const broadcast = {
      from: this.node.peerId.toString(),
      message,
      timestamp: Date.now()
    };

    // Get gossipsub peers for debugging
    const peers = pubsub.getSubscribers ? pubsub.getSubscribers(BROADCAST_TOPIC) : [];
    logger.info('Publishing broadcast', { 
      message: message.slice(0, 50),
      subscriberCount: peers.length,
      subscribers: peers.map((p: any) => p.toString().slice(0, 16) + '...')
    });

    await pubsub.publish(
      BROADCAST_TOPIC,
      fromString(JSON.stringify(broadcast))
    );

    logger.info('Broadcast message sent', { message: message.slice(0, 50) });
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
  updateStorageStats(_blobCount: number, _storageUsed: number): void {
    // This will be included in the next announcement
    // For now, just trigger an immediate announcement
    this.announce();
  }
}

export const p2pService = new P2PService();
