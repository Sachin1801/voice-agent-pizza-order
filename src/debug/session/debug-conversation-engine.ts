/**
 * Debug Conversation Engine.
 *
 * A diagnostic wrapper around the Groq pipeline that captures ALL intermediate
 * values: the full system prompt, raw Groq response, latency, tokens,
 * validation result, and rule engine decision.
 *
 * This is a parallel implementation to ConversationEngine (not a subclass)
 * because the production engine has private fields and returns only
 * { action, textToSpeak }. We need the full diagnostic payload.
 *
 * Reuses: buildSystemPrompt, buildConversationContext, ActionValidator,
 *         RuleEngine, createInitialOrderState — all imported directly.
 */

import Groq from 'groq-sdk';
import { OrderRequest, LLMAction } from '../../types';
import { Logger } from '../../logging/logger';
import { buildSystemPrompt, buildConversationContext, PROMPT_VERSION } from '../../conversation/prompts';
import { ActionValidator } from '../../conversation/action-validator';
import { RuleEngine, OrderState, createInitialOrderState } from '../../conversation/rule-engine';
import { RulesManager } from '../rules/rules-manager';
import { PipelineDiagnostic, toStateSnapshot, StateSnapshot } from '../types';

export interface ConversationTurn {
  role: 'employee' | 'agent';
  text: string;
}

export interface DiagnosticResult {
  pipeline: PipelineDiagnostic;
  state: StateSnapshot;
  turn_number: number;
  history_length: number;
}

export class DebugConversationEngine {
  private logger: Logger;
  private groqClient: Groq;
  private order: OrderRequest;
  private validator: ActionValidator;
  private ruleEngine: RuleEngine;
  private rulesManager: RulesManager;

  private conversationHistory: ConversationTurn[] = [];
  private orderState: OrderState;
  private requestCount = 0;
  private promptOverride: string | null = null;

  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(
    order: OrderRequest,
    rulesManager: RulesManager,
    logger: Logger,
    opts: {
      groqApiKey: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ) {
    this.order = order;
    this.rulesManager = rulesManager;
    this.logger = logger.child('groq');
    this.groqClient = new Groq({ apiKey: opts.groqApiKey });
    this.validator = new ActionValidator(logger);
    this.ruleEngine = new RuleEngine(order, logger);
    this.orderState = createInitialOrderState();
    this.model = opts.model ?? 'llama-3.3-70b-versatile';
    this.temperature = opts.temperature ?? 0.3;
    this.maxTokens = opts.maxTokens ?? 300;

    this.logger.info('debug.engine_initialized', 'Debug conversation engine ready', {
      prompt_version: PROMPT_VERSION,
      model: this.model,
    });
  }

  /** Add an employee transcript to the conversation history */
  addEmployeeSpeech(text: string): void {
    this.conversationHistory.push({ role: 'employee', text });
    this.logger.debug('debug.employee_speech', `Employee: "${text}"`, {
      text,
      history_length: this.conversationHistory.length,
    });
  }

  /**
   * Generate a response with full diagnostic capture.
   * This mirrors ConversationEngine.generateResponse() but returns
   * the complete pipeline state for debugging.
   */
  async generateResponse(): Promise<DiagnosticResult> {
    this.requestCount++;
    const startTime = Date.now();

    // Hot-reload rules from disk
    this.rulesManager.load();

    // Build the system prompt + debug rules + optional override
    const baseSystemPrompt = buildSystemPrompt(this.order);
    const rulesBlock = this.rulesManager.toPromptBlock();
    const overrideBlock = this.promptOverride
      ? `\n\n## Session Override\n${this.promptOverride}`
      : '';
    const fullSystemPrompt = baseSystemPrompt + rulesBlock + overrideBlock;

    // Build conversation context (with next side option for backup tracking)
    const nextSideOption = this.ruleEngine.getNextSideOption(this.orderState);
    const contextPrompt = buildConversationContext(this.conversationHistory, this.orderState, nextSideOption);

    this.logger.info('debug.groq_request', `Sending request #${this.requestCount} to Groq`, {
      request_number: this.requestCount,
      prompt_version: PROMPT_VERSION,
      model: this.model,
      system_prompt_length: fullSystemPrompt.length,
      history_turns: this.conversationHistory.length,
      rules_count: this.rulesManager.count(),
    });

    // Initialize diagnostic with defaults
    const diagnostic: PipelineDiagnostic = {
      system_prompt: fullSystemPrompt,
      system_prompt_length: fullSystemPrompt.length,
      debug_rules_injected: this.rulesManager.toSummaryList(),
      context_prompt: contextPrompt,
      groq_request: {
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages_count: 2,
      },
      groq_response_raw: '',
      groq_response_parsed: null,
      groq_latency_ms: 0,
      groq_tokens: { prompt: undefined, completion: undefined, total: undefined },
      groq_finish_reason: undefined,
      groq_error: null,
      validation: { valid: false, error: null },
      rule_engine: null,
      final_speech: '',
      action_type: 'none',
    };

    // Call Groq
    let rawResponse: string;
    try {
      const completion = await this.groqClient.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: contextPrompt },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        response_format: { type: 'json_object' },
      });

