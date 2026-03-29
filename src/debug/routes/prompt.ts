/**
 * Prompt routes: view and edit the system prompt.
 */

import { Express, Request, Response } from 'express';
import { PROMPT_VERSION } from '../../conversation/prompts';
import { getSession, respond, respondError, requireSession } from '../server';

export function createPromptRoutes(app: Express): void {

  // GET /api/prompt — View the full system prompt (base + rules + override)
  app.get('/api/prompt', requireSession, (_req: Request, res: Response) => {
    const s = getSession()!;
    const fullPrompt = s.engine.getSystemPrompt();
    const rulesBlock = s.rulesManager.toPromptBlock();
    const override = s.engine.getPromptOverride();

    respond(res, 'prompt.view', {
      system_prompt: fullPrompt,
      system_prompt_length: fullPrompt.length,
      debug_rules_block: rulesBlock,
      prompt_override: override,
      full_prompt_length: fullPrompt.length,
      prompt_version: PROMPT_VERSION,
    });
  });

  // POST /api/prompt/edit — Set a session-scoped prompt modification
  app.post('/api/prompt/edit', requireSession, (req: Request, res: Response) => {
    const { modification } = req.body;

    if (!modification || typeof modification !== 'string') {
      respondError(res, 'prompt.edit', 'Request body must contain "modification" (string) — text to append to the system prompt.');
      return;
    }

    const s = getSession()!;
    const previousOverride = s.engine.getPromptOverride();
    s.engine.setPromptOverride(modification);

    const newFullPrompt = s.engine.getSystemPrompt();

    respond(res, 'prompt.edit', {
      modification,
      previous_override: previousOverride,
      full_prompt_length: newFullPrompt.length,
    });
  });
}
