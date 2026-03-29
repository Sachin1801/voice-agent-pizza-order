/**
 * Replay routes: replay past calls with current prompt/rules.
 */

import { Express, Request, Response } from 'express';
import { DebugConfig } from '../config/debug-config';
import { getSession, respond, respondError, requireSession } from '../server';
import { runReplay } from '../replay/replay-runner';

export function createReplayRoutes(app: Express, config: DebugConfig): void {

  // POST /api/replay — Replay a past call through the current pipeline
  app.post('/api/replay', requireSession, async (req: Request, res: Response) => {
    const { call_id } = req.body;

    if (!call_id || typeof call_id !== 'string') {
      respondError(res, 'replay', 'Request body must contain "call_id" (string) — the call ID from data/runs/.');
      return;
    }

    try {
      const s = getSession()!;
      const result = await runReplay(call_id, config, s.rulesManager, s.logger);
      respond(res, 'replay', result);
    } catch (err) {
      respondError(res, 'replay', `Replay failed: ${err instanceof Error ? err.message : 'unknown'}`, 500);
    }
  });
}
