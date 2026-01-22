/**
 * ByteCave Core - P2P Service
 * 
 * libp2p-based peer-to-peer discovery and communication
 * Works alongside the existing HTTP API for node-to-node communication
 */

import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { floodsub } from '@libp2p/floodsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
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
import { meshnetService } from './meshnet.service.js';
import fs from 'fs/promises';
import path from 'path';

const ANNOUNCE_TOPIC = 'bytecave-announce';
const BROADCAST_TOPIC = 'bytecave-broadcast';
const SIGNALING_TOPIC_PREFIX = 'bytecave-signaling-';
const ANNOUNCE_INTERVAL = 60000; // 1 minute

export interface P2PPeerInfo {
  peerId: string;
  multiaddrs: string[];
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
  private secp256k1PublicKey: string | null = null;
  private secp256k1PrivateKey: Buffer | null = null;

  /**
   * Load or generate persistent libp2p private key
   * This ensures the peerId stays the same across restarts
   */
  private async loadOrGeneratePrivateKey(): Promise<any> {
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { createHash } = await import('crypto');
    
    // If owner address is configured, derive P2P identity deterministically from it
    // This ensures one consistent peer ID per wallet address
    if (config.ownerAddress && config.ownerAddress !== '') {
      logger.info('Deriving P2P identity from owner address (ECDSA secp256k1)', { 
        owner: config.ownerAddress.slice(0, 10) + '...' 
      });
      
      // Derive a deterministic 32-byte seed from the owner address
      // This seed will be used as the ECDSA private key
      const seed = createHash('sha256')
        .update('bytecave-p2p-identity')
        .update(config.ownerAddress.toLowerCase())
        .digest();
      
      // Store the raw secp256k1 private key for signature generation
      this.secp256k1PrivateKey = seed;
      
      // Use secp256k1 (ECDSA) instead of Ed25519 for Ethereum compatibility
      // This allows on-chain signature verification using ecrecover
      const { privateKeyFromRaw } = await import('@libp2p/crypto/keys');
      const privateKey = privateKeyFromRaw(seed);
      
      logger.info('P2P identity derived from owner address (ECDSA)', {
        keyType: privateKey.type
      });
      return privateKey;
    }
    
    // Fallback: Use file-based identity for nodes without owner address
    const { privateKeyFromProtobuf, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const keyPath = path.join(config.dataDir, 'p2p-identity.json');
    
    try {
      const keyData = JSON.parse(await fs.readFile(keyPath, 'utf8'));
      const privateKey = privateKeyFromProtobuf(Buffer.from(keyData.privateKey, 'base64'));
      logger.info('Loaded existing P2P identity from file');
      return privateKey;
    } catch (error) {
      logger.info('Generating new random P2P identity...');
      const privateKey = await generateKeyPair('Ed25519');
      
      const keyData = {
        privateKey: Buffer.from(privateKeyToProtobuf(privateKey)).toString('base64')
      };
      await fs.writeFile(keyPath, JSON.stringify(keyData, null, 2), { mode: 0o600 });
      logger.info('P2P identity saved to file');
      
      return privateKey;
    }
  }

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
      // Load or generate persistent libp2p private key
      const privateKey = await this.loadOrGeneratePrivateKey();
      
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
      const transports: any[] = [
        tcp(), 
        webSockets(),
        webRTC() // Enable WebRTC for browser-to-node P2P connections
      ];
      if (config.p2pEnableRelay) {
        // Add circuit relay transport for being reachable through relay
        transports.push(circuitRelayTransport({
          reservationCompletionTimeout: 10000
        }));
        services.dcutr = dcutr();
      }

      // Add circuit relay listen address if relay is enabled
      const listenAddresses = [...config.p2pListenAddresses];
      if (config.p2pEnableRelay && config.p2pRelayPeers.length > 0) {
        // Add circuit relay listen address to trigger automatic reservations
        listenAddresses.push('/p2p-circuit');
        logger.info('Circuit relay enabled - will listen on /p2p-circuit');
      }

      // Add WebRTC listen addresses for direct browser connections
      // WebRTC uses UDP and doesn't require specific port configuration
      // The browser will use the WebRTC transport to connect directly
      listenAddresses.push('/webrtc');
      logger.info('WebRTC transport enabled for direct browser connections');

      this.node = await createLibp2p({
        privateKey,
        addresses: { listen: listenAddresses },
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

      // Log identify completion and manually request circuit relay reservation
      this.node.addEventListener('peer:identify', async (evt) => {
        const { peerId, protocols } = evt.detail;
        const hasFloodsub = protocols.some(p => p === '/floodsub/1.0.0');
        const hasCircuitRelay = protocols.some(p => p.includes('/libp2p/circuit/relay/0.2.0/hop'));
        logger.info('✅ Identify complete for peer', { 
          peerId: peerId.toString().slice(0, 16) + '...', 
          hasFloodsub,
          hasCircuitRelay,
          protocols: protocols.slice(0, 10) // Log first 10 protocols
        });

        // Circuit relay detected - automatic reservation should happen via transport
        if (hasCircuitRelay && config.p2pEnableRelay) {
          logger.info('Circuit relay server detected - automatic reservation should be triggered', { 
            peerId: peerId.toString().slice(0, 16) + '...' 
          });
        }
      });

      this.setupEventListeners();
      await this.node.start();
      logger.info('Node started');
      
      // Log available transports and manually trigger circuit relay reservation
      const components = (this.node as any).components;
      if (components?.transportManager) {
        const transports = components.transportManager.getTransports();
        logger.info('Available transports', { transports: transports.map((t: any) => t.constructor.name) });
        
        // Find circuit relay transport and access its reservation store
        const circuitTransport = transports.find((t: any) => t.constructor.name === 'CircuitRelayTransport');
        if (circuitTransport && config.p2pRelayPeers.length > 0) {
          logger.info('Circuit relay transport found - manually triggering reservations');
          
          // Access the reservation store and manually add relay peers
          setTimeout(async () => {
            try {
              for (const relayAddr of config.p2pRelayPeers) {
                const ma = multiaddr(relayAddr);
                // Extract peer ID from multiaddr
                const parts = ma.toString().split('/p2p/');
                const relayPeerIdStr = parts.length > 1 ? parts[1] : null;
                
                if (relayPeerIdStr) {
                  logger.info('Manually adding relay to reservation store', { relayPeerId: relayPeerIdStr.slice(0, 16) + '...' });
                  
                  // Access the reservation store from the transport
                  const reservationStore = (circuitTransport as any).reservationStore;
                  if (reservationStore && reservationStore.addRelay) {
                    // Convert string to PeerId object
                    const { peerIdFromString } = await import('@libp2p/peer-id');
                    const relayPeerId = peerIdFromString(relayPeerIdStr);
                    
                    // Add event listeners to track reservation lifecycle
                    reservationStore.addEventListener('relay:created-reservation', (evt: any) => {
                      logger.info('🎉 Circuit relay reservation created!', { 
                        relay: evt.detail.relay?.toString().slice(0, 16) + '...',
                        expire: evt.detail.reservation?.expire
                      });
                    });
                    
                    reservationStore.addEventListener('relay:removed', (evt: any) => {
                      logger.warn('Circuit relay reservation removed', { 
                        relay: evt.detail.relay?.toString().slice(0, 16) + '...'
                      });
                    });
                    
                    await reservationStore.addRelay(relayPeerId, 'configured');
                    logger.info('✅ Relay added to reservation store - waiting for reservation to be established', { 
                      relayPeerId: relayPeerIdStr.slice(0, 16) + '...' 
                    });
                    
                    // Check reservation status and multiaddrs after a delay
                    setTimeout(() => {
                      const hasReservation = reservationStore.hasReservation(relayPeerId);
                      const nodeAddrs = this.node?.getMultiaddrs().map(ma => ma.toString()) || [];
                      const circuitAddrs = nodeAddrs.filter(addr => addr.includes('p2p-circuit'));
                      const hasCircuitAddr = circuitAddrs.length > 0;
                      
                      logger.info('Reservation status check', { 
                        relayPeerId: relayPeerIdStr.slice(0, 16) + '...',
                        hasReservation,
                        hasCircuitAddr,
                        totalAddrs: nodeAddrs.length,
                        circuitAddrs: circuitAddrs.slice(0, 3) // Show first 3 circuit addresses
                      });
                      
                      if (hasReservation && !hasCircuitAddr) {
                        logger.warn('Reservation exists but no circuit relay addresses in multiaddrs - reservation may not be active on relay server');
                      } else if (hasCircuitAddr) {
                        logger.info('✅ Circuit relay is working! Node is reachable through relay', {
                          circuitAddrCount: circuitAddrs.length
                        });
                      }
                    }, 5000);
                  }
                }
              }
            } catch (error: any) {
              logger.error('Failed to manually add relay reservations', { error: error.message });
            }
          }, 3000); // Wait for node to be fully started
        }
      }

      // Setup pubsub immediately
      await this.setupPubsub();
      
      // Register custom protocols
      p2pProtocolsService.registerProtocols(this.node);

      this.started = true;
      this.startAnnouncements();
      
      const peerId = this.node.peerId.toString();
      const addrs = this.node.getMultiaddrs().map(ma => ma.toString());
      this.emit('started', { peerId, addresses: addrs });

      // Handle auto-registration after P2P is started and we have a peer ID
      // Extract the raw secp256k1 public key for registration
      logger.info('[P2P] Attempting to extract secp256k1 public key from peer ID');
      const publicKeyProto = (this.node.peerId.publicKey as any).raw;
      const protoBuffer = Buffer.from(publicKeyProto);
      logger.info(`[P2P] Raw public key buffer length: ${protoBuffer.length} bytes`);
      logger.info(`[P2P] Raw public key hex: 0x${protoBuffer.toString('hex')}`);
      
      let keyBytes: Buffer | undefined;
      if (protoBuffer.length === 33) {
        logger.info('[P2P] Buffer is exactly 33 bytes - using as-is');
        keyBytes = protoBuffer;
      } else if (protoBuffer.length === 36) {
        logger.info('[P2P] Buffer is 36 bytes - extracting last 33 bytes');
        keyBytes = protoBuffer.slice(3);
      } else {
        logger.info(`[P2P] Buffer is ${protoBuffer.length} bytes - searching for 0x02/0x03 prefix`);
        for (let i = 0; i < protoBuffer.length - 33; i++) {
          if (protoBuffer[i] === 0x02 || protoBuffer[i] === 0x03) {
            logger.info(`[P2P] Found compressed key prefix at offset ${i}`);
            keyBytes = protoBuffer.slice(i, i + 33);
            break;
          }
        }
      }
      
      if (keyBytes) {
        // Convert compressed key to uncompressed for Ethereum address derivation
        // The contract uses keccak256(publicKey) to derive address, which requires uncompressed format
        const { ethers } = await import('ethers');
        const signingKey = new ethers.SigningKey('0x' + this.secp256k1PrivateKey!.toString('hex'));
        const uncompressedPublicKey = signingKey.publicKey; // Full uncompressed: 0x04 + x + y (65 bytes)
        
        // Remove the 0x04 prefix for the contract (it expects 64 bytes)
        const publicKeyForContract = '0x' + uncompressedPublicKey.slice(4); // Remove '0x04'
        this.secp256k1PublicKey = publicKeyForContract;
        
        // Log key information for user clarity
        logger.info('='.repeat(80));
        logger.info('NODE CRYPTOGRAPHIC KEYS');
        logger.info('='.repeat(80));
        logger.info('');
        logger.info('📋 Peer ID (libp2p identity):');
        logger.info(`   ${peerId}`);
        logger.info('');
        logger.info('🔑 secp256k1 Public Key (for contract registration):');
        logger.info(`   ${publicKeyForContract}`);
        logger.info(`   Length: 64 bytes (uncompressed, without 0x04 prefix)`);
        logger.info(`   Use this key when registering your node on-chain`);
        logger.info('');
        logger.info('🔐 Ed25519 Public Key (for storage proofs):');
        logger.info(`   Available via /health endpoint (publicKey field)`);
        logger.info(`   Used for signing storage proofs and libp2p identity`);
        logger.info('');
        logger.info('ℹ️  Key Usage Summary:');
        logger.info(`   • Contract Registration: Use secp256k1 key (${keyBytes.length} bytes)`);
        logger.info(`   • Storage Proofs: Ed25519 key (auto-managed)`);
        logger.info(`   • P2P Identity: Peer ID derived from keys`);
        logger.info('='.repeat(80));
        
        // Import and call auto-registration service
        const { autoRegisterService } = await import('./auto-register.service.js');
        await autoRegisterService.handleAutoRegistration(peerId, publicKeyForContract, this);
      } else {
        logger.warn('Could not extract public key for auto-registration');
      }

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
      
      // Announce immediately when a new peer connects
      // This ensures browsers get health data instantly on refresh
      this.announce();
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
    availableStorage: number;
    blobCount: number;
    multiaddrs?: string[];
  }): void {
    const existing = this.knownPeers.get(announcement.peerId);

    const peerInfo: P2PPeerInfo = {
      peerId: announcement.peerId,
      multiaddrs: announcement.multiaddrs || existing?.multiaddrs || [],
      lastSeen: Date.now(),
      reputation: existing?.reputation || 100
    };

    this.knownPeers.set(announcement.peerId, peerInfo);
    this.emit('peer:announce', peerInfo);

    // Add peer to cache with multiaddrs (including meshnet fallback)
    if (announcement.multiaddrs && announcement.multiaddrs.length > 0) {
      peerCacheService.addPeer(announcement.peerId, announcement.multiaddrs);
      
      // Try to connect to this peer if not already connected
      if (this.node) {
        const alreadyConnected = this.node.getPeers().some(p => p.toString() === announcement.peerId);
        if (!alreadyConnected) {
          // Only log when discovering a NEW peer, not on re-announcements
          const isNewPeer = !existing;
          if (isNewPeer) {
            logger.info('Discovered new peer via announcement', {
              peerId: announcement.peerId.substring(0, 12),
              multiaddrsCount: announcement.multiaddrs.length
            });
          }
          
          // Attempt to dial the peer using their announced multiaddrs
          this.dialPeerFromAnnouncement(announcement.peerId, announcement.multiaddrs).catch(err => {
            // Only log dial failures for new peers to avoid spam
            if (isNewPeer) {
              logger.debug('Failed to dial new peer', { 
                peerId: announcement.peerId.substring(0, 12),
                error: err.message 
              });
            }
          });
        }
        // Silently update existing connected peers without logging
      }
    }
  }

  private async dialPeerFromAnnouncement(peerId: string, multiaddrs: string[]): Promise<void> {
    if (!this.node) return;

    // Try each multiaddr until one succeeds
    for (const addr of multiaddrs) {
      try {
        // Skip relay circuit addresses - those are for browsers
        if (addr.includes('p2p-circuit')) continue;
        
        const ma = multiaddr(addr);
        await this.node.dial(ma);
        logger.info('Successfully dialed announced peer', { 
          peerId: peerId.substring(0, 12),
          addr: addr.substring(0, 50) 
        });
        return; // Success, stop trying other addresses
      } catch (error: any) {
        logger.debug('Failed to dial multiaddr', { 
          peerId: peerId.substring(0, 12),
          addr: addr.substring(0, 50),
          error: error.message 
        });
        // Continue to next address
      }
    }
  }

  private hasAnnounced = false;

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
      // Get node's multiaddrs
      const nodeMultiaddrs = this.node.getMultiaddrs().map(ma => ma.toString());
      
      // Add meshnet fallback addresses if configured
      const multiaddrsWithMeshnet = meshnetService.addMeshnetFallback(
        this.node.peerId.toString(),
        nodeMultiaddrs
      );
      
      // Construct relay circuit addresses for browser connectivity
      const relayAddrs: string[] = [];
      
      // Get relay peer addresses from config
      const relayPeers = config.p2pRelayPeers || [];
      for (const relayAddr of relayPeers) {
        // Convert TCP relay address to WebSocket for browser compatibility
        // Browser connects via WebSocket, so use ws address for circuit
        const wsRelayAddr = relayAddr.replace('/tcp/4001/', '/tcp/4002/ws/');
        
        // Construct circuit relay address: <ws-relay-addr>/p2p-circuit/p2p/<our-peer-id>
        const circuitAddr = `${wsRelayAddr}/p2p-circuit/p2p/${this.node.peerId.toString()}`;
        relayAddrs.push(circuitAddr);
      }

      // Check on-chain registration status
      const { contractIntegrationService } = await import('./contract-integration.service.js');
      let registeredOnChain = false;
      let onChainNodeId: string | undefined;
      
      if (contractIntegrationService.isInitialized()) {
        try {
          const peerId = this.node.peerId.toString();
          const nodeIdFromContract = await contractIntegrationService.getNodeByPeerId(peerId);
          registeredOnChain = nodeIdFromContract !== null;
          onChainNodeId = nodeIdFromContract || undefined;
        } catch (err) {
          // Ignore errors, just don't include registration status
        }
      }

      const announcement = {
        peerId: this.node.peerId.toString(),
        nodeId: config.nodeId,
        availableStorage: config.gcMaxStorageMB * 1024 * 1024,
        blobCount: 0,
        timestamp: Date.now(),
        multiaddrs: multiaddrsWithMeshnet, // Direct connection addresses including meshnet
        relayAddrs: relayAddrs, // Circuit relay addresses for browser connectivity
        registeredOnChain,
        onChainNodeId
      };

      await pubsub.publish(
        ANNOUNCE_TOPIC,
        fromString(JSON.stringify(announcement))
      );

      // Only log the first announcement to avoid spam
      if (!this.hasAnnounced) {
        logger.info('Published P2P announcement', { 
          nodeId: announcement.nodeId,
          peerId: announcement.peerId.slice(0, 16) + '...',
          multiaddrs: multiaddrsWithMeshnet.length,
          relayAddrs: relayAddrs.length,
          multiaddrsPreview: multiaddrsWithMeshnet.slice(0, 3)
        });
        this.hasAnnounced = true;
      }
      // Subsequent announcements happen silently every 60s to maintain presence
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
   * Get all known peers (content-type filtering removed)
   */
  getAllPeers(): P2PPeerInfo[] {
    return Array.from(this.knownPeers.values());
  }

  /**
   * Get known peer IDs (P2P communication only)
   */
  getKnownPeerIds(): string[] {
    return Array.from(this.knownPeers.keys());
  }

  /**
   * Get the secp256k1 public key (for contract registration)
   */
  getSecp256k1PublicKey(): string | null {
    return this.secp256k1PublicKey;
  }

  /**
   * Sign a message with the secp256k1 private key
   * Used for contract registration to prove ownership of the peer ID
   */
  async signMessage(message: string): Promise<string | null> {
    if (!this.secp256k1PrivateKey) {
      logger.warn('Cannot sign message: secp256k1 private key not available');
      return null;
    }

    try {
      const { ethers } = await import('ethers');
      
      // Create a signing key from the raw private key
      const signingKey = new ethers.SigningKey('0x' + this.secp256k1PrivateKey.toString('hex'));
      
      // Get the public key and derive its address
      const publicKeyFromPrivate = signingKey.publicKey;
      const addressFromPublicKey = ethers.computeAddress(publicKeyFromPrivate);
      
      logger.info('Signature generation debug', {
        ownerAddress: message,
        publicKeyFromPrivate: publicKeyFromPrivate.slice(0, 20) + '...',
        addressFromPublicKey,
        storedPublicKey: this.secp256k1PublicKey?.slice(0, 20) + '...'
      });
      
      // Message is the owner address - hash it as the contract does: keccak256(abi.encodePacked(ownerAddress))
      const messageHash = ethers.keccak256(message);
      
      // Add Ethereum signed message prefix manually (same as contract)
      // "\x19Ethereum Signed Message:\n32" + messageHash
      const prefix = '\x19Ethereum Signed Message:\n32';
      const prefixedMessage = ethers.concat([
        ethers.toUtf8Bytes(prefix),
        ethers.getBytes(messageHash)
      ]);
      const ethSignedMessageHash = ethers.keccak256(prefixedMessage);
      
      // Sign the prefixed message hash
      const signature = signingKey.sign(ethSignedMessageHash);
      
      // Verify the signature recovers to the correct address
      const recoveredAddress = ethers.recoverAddress(ethSignedMessageHash, signature);
      logger.info('Signature verification', {
        recoveredAddress,
        expectedAddress: addressFromPublicKey,
        matches: recoveredAddress === addressFromPublicKey
      });
      
      // Serialize to compact format (r + s + v)
      return ethers.Signature.from(signature).serialized;
    } catch (error) {
      logger.error('Failed to sign message', { error });
      return null;
    }
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
