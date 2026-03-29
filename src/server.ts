/**
 * Express + WebSocket server.
 *
 * HTTP routes:
 *   POST /api/calls          — initiate a new outbound call
 *   GET  /api/calls/:call_id — get call status/result
 *   POST /api/twilio/voice   — Twilio webhook, returns TwiML to open media stream
 *   POST /api/twilio/status  — Twilio status callback
 *
 * WebSocket:
 *   /api/twilio/media-stream — Twilio bidirectional media stream
 */

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { createCallRouter } from './routes/calls';
import { createTwilioWebhookRouter } from './routes/twilio-webhooks';
import { CallSessionManager } from './session/call-session-manager';
import { createCallLogger } from './logging/logger';

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Boot logger (not call-scoped, used for server-level events)
  const serverLogger = createCallLogger('server', 'server', 'server', config.logLevel);

  // Session manager
  const sessionManager = new CallSessionManager(serverLogger);

  // Routes
  app.use('/api/calls', createCallRouter(sessionManager, serverLogger));
  app.use('/api/twilio', createTwilioWebhookRouter(sessionManager, serverLogger));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // HTTP server
  const server = http.createServer(app);

  // WebSocket server for Twilio media streams
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);

    if (url.pathname === '/api/twilio/media-stream') {
      serverLogger.info('websocket.upgrade', 'WebSocket upgrade request received', {
        path: url.pathname,
        headers: {
          origin: request.headers.origin,
          'sec-websocket-key': request.headers['sec-websocket-key'],
        },
      });

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      serverLogger.warn('websocket.rejected', `Rejected WebSocket upgrade for unknown path: ${url.pathname}`);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    serverLogger.info('websocket.connected', 'Twilio media stream WebSocket connected');

    // Hand the WebSocket to the session manager
    sessionManager.handleMediaStream(ws);

    ws.on('close', (code, reason) => {
      serverLogger.info('websocket.closed', `WebSocket closed: code=${code}`, {
        code,
        reason: reason.toString(),
      });
    });

    ws.on('error', (err) => {
      serverLogger.error('websocket.error', `WebSocket error: ${err.message}`, {
        error: err.message,
      });
    });
  });

  return { app, server, wss, sessionManager };
}

// Start server if run directly
if (require.main === module) {
  const { server } = createServer();
  const logger = createCallLogger('server', 'server', 'server', config.logLevel);

  server.listen(config.port, () => {
    logger.info('server.started', `Voice Agent server listening on port ${config.port}`, {
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      publicWsBaseUrl: config.publicWsBaseUrl,
    });
  });
}
