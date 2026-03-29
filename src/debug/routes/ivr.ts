/**
 * IVR routes: auto-play IVR sequence.
 */

import { Express, Request, Response } from 'express';
import { getSession, respond, respondError, requireSession } from '../server';
import { runIVRAutoPlay } from '../ivr/ivr-runner';

export function createIVRRoutes(app: Express): void {

  // POST /api/ivr — Run the scripted IVR auto-play sequence
  app.post('/api/ivr', requireSession, (_req: Request, res: Response) => {
    try {
      const s = getSession()!;
      const result = runIVRAutoPlay(s.order, s.logger);
      respond(res, 'ivr', result);
    } catch (err) {
      respondError(res, 'ivr', `IVR auto-play failed: ${err instanceof Error ? err.message : 'unknown'}`, 500);
    }
  });
}
