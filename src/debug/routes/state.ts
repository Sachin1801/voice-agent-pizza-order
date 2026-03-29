/**
 * State routes: get current conversation and order state.
 */

import { Express, Request, Response } from 'express';
import { getSession, respond, requireSession } from '../server';
import { toStateSnapshot } from '../types';

export function createStateRoutes(app: Express): void {

  // GET /api/state — Full state snapshot
  app.get('/api/state', requireSession, (_req: Request, res: Response) => {
    const s = getSession()!;
    const orderState = s.engine.getOrderState();
    const history = s.getHistory();

    respond(res, 'state', {
      order_state: toStateSnapshot(orderState),
      conversation_history: history,
      history_length: history.length,
      turn_count: s.engine.getRequestCount(),
      order_summary: s.getOrderSummary(),
    });
  });
}
