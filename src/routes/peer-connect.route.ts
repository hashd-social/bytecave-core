/**
 * ByteCave Core - Manual Peer Connection Route
 * POST /peers/connect - Connect to a peer by multiaddr
 */

import { Request, Response } from 'express';
import { p2pService } from '../services/p2p.service.js';
import { logger } from '../utils/logger.js';

export async function connectPeerHandler(req: Request, res: Response): Promise<void> {
  try {
    const { multiaddr } = req.body;

    if (!multiaddr || typeof multiaddr !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing or invalid multiaddr'
      });
      return;
    }

    if (!p2pService.isStarted()) {
      res.status(503).json({
        success: false,
        error: 'P2P service not started'
      });
      return;
    }

    logger.info('Attempting manual peer connection', { multiaddr });

    const success = await p2pService.connectToPeer(multiaddr);

    if (success) {
      const connectedPeers = p2pService.getConnectedPeers();
      res.json({
        success: true,
        message: 'Connected to peer',
        multiaddr,
        connectedPeers: connectedPeers.length
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to connect to peer',
        multiaddr
      });
    }
  } catch (error: any) {
    logger.error('Peer connection error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