      rawResponse = completion.choices[0]?.message?.content ?? '';
      diagnostic.groq_latency_ms = Date.now() - startTime;
      diagnostic.groq_response_raw = rawResponse;
      diagnostic.groq_tokens = {
        prompt: completion.usage?.prompt_tokens,
        completion: completion.usage?.completion_tokens,
        total: completion.usage?.total_tokens,
      };
      diagnostic.groq_finish_reason = completion.choices[0]?.finish_reason ?? undefined;

      this.logger.info('debug.groq_response', `Groq response in ${diagnostic.groq_latency_ms}ms`, {
        latency_ms: diagnostic.groq_latency_ms,
        tokens_total: diagnostic.groq_tokens.total,
        finish_reason: diagnostic.groq_finish_reason,
        raw_length: rawResponse.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Groq error';
      diagnostic.groq_latency_ms = Date.now() - startTime;
      diagnostic.groq_error = message;
      diagnostic.final_speech = "I'm sorry, could you repeat that?";
      diagnostic.action_type = 'fallback_error';

      this.logger.error('debug.groq_error', `Groq request failed: ${message}`, {
        error: message,
        latency_ms: diagnostic.groq_latency_ms,
      });

      this.conversationHistory.push({ role: 'agent', text: diagnostic.final_speech });

      return {
        pipeline: diagnostic,
        state: toStateSnapshot(this.orderState),
        turn_number: this.requestCount,
        history_length: this.conversationHistory.length,
      };
    }

    // Validate the response
    const validation = this.validator.validate(rawResponse);
    diagnostic.validation = {
      valid: validation.valid,
      error: validation.error ?? null,
    };

    if (!validation.valid || !validation.action) {
      diagnostic.final_speech = "I'm sorry, could you repeat that?";
      diagnostic.action_type = 'fallback_invalid';

      this.logger.warn('debug.validation_failed', 'LLM returned invalid action', {
        error: validation.error,
        raw_response: rawResponse.slice(0, 300),
      });

      this.conversationHistory.push({ role: 'agent', text: diagnostic.final_speech });

      return {
        pipeline: diagnostic,
        state: toStateSnapshot(this.orderState),
        turn_number: this.requestCount,
        history_length: this.conversationHistory.length,
      };
    }

    const action = validation.action;
    diagnostic.groq_response_parsed = action;
    diagnostic.action_type = action.action;

    // Run through rule engine
    const ruleDecision = this.ruleEngine.evaluate(action, this.orderState);
    diagnostic.rule_engine = {
      allowed: ruleDecision.allowed,
      reason: ruleDecision.reason,
      modification: ruleDecision.modification,
    };

    this.logger.info('debug.rule_decision', `Action: ${action.action} — Rule: ${ruleDecision.allowed ? 'allowed' : 'blocked'}`, {
      action_type: action.action,
      rule_allowed: ruleDecision.allowed,
      rule_reason: ruleDecision.reason,
    });

    if (!ruleDecision.allowed) {
      // Generate corrected response for blocked actions
      const corrected = this.generateCorrectedResponse(action, ruleDecision.reason);
      diagnostic.final_speech = corrected.text;
      diagnostic.action_type = `blocked_${action.action}`;

      this.conversationHistory.push({ role: 'agent', text: corrected.text });

      return {
        pipeline: diagnostic,
        state: toStateSnapshot(this.orderState),
        turn_number: this.requestCount,
        history_length: this.conversationHistory.length,
      };
    }

    // Update order state based on the action
    this.updateOrderState(action);

    // Extract speech text
    const textToSpeak = this.getTextToSpeak(action);
    diagnostic.final_speech = textToSpeak;

    this.conversationHistory.push({ role: 'agent', text: textToSpeak });

    this.logger.info('debug.final_speech', `Agent: "${textToSpeak}"`, {
      action_type: action.action,
      text: textToSpeak,
    });

    return {
      pipeline: diagnostic,
      state: toStateSnapshot(this.orderState),
      turn_number: this.requestCount,
      history_length: this.conversationHistory.length,
    };
  }

