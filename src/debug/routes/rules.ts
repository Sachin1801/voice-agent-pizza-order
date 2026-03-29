/**
 * Rules routes: list, add, remove debug rules.
 */

import { Express, Request, Response } from 'express';
import { getSession, respond, respondError, requireSession } from '../server';

export function createRulesRoutes(app: Express): void {

  // GET /api/rules — List all active rules
  app.get('/api/rules', requireSession, (_req: Request, res: Response) => {
    const s = getSession()!;
    const rules = s.rulesManager.list();

    respond(res, 'rules.list', {
      count: rules.length,
      rules,
    });
  });

  // POST /api/rules — Add a new rule
  app.post('/api/rules', requireSession, (req: Request, res: Response) => {
    const { rule, category, added_by } = req.body;

    if (!rule || typeof rule !== 'string') {
      respondError(res, 'rules.add', 'Request body must contain "rule" (string) — the behavioral rule text.');
      return;
    }

    const s = getSession()!;
    const newRule = s.rulesManager.add(rule, category, added_by);

    s.logger.info('debug.rules_modified', `Rule added: ${newRule.id}`, {
      rule_id: newRule.id,
      rule_text: rule,
      total_rules: s.rulesManager.count(),
    });

    respond(res, 'rules.add', {
      rule: newRule,
      total_rules: s.rulesManager.count(),
    });
  });

  // DELETE /api/rules/:id — Remove a rule by ID
  app.delete('/api/rules/:id', requireSession, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const s = getSession()!;

    const removed = s.rulesManager.remove(id);
    if (!removed) {
      respondError(res, 'rules.remove', `Rule not found: ${id}`);
      return;
    }

    s.logger.info('debug.rules_modified', `Rule removed: ${id}`, {
      rule_id: id,
      remaining_rules: s.rulesManager.count(),
    });

    respond(res, 'rules.remove', {
      removed_id: id,
      remaining_rules: s.rulesManager.count(),
    });
  });
}
