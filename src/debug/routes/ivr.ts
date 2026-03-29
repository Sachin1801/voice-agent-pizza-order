/**
 * IVR routes: auto-play and custom transcript testing.
 */

import { Express, Request, Response } from 'express';
import { getSession, respond, respondError, requireSession } from '../server';
import { runIVRAutoPlay, runIVRTest, IVRTestInput } from '../ivr/ivr-runner';

export function createIVRRoutes(app: Express): void {

  // POST /api/ivr — Run the scripted IVR auto-play sequence (happy path)
  app.post('/api/ivr', requireSession, (_req: Request, res: Response) => {
    try {
      const s = getSession()!;
      const result = runIVRAutoPlay(s.order, s.logger);
      respond(res, 'ivr', result);
    } catch (err) {
      respondError(res, 'ivr', `IVR auto-play failed: ${err instanceof Error ? err.message : 'unknown'}`, 500);
    }
  });

  // POST /api/ivr/test — Feed custom transcripts through the IVR state machine
  // Body: { transcripts: [{ text: "Hi. Thank you for calling.", is_final: true }, ...] }
  app.post('/api/ivr/test', requireSession, (req: Request, res: Response) => {
    const { transcripts } = req.body;

    if (!Array.isArray(transcripts) || transcripts.length === 0) {
      respondError(res, 'ivr.test', 'Request body must contain "transcripts" — array of { text: string, is_final: boolean }.');
      return;
    }

    // Validate inputs
    const inputs: IVRTestInput[] = [];
    for (let i = 0; i < transcripts.length; i++) {
      const t = transcripts[i];
      if (!t.text || typeof t.text !== 'string') {
        respondError(res, 'ivr.test', `transcripts[${i}] must have a "text" string.`);
        return;
      }
      inputs.push({
        text: t.text,
        is_final: t.is_final !== false, // default to true
      });
    }

    try {
      const s = getSession()!;
      const result = runIVRTest(s.order, inputs, s.logger);
      respond(res, 'ivr.test', result);
    } catch (err) {
      respondError(res, 'ivr.test', `IVR test failed: ${err instanceof Error ? err.message : 'unknown'}`, 500);
    }
  });
}
