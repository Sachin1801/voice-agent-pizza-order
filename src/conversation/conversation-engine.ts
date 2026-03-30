/**
 * Conversation Engine.
 *
 * Handles the human conversation phase after hold pickup.
 * Uses Groq to generate structured JSON actions, validates them,
 * then runs them through the rule engine before speaking.
 *
 * Required logs:
 *   - Groq request construction, response parsing, JSON validation, fallback handling
 *   - Prompt version used per request
 *   - Action proposals from LLM
 *   - Rule engine decisions
 *   - Final spoken output text
 */

import Groq from 'groq-sdk';
import { config } from '../config';
import { OrderRequest, LLMAction } from '../types';
import { Logger } from '../logging/logger';
import { ArtifactWriter, ActionEntry } from '../logging/artifact-writer';
import { buildSystemPrompt, buildConversationContext, PROMPT_VERSION } from './prompts';
import { ActionValidator } from './action-validator';
import { RuleEngine, OrderState, createInitialOrderState } from './rule-engine';

export interface ConversationResult {
  action: LLMAction;
  textToSpeak: string;
}

export class ConversationEngine {
  private logger: Logger;
  private groqClient: Groq;
  private order: OrderRequest;
  private validator: ActionValidator;
  private ruleEngine: RuleEngine;
  private artifacts: ArtifactWriter;

  private conversationHistory: Array<{ role: 'employee' | 'agent'; text: string }> = [];
  private orderState: OrderState;
  private requestCount = 0;

  constructor(
    order: OrderRequest,
    parentLogger: Logger,
    artifacts: ArtifactWriter
  ) {
    this.order = order;
    this.logger = parentLogger.child('groq');
    this.artifacts = artifacts;
    this.groqClient = new Groq({ apiKey: config.groqApiKey });
    this.validator = new ActionValidator(parentLogger);
    this.ruleEngine = new RuleEngine(order, parentLogger);
    this.orderState = createInitialOrderState();

    this.logger.info('conversation.initialized', 'Conversation engine ready', {
      prompt_version: PROMPT_VERSION,
      model: config.groqModel,
    });
  }

  /** Get the current order state */
  getOrderState(): OrderState {
    return { ...this.orderState };
  }

  /** Add an employee transcript to the conversation history */
  addEmployeeSpeech(text: string): void {
    this.conversationHistory.push({ role: 'employee', text });
    this.logger.debug('conversation.employee_speech', `Employee: "${text}"`, {
      text,
      history_length: this.conversationHistory.length,
    });
  }

  /** Add an agent response to conversation history (used by fast-reply to bypass Groq) */
  addAgentSpeech(text: string): void {
    this.conversationHistory.push({ role: 'agent', text });
    this.logger.debug('conversation.agent_speech', `Agent (fast-reply): "${text}"`, {
      text,
      history_length: this.conversationHistory.length,
    });
  }

  /** Process the latest employee speech and generate a response */
  async generateResponse(): Promise<ConversationResult | null> {
    this.requestCount++;
    const startTime = Date.now();
    const correlationId = `groq-${this.requestCount}`;

    // Build messages for Groq
    const systemPrompt = buildSystemPrompt(this.order);
    const nextSideOption = this.getNextSideOption();
    const contextPrompt = buildConversationContext(this.conversationHistory, this.orderState, nextSideOption);

    this.logger.emit({
      event: 'groq.request_sending',
      level: 'info',
      message: `Sending request #${this.requestCount} to Groq`,
      direction: 'outbound',
      provider: 'groq',
      correlation_id: correlationId,
      data: {
        request_number: this.requestCount,
        prompt_version: PROMPT_VERSION,
        model: config.groqModel,
        history_turns: this.conversationHistory.length,
      },
    });

    let rawResponse: string;
    try {
      const completion = await this.groqClient.chat.completions.create({
        model: config.groqModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextPrompt },
        ],
        temperature: 0.3,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      });

      rawResponse = completion.choices[0]?.message?.content ?? '';

