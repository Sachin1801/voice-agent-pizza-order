/**
 * Conversation routes: send, rewind.
 */

import { Express, Request, Response } from 'express';
import { getSession, respond, respondError, requireSession } from '../server';

export function createConversationRoutes(app: Express): void {

  // POST /api/send — Send employee text and get full pipeline diagnostic
  app.post('/api/send', requireSession, async (req: Request, res: Response) => {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      respondError(res, 'send', 'Request body must contain "text" (string) — the employee\'s speech.');
      return;
    }

    try {
      const s = getSession()!;
      const result = await s.send(text);
      respond(res, 'send', result);
    } catch (err) {
      respondError(res, 'send', `Send failed: ${err instanceof Error ? err.message : 'unknown'}`, 500);
    }
  });

  // POST /api/rewind — Go back N turns in conversation history
  app.post('/api/rewind', requireSession, (req: Request, res: Response) => {
    const { turns } = req.body;

    if (typeof turns !== 'number' || turns < 1) {
      respondError(res, 'rewind', 'Request body must contain "turns" (positive integer) — number of turns to rewind.');
      return;
    }

    const s = getSession()!;
    const result = s.rewind(turns);

    respond(res, 'rewind', {
      turns_removed: result.turns_removed,
      history_length_before: result.history_before,
      history_length_after: result.history_after,
    });
  });
}
