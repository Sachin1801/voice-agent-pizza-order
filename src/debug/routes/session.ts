/**
 * Session routes: start, stop, info, reset.
 */

import { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { OrderRequestSchema } from '../../types';
import { DebugConfig } from '../config/debug-config';
import { DebugSession } from '../session/debug-session';
import { getSession, setSession, respond, respondError, requireSession } from '../server';

export function createSessionRoutes(app: Express, config: DebugConfig): void {

  // POST /api/start — Create a new debug session with an order
  app.post('/api/start', (req: Request, res: Response) => {
    const { order_file, order } = req.body;

    // Either load order from file or accept it inline
    let orderData: unknown;
    if (order) {
      orderData = order;
    } else if (order_file) {
      const filePath = path.resolve(order_file);
      if (!fs.existsSync(filePath)) {
        respondError(res, 'start', `Order file not found: ${filePath}`);
        return;
      }
      try {
        orderData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        respondError(res, 'start', `Failed to parse order file: ${err instanceof Error ? err.message : 'unknown'}`);
        return;
      }
    } else {
      respondError(res, 'start', 'Provide either "order_file" (path) or "order" (inline object) in the request body.');
      return;
    }

    // Validate order
    const parsed = OrderRequestSchema.safeParse(orderData);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      respondError(res, 'start', `Order validation failed: ${issues}`);
      return;
    }

    // Create session
    const newSession = new DebugSession(parsed.data, config);
    setSession(newSession);

    respond(res, 'start', {
      session_id: newSession.sessionId,
      order_summary: newSession.getOrderSummary(),
      port: config.debugPort,
      groq_model: config.groqModel,
      rules_loaded: newSession.rulesManager.count(),
    });
  });

  // POST /api/stop — Tear down session and signal server shutdown
  app.post('/api/stop', (_req: Request, res: Response) => {
    setSession(null);
    respond(res, 'stop', { message: 'Session stopped. Server shutting down.' });

    // Give the response time to send before exiting
    setTimeout(() => process.exit(0), 200);
  });

  // GET /api/session/info — Session metadata
  app.get('/api/session/info', requireSession, (_req: Request, res: Response) => {
    const s = getSession()!;
    respond(res, 'session.info', s.getInfo());
  });

  // POST /api/session/reset — Clear history and state, keep order and rules
  app.post('/api/session/reset', requireSession, (_req: Request, res: Response) => {
    const s = getSession()!;
    s.reset();
    respond(res, 'session.reset', {
      message: 'Session reset. History and state cleared. Order and rules preserved.',
      session_id: s.sessionId,
    });
  });
}
