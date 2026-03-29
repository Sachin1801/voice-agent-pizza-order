/**
 * LLM Action Validator.
 *
 * Validates that Groq's JSON output conforms to the action schema
 * before it reaches the rule engine or gets spoken.
 *
 * Required logs:
 *   - Groq response parsing, JSON validation, fallback handling
 */

import { LLMAction, LLMActionSchema } from '../types';
import { Logger } from '../logging/logger';

export interface ValidationResult {
  valid: boolean;
  action: LLMAction | null;
  error: string | null;
  rawResponse: string;
}

export class ActionValidator {
  private logger: Logger;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child('conversation');
  }

  /** Parse and validate an LLM response string into a typed action */
  validate(rawResponse: string): ValidationResult {
    // Try to extract JSON from the response
    let parsed: unknown;
    try {
      // First try direct parse
      parsed = JSON.parse(rawResponse);
    } catch {
      // Try to find JSON in the response (LLM may wrap it in markdown)
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          this.logger.error('conversation.action_parse_failed', 'Failed to parse JSON from LLM response', {
            raw_response: rawResponse.slice(0, 500),
          });
          return {
            valid: false,
            action: null,
            error: 'Could not parse JSON from response',
            rawResponse,
          };
        }
      } else {
        this.logger.error('conversation.action_no_json', 'No JSON found in LLM response', {
          raw_response: rawResponse.slice(0, 500),
        });
        return {
          valid: false,
          action: null,
          error: 'No JSON object found in response',
          rawResponse,
        };
      }
    }

    // Validate against schema
    const result = LLMActionSchema.safeParse(parsed);

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      this.logger.warn('conversation.action_validation_failed', 'LLM action failed schema validation', {
        parsed,
        issues,
      });
      return {
        valid: false,
        action: null,
        error: `Schema validation failed: ${issues.join('; ')}`,
        rawResponse,
      };
    }

    this.logger.debug('conversation.action_validated', `Valid action: ${result.data.action}`, {
      action_type: result.data.action,
    });

    return {
      valid: true,
      action: result.data,
      error: null,
      rawResponse,
    };
  }
}
