/**
 * Debug Session.
 *
 * In-memory session state container for a debug conversation.
 * Holds the order, conversation engine, rules manager, and session metadata.
 * One session is active at a time on the debug server.
 */

import { v4 as uuidv4 } from 'uuid';
import { OrderRequest } from '../../types';
import { Logger, createCallLogger } from '../../logging/logger';
import { createInitialOrderState } from '../../conversation/rule-engine';
import { DebugConversationEngine, ConversationTurn } from './debug-conversation-engine';
import { RulesManager } from '../rules/rules-manager';
import { DebugConfig } from '../config/debug-config';
import { SendResponseData, toStateSnapshot, SessionInfoData } from '../types';

export class DebugSession {
  readonly sessionId: string;
  readonly order: OrderRequest;
  readonly logger: Logger;
  readonly engine: DebugConversationEngine;
  readonly rulesManager: RulesManager;
  readonly startedAt: Date;
  readonly config: DebugConfig;

  constructor(order: OrderRequest, config: DebugConfig) {
    this.sessionId = uuidv4().slice(0, 8);
    this.order = order;
    this.config = config;
    this.startedAt = new Date();

    this.logger = createCallLogger(
      `debug-${this.sessionId}`,
      this.sessionId,
      'session',
      config.logLevel
    );

    this.rulesManager = new RulesManager(config.rulesFile);

    this.engine = new DebugConversationEngine(
      order,
      this.rulesManager,
      this.logger,
      {
        groqApiKey: config.groqApiKey,
        model: config.groqModel,
      }
    );

    this.logger.info('debug.session_created', `Debug session ${this.sessionId} created`, {
      session_id: this.sessionId,
      customer_name: order.customer_name,
      rules_loaded: this.rulesManager.count(),
    });
  }

  /** Send employee text and get full diagnostic response */
  async send(text: string): Promise<SendResponseData> {
    this.engine.addEmployeeSpeech(text);
    const result = await this.engine.generateResponse();

    return {
      turn_number: result.turn_number,
      input: text,
      pipeline: result.pipeline,
      state: result.state,
      history_length: result.history_length,
      session_uptime_ms: this.getUptimeMs(),
    };
  }

  /** Rewind conversation by N turns (removes both employee + agent turns) */
  rewind(turns: number): { turns_removed: number; history_before: number; history_after: number } {
    const history = this.engine.getConversationHistory();
    const lengthBefore = history.length;

    // Each "turn" is an employee message + agent response (2 entries)
    const entriesToRemove = Math.min(turns * 2, history.length);
    const newHistory = history.slice(0, history.length - entriesToRemove);
    this.engine.setConversationHistory(newHistory);

    this.logger.info('debug.rewind', `Rewound ${entriesToRemove} entries (${turns} turns)`, {
      turns_requested: turns,
      entries_removed: entriesToRemove,
      history_before: lengthBefore,
      history_after: newHistory.length,
    });

    return {
      turns_removed: Math.floor(entriesToRemove / 2),
      history_before: lengthBefore,
      history_after: newHistory.length,
    };
  }

  /** Reset session (clear history, reset order state, keep same order and rules) */
  reset(): void {
    this.engine.setConversationHistory([]);
    this.engine.setOrderState(createInitialOrderState());
    this.engine.setPromptOverride(null);

    this.logger.info('debug.session_reset', 'Session reset — history and state cleared');
  }

  /** Get session info */
  getInfo(): SessionInfoData {
    return {
      active: true,
      order_summary: this.getOrderSummary(),
      turn_count: this.engine.getRequestCount(),
      history_length: this.engine.getConversationHistory().length,
      rules_count: this.rulesManager.count(),
      prompt_override_active: this.engine.getPromptOverride() !== null,
      started_at: this.startedAt.toISOString(),
      uptime_ms: this.getUptimeMs(),
    };
  }

  /** Get conversation history */
  getHistory(): ConversationTurn[] {
    return this.engine.getConversationHistory();
  }

  getOrderSummary(): {
    customer_name: string;
    pizza: string;
    side: string;
    drink: string;
    budget_max: number;
  } {
    return {
      customer_name: this.order.customer_name,
      pizza: `${this.order.pizza.size} ${this.order.pizza.crust}, ${this.order.pizza.toppings.join(', ')}`,
      side: this.order.side.first_choice,
      drink: this.order.drink.first_choice,
      budget_max: this.order.budget_max,
    };
  }

  private getUptimeMs(): number {
    return Date.now() - this.startedAt.getTime();
  }
}