      this.logger.emit({
        event: 'groq.response_received',
        level: 'info',
        message: `Groq response received in ${Date.now() - startTime}ms`,
        direction: 'inbound',
        provider: 'groq',
        correlation_id: correlationId,
        latency_ms: Date.now() - startTime,
        data: {
          tokens_prompt: completion.usage?.prompt_tokens,
          tokens_completion: completion.usage?.completion_tokens,
          tokens_total: completion.usage?.total_tokens,
          finish_reason: completion.choices[0]?.finish_reason,
          raw_length: rawResponse.length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown';
      this.logger.emit({
        event: 'groq.request_failed',
        level: 'error',
        message: `Groq request failed: ${message}`,
        direction: 'inbound',
        provider: 'groq',
        correlation_id: correlationId,
        latency_ms: Date.now() - startTime,
        data: { error: message },
      });
      return null;
    }

    // Validate the response
    const validation = this.validator.validate(rawResponse);

    if (!validation.valid || !validation.action) {
      this.logger.warn('conversation.action_invalid', 'LLM returned invalid action — generating fallback', {
        error: validation.error,
        raw_response: rawResponse.slice(0, 300),
      });

      // Write invalid action to artifacts
      this.artifacts.writeAction({
        timestamp: new Date().toISOString(),
        sequence: this.requestCount,
        proposal: rawResponse,
        validation: 'invalid',
        validation_error: validation.error,
        rule_decision: null,
        rule_reason: null,
        emitted_speech: null,
      });

      // Fallback: ask employee to repeat
      const fallback: LLMAction = {
        action: 'say',
        text: "I'm sorry, could you repeat that?",
      };
      this.conversationHistory.push({ role: 'agent', text: fallback.text });
      return { action: fallback, textToSpeak: fallback.text };
    }

    const action = validation.action;

    // Run through rule engine
    const ruleDecision = this.ruleEngine.evaluate(action, this.orderState);

    this.logger.emit({
      event: 'groq.action_proposed',
      level: 'info',
      message: `Action: ${action.action} — Rule: ${ruleDecision.allowed ? 'allowed' : 'blocked'}`,
      direction: 'internal',
      provider: 'groq',
      correlation_id: correlationId,
      data: {
        action_type: action.action,
        rule_allowed: ruleDecision.allowed,
        rule_reason: ruleDecision.reason,
        rule_modification: ruleDecision.modification,
      },
    });

    // Write action to artifacts
    this.artifacts.writeAction({
      timestamp: new Date().toISOString(),
      sequence: this.requestCount,
      proposal: action,
      validation: 'valid',
      validation_error: null,
      rule_decision: ruleDecision.allowed ? 'allowed' : 'rejected',
      rule_reason: ruleDecision.reason,
      emitted_speech: ruleDecision.allowed ? this.getTextToSpeak(action) : null,
    });

    if (!ruleDecision.allowed) {
      // Rule engine blocked the action — generate a corrective response
      this.logger.info('conversation.action_blocked', `Blocked action: ${action.action} — ${ruleDecision.reason}`, {
        action_type: action.action,
        reason: ruleDecision.reason,
      });

      // Re-prompt with rule violation context
      return this.generateCorrectedResponse(action, ruleDecision.reason);
    }

    // Update order state based on the action
    this.updateOrderState(action);

    // Add agent response to history
    const textToSpeak = this.getTextToSpeak(action);
    this.conversationHistory.push({ role: 'agent', text: textToSpeak });

    this.logger.info('conversation.speaking', `Agent: "${textToSpeak}"`, {
      action_type: action.action,
      text: textToSpeak,
    });

    return { action, textToSpeak };
  }

  /** Extract the text to speak from an action */
  private getTextToSpeak(action: LLMAction): string {
    if ('text' in action) return action.text;
    return '';
  }

  /** Generate a corrected response when the rule engine blocks an action */
  private async generateCorrectedResponse(
    blockedAction: LLMAction,
    reason: string
  ): Promise<ConversationResult | null> {
    // For blocked substitutions, construct a rejection response
    if (blockedAction.action === 'accept_substitution') {
      const rejection: LLMAction = {
        action: 'reject_substitution',
        offered: blockedAction.replacement,
        reason,
        text: `No, I can't do ${blockedAction.replacement}. Do you have any other options?`,
      };
      this.conversationHistory.push({ role: 'agent', text: rejection.text });
      return { action: rejection, textToSpeak: rejection.text };
    }

    // Generic fallback
    const fallback: LLMAction = {
      action: 'say',
      text: "I'm sorry, could you suggest something else?",
    };
    this.conversationHistory.push({ role: 'agent', text: fallback.text });
    return { action: fallback, textToSpeak: fallback.text };
  }

  /** Update order state based on a successfully executed action */
  private updateOrderState(action: LLMAction): void {
    switch (action.action) {
      case 'accept_substitution':
        this.orderState.substitutions[action.original] = action.replacement;
        this.logger.debug('conversation.state_updated', `Substitution recorded: ${action.original} → ${action.replacement}`);
        break;

      case 'hangup_with_outcome':
        this.logger.info('conversation.hangup_requested', `Hangup: ${action.outcome} — ${action.reason}`, {
          outcome: action.outcome,
          reason: action.reason,
        });
        break;

      case 'confirm_done':
        this.logger.info('conversation.order_confirmed', 'Order confirmed by agent');
        break;
    }
  }

  /** Manually update order state (called from outside when we parse prices from transcript) */
  updatePizzaPrice(price: number): void {
    if (this.orderState.pizzaPrice !== null) {
      this.logger.debug('conversation.pizza_price_duplicate', `Pizza price already set ($${this.orderState.pizzaPrice}), ignoring duplicate`);
      return;
    }
    this.orderState.pizzaConfirmed = true;
    this.orderState.pizzaPrice = price;
    this.orderState.runningTotal += price;
    this.logger.info('conversation.pizza_price_set', `Pizza price: $${price}`, {
      price,
      running_total: this.orderState.runningTotal,
    });
  }

  updateSide(description: string, price: number): void {
    if (this.orderState.sidePrice !== null) {
      this.logger.debug('conversation.side_price_duplicate', `Side price already set ($${this.orderState.sidePrice}), ignoring duplicate`);
      return;
    }
    this.orderState.sideConfirmed = true;
    this.orderState.sideDescription = description;
    this.orderState.sidePrice = price;
    this.orderState.runningTotal += price;
    this.logger.info('conversation.side_set', `Side: ${description} $${price}`, {
      description,
      price,
      running_total: this.orderState.runningTotal,
    });
  }

  updateDrink(description: string, price: number): void {
    if (this.orderState.drinkPrice !== null) {
      this.logger.debug('conversation.drink_price_duplicate', `Drink price already set ($${this.orderState.drinkPrice}), ignoring duplicate`);
      return;
    }
    if (this.ruleEngine.shouldSkipDrink(this.orderState, price)) {
      this.orderState.drinkSkipped = true;
      this.logger.info('conversation.drink_skipped', `Drink skipped — would exceed budget ($${this.orderState.runningTotal} + $${price} > $${this.order.budget_max})`, {
        price,
        running_total: this.orderState.runningTotal,
        budget_max: this.order.budget_max,
      });
      return;
    }

    this.orderState.drinkConfirmed = true;
    this.orderState.drinkDescription = description;
    this.orderState.drinkPrice = price;
    this.orderState.runningTotal += price;
    this.logger.info('conversation.drink_set', `Drink: ${description} $${price}`, {
      description,
      price,
      running_total: this.orderState.runningTotal,
    });
  }

  /** Track the employee-stated total for cross-checking against running total */
  updateHeardTotal(total: number): void {
    if (this.orderState.heardTotal !== null) {
      this.logger.debug('conversation.heard_total_duplicate', `Heard total already set ($${this.orderState.heardTotal}), updating`);
    }
    this.orderState.heardTotal = total;
    this.logger.info('conversation.heard_total_set', `Heard total: $${total} (running total: $${this.orderState.runningTotal})`, {
      heard_total: total,
      running_total: this.orderState.runningTotal,
    });
  }

  updateDeliveryTime(time: string): void {
    this.orderState.deliveryTime = time;
    this.logger.info('conversation.delivery_time_set', `Delivery time: ${time}`);
  }

  updateOrderNumber(number: string): void {
    this.orderState.orderNumber = number;
    this.logger.info('conversation.order_number_set', `Order number: ${number}`);
  }

  markSpecialInstructionsDelivered(): void {
    this.orderState.specialInstructionsDelivered = true;
    this.logger.info('conversation.instructions_delivered', 'Special instructions delivered');
  }

  skipSide(): void {
    this.orderState.sideSkipped = true;
    this.logger.info('conversation.side_skipped', 'Side skipped per order rules');
  }

  /** Advance to the next side backup option. Returns the next option or null if exhausted. */
  advanceSideOption(): string | null {
    const next = this.ruleEngine.getNextSideOption(this.orderState);
    if (next) {
      this.orderState.sideAttemptIndex++;
      this.logger.info('conversation.side_backup_advanced', `Advancing to side backup option: ${next}`, {
        option: next,
        attempt_index: this.orderState.sideAttemptIndex,
      });
    } else {
      // All options exhausted — skip side per order rules
      this.skipSide();
      this.logger.info('conversation.side_all_exhausted', 'All side backup options exhausted — skipping side');
    }
    return next;
  }

  /** Get the current next side option to suggest (without advancing) */
  getNextSideOption(): string | null {
    return this.ruleEngine.getNextSideOption(this.orderState);
  }
}
