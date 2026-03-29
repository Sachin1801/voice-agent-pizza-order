/**
 * Rules Manager.
 *
 * CRUD for data/debug-rules.json — a JSON array of behavioral rules
 * that get injected into the Groq system prompt as additional instructions.
 *
 * Hot-reload: load() is called on every Groq request so rules take effect
 * immediately without restarting the session.
 */

import fs from 'fs';
import path from 'path';
import { DebugRule } from '../types';

export class RulesManager {
  private filePath: string;
  private rules: DebugRule[] = [];

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.ensureFile();
    this.load();
  }

  /** Ensure the rules file exists (create with empty array if not) */
  private ensureFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]', 'utf-8');
    }
  }

  /** Read rules from disk (called on every Groq request for hot-reload) */
  load(): DebugRule[] {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.rules = JSON.parse(raw) as DebugRule[];
    } catch {
      this.rules = [];
    }
    return this.rules;
  }

  /** Write current rules to disk */
  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2), 'utf-8');
  }

  /** Get all rules (from last load) */
  list(): DebugRule[] {
    return [...this.rules];
  }

  /** Add a new rule */
  add(rule: string, category: string = 'general', addedBy: string = 'agent'): DebugRule {
    const newRule: DebugRule = {
      id: `rule-${Date.now()}`,
      rule,
      category,
      added_by: addedBy,
      timestamp: new Date().toISOString(),
    };
    this.rules.push(newRule);
    this.save();
    return newRule;
  }

  /** Remove a rule by ID. Returns true if found and removed. */
  remove(id: string): boolean {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.rules.splice(index, 1);
    this.save();
    return true;
  }

  /** Get rule count */
  count(): number {
    return this.rules.length;
  }

  /**
   * Format rules as a prompt block for injection into the system prompt.
   * Returns empty string if no rules are active.
   */
  toPromptBlock(): string {
    if (this.rules.length === 0) return '';

    const lines = this.rules.map((r) => `- [${r.id}] ${r.rule}`);
    return `\n\n## Additional Debug Rules\nThese rules MUST be followed strictly:\n${lines.join('\n')}`;
  }

  /** Get rule texts as an array (for the response diagnostic) */
  toSummaryList(): string[] {
    return this.rules.map((r) => `${r.id}: ${r.rule}`);
  }
}