  // ─── State access (exposed for debug commands) ────────────────────────────

  getConversationHistory(): ConversationTurn[] {
    return [...this.conversationHistory];
  }

  setConversationHistory(history: ConversationTurn[]): void {
    this.conversationHistory = [...history];
  }

  getOrderState(): OrderState {
    return { ...this.orderState };
  }

  setOrderState(state: OrderState): void {
    this.orderState = { ...state };
  }

  getSystemPrompt(): string {
    const base = buildSystemPrompt(this.order);
    const rules = this.rulesManager.toPromptBlock();
    const override = this.promptOverride ? `\n\n## Session Override\n${this.promptOverride}` : '';
    return base + rules + override;
  }

  getPromptOverride(): string | null {
    return this.promptOverride;
  }

  setPromptOverride(override: string | null): void {
    this.promptOverride = override;
    this.logger.info('debug.prompt_edited', `Prompt override ${override ? 'set' : 'cleared'}`, {
      override_length: override?.length ?? 0,
    });
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  // ─── Private helpers (mirrored from ConversationEngine) ───────────────────

  private getTextToSpeak(action: LLMAction): string {
    if ('text' in action) return action.text;
    return '';
  }

  private generateCorrectedResponse(
    blockedAction: LLMAction,
    reason: string
  ): { action: LLMAction; text: string } {
    if (blockedAction.action === 'accept_substitution') {
      const text = `No, I can't do ${blockedAction.replacement}. Do you have any other options?`;
      return {
        action: {
          action: 'reject_substitution',
          offered: blockedAction.replacement,
          reason,
          text,
        },
        text,
      };
    }

    const text = "I'm sorry, could you suggest something else?";
    return {
      action: { action: 'say', text },
      text,
    };
  }

  private updateOrderState(action: LLMAction): void {
    switch (action.action) {
      case 'accept_substitution':
        this.orderState.substitutions[action.original] = action.replacement;
        break;

      case 'say':
        // Capture prices/totals from the action metadata
        if (action.heard_price) {
          const { item, price } = action.heard_price;
          const itemLower = item.toLowerCase();
          if (itemLower === 'pizza' || itemLower.includes('pizza')) {
            if (this.orderState.pizzaPrice === null) {
              this.orderState.pizzaConfirmed = true;
              this.orderState.pizzaPrice = price;
              this.orderState.runningTotal += price;
            }
          } else if (itemLower === 'side' || itemLower.includes('wing') || itemLower.includes('bread') || itemLower.includes('stick')) {
            if (this.orderState.sidePrice === null) {
              this.orderState.sideConfirmed = true;
              this.orderState.sideDescription = item;
              this.orderState.sidePrice = price;
              this.orderState.runningTotal += price;
            }
          } else if (itemLower === 'drink' || itemLower.includes('coke') || itemLower.includes('pepsi') || itemLower.includes('sprite')) {
            if (this.orderState.drinkPrice === null) {
              this.orderState.drinkConfirmed = true;
              this.orderState.drinkDescription = item;
              this.orderState.drinkPrice = price;
              this.orderState.runningTotal += price;
            }
          }
        }
        if (action.heard_total) {
          this.orderState.heardTotal = action.heard_total;
        }
        if (action.heard_delivery_time) {
          this.orderState.deliveryTime = action.heard_delivery_time;
        }
        if (action.heard_order_number) {
          this.orderState.orderNumber = action.heard_order_number;
        }
        if (action.delivering_special_instructions) {
          this.orderState.specialInstructionsDelivered = true;
        }
        break;

      case 'confirm_done':
      case 'hangup_with_outcome':
        // These don't modify order state directly
        break;
    }
  }
}
