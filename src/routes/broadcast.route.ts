/**
 * Broadcast Routes
 * 
 * Handles peer-to-peer broadcast messaging
 */

import { Request, Response } from 'express';
import { p2pService } from '../services/p2p.service.js';
import { logger } from '../utils/logger.js';

interface BroadcastMessage {
  from: string;
  message: string;
  timestamp: number;
}

// Store recent broadcasts in memory
const recentBroadcasts: BroadcastMessage[] = [];
const MAX_BROADCASTS = 100;

// Listen for broadcast events from P2P service
p2pService.on('broadcast', (broadcast: BroadcastMessage) => {
  recentBroadcasts.unshift(broadcast);
  if (recentBroadcasts.length > MAX_BROADCASTS) {
    recentBroadcasts.pop();
  }
});

/**
 * POST /broadcast - Send a broadcast message to all connected peers
 */
export async function sendBroadcast(req: Request, res: Response): Promise<void> {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (message.length > 1000) {
      res.status(400).json({ error: 'Message too long (max 1000 characters)' });
      return;
    }

    await p2pService.broadcastMessage(message);

    // Store our own broadcast locally (we won't receive it back via gossipsub)
    const peerId = p2pService.getPeerId();
    if (peerId) {
      const broadcast: BroadcastMessage = {
        from: peerId,
        message,
        timestamp: Date.now()
      };
      recentBroadcasts.unshift(broadcast);
      if (recentBroadcasts.length > MAX_BROADCASTS) {
        recentBroadcasts.pop();
      }
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Failed to send broadcast', error);
    res.status(500).json({ error: error.message });
  }
}

/**
 * GET /broadcasts - Get recent broadcast messages
 */
export async function getBroadcasts(_req: Request, res: Response): Promise<void> {
  try {
    res.json({
      count: recentBroadcasts.length,
      broadcasts: recentBroadcasts
    });
  } catch (error: any) {
    logger.error('Failed to get broadcasts', error);
    res.status(500).json({ error: 'Failed to get broadcasts' });
  }
}
