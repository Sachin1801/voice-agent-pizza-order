import { describe, it, expect } from 'vitest';
import { ActionValidator } from '../action-validator';
import { createCallLogger } from '../../logging/logger';

function createTestValidator() {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  return new ActionValidator(logger);
}

describe('ActionValidator', () => {
  const validator = createTestValidator();

  it('parses valid say action', () => {
    const result = validator.validate('{"action":"say","text":"Hello"}');
    expect(result.valid).toBe(true);
    expect(result.action?.action).toBe('say');
  });

  it('parses valid accept_substitution action', () => {
    const result = validator.validate(
      '{"action":"accept_substitution","original":"mushroom","replacement":"onion","text":"Sure"}'
    );
    expect(result.valid).toBe(true);
    expect(result.action?.action).toBe('accept_substitution');
  });

  it('parses valid hangup_with_outcome action', () => {
    const result = validator.validate(
      '{"action":"hangup_with_outcome","outcome":"completed","reason":"Done","text":"Thanks"}'
    );
    expect(result.valid).toBe(true);
    if (result.action?.action === 'hangup_with_outcome') {
      expect(result.action.outcome).toBe('completed');
    }
  });

  it('rejects invalid JSON', () => {
    const result = validator.validate('not json at all');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No JSON');
  });

  it('extracts JSON from markdown code block', () => {
    const result = validator.validate('```json\n{"action":"say","text":"Hi"}\n```');
    expect(result.valid).toBe(true);
    expect(result.action?.action).toBe('say');
  });

  it('rejects unknown action types', () => {
    const result = validator.validate('{"action":"dance","text":"woo"}');
    expect(result.valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validator.validate('{"action":"say"}');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid outcome values', () => {
    const result = validator.validate(
      '{"action":"hangup_with_outcome","outcome":"party_time","reason":"fun","text":"wooo"}'
    );
    expect(result.valid).toBe(false);
  });

  it('handles empty string response', () => {
    const result = validator.validate('');
    expect(result.valid).toBe(false);
  });

  it('handles JSON with extra whitespace and newlines', () => {
    const result = validator.validate('  \n  {"action": "say", "text": "Hi"}  \n  ');
    expect(result.valid).toBe(true);
  });
});
