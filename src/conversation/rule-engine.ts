/**
 * Rule Engine.
 *
 * Enforces business rules in CODE, not just in prompts.
 * Even if the LLM proposes an invalid action, the rule engine blocks it.
 *
 * Required logs:
 *   - Every accept/reject decision with reason
 *   - Rule engine modifications to proposed actions
 */

import { OrderRequest, LLMAction } from '../types';
import { Logger } from '../logging/logger';

export interface RuleDecision {
  allowed: boolean;
  action: LLMAction | null;
  reason: string;
  modification: string | null;
}

export interface OrderState {
  pizzaConfirmed: boolean;
  pizzaPrice: number | null;
  sideConfirmed: boolean;
  sideSkipped: boolean;
  sideDescription: string | null;
  sidePrice: number | null;
  sideAttemptIndex: number; // which backup option we're trying next
  drinkConfirmed: boolean;
  drinkSkipped: boolean;
  drinkDescription: string | null;
  drinkPrice: number | null;
  runningTotal: number;
  substitutions: Record<string, string>;
  deliveryTime: string | null;
  orderNumber: string | null;
  specialInstructionsDelivered: boolean;
}

export function createInitialOrderState(): OrderState {
  return {
    pizzaConfirmed: false,
    pizzaPrice: null,
    sideConfirmed: false,
    sideSkipped: false,
    sideDescription: null,
    sidePrice: null,
    sideAttemptIndex: 0,
    drinkConfirmed: false,
    drinkSkipped: false,
    drinkDescription: null,
    drinkPrice: null,
    runningTotal: 0,
    substitutions: {},
    deliveryTime: null,
    orderNumber: null,
    specialInstructionsDelivered: false,
  };
}

export class RuleEngine {
  private logger: Logger;
  private order: OrderRequest;

  constructor(order: OrderRequest, parentLogger: Logger) {
    this.order = order;
    this.logger = parentLogger.child('rule_engine');
  }

  /** Evaluate a proposed LLM action against business rules */
  evaluate(action: LLMAction, state: OrderState): RuleDecision {
    switch (action.action) {
      case 'accept_substitution':
        return this.evaluateSubstitution(action, state);

      case 'reject_substitution':
        return this.evaluateRejection(action);

      case 'hangup_with_outcome':
        return this.evaluateHangup(action, state);

      case 'say':
      case 'ask_for_exact_price':
      case 'repeat_field':
      case 'confirm_done':
        return this.evaluateGenericAction(action, state);

      default:
        this.logger.warn('rule_engine.unknown_action', `Unknown action type`, {
          action,
        });
        return { allowed: false, action: null, reason: 'Unknown action type', modification: null };
    }
  }

  private evaluateSubstitution(
    action: Extract<LLMAction, { action: 'accept_substitution' }>,
    state: OrderState
  ): RuleDecision {
    const replacement = action.replacement.toLowerCase();

    // Check no-go toppings
    if (this.order.pizza.no_go_toppings.some((t) => replacement.includes(t.toLowerCase()))) {
      this.logger.warn('rule_engine.blocked_nogo_topping',
        `BLOCKED: LLM tried to accept no-go topping "${action.replacement}"`, {
          offered: action.replacement,
          no_go_list: this.order.pizza.no_go_toppings,
          decision: 'rejected',
        });
      return {
        allowed: false,
        action: null,
        reason: `"${action.replacement}" is on the no-go list`,
        modification: null,
      };
    }

    // Check if replacement is in acceptable subs
    const isAcceptable = this.order.pizza.acceptable_topping_subs.some(
      (t) => replacement.includes(t.toLowerCase())
    );

    if (!isAcceptable) {
      this.logger.warn('rule_engine.blocked_unapproved_sub',
        `BLOCKED: "${action.replacement}" is not in acceptable substitutions list`, {
          offered: action.replacement,
          acceptable_list: this.order.pizza.acceptable_topping_subs,
          decision: 'rejected',
        });
      return {
        allowed: false,
        action: null,
        reason: `"${action.replacement}" is not in the acceptable substitutions list`,
        modification: null,
      };
    }

    this.logger.info('rule_engine.substitution_allowed',
      `Substitution allowed: ${action.original} → ${action.replacement}`, {
        original: action.original,
        replacement: action.replacement,
        decision: 'allowed',
      });

    return { allowed: true, action, reason: 'Substitution is in acceptable list', modification: null };
  }

  private evaluateRejection(
    action: Extract<LLMAction, { action: 'reject_substitution' }>
  ): RuleDecision {
    const offered = action.offered.toLowerCase();

    // Verify the rejection makes sense (is it actually a no-go or unapproved?)
    const isNoGo = this.order.pizza.no_go_toppings.some(
      (t) => offered.includes(t.toLowerCase())
    );
    const isAcceptable = this.order.pizza.acceptable_topping_subs.some(
      (t) => offered.includes(t.toLowerCase())
    );

    if (isAcceptable && !isNoGo) {
      this.logger.warn('rule_engine.unnecessary_rejection',
        `LLM rejected "${action.offered}" but it's in acceptable list — allowing rejection but logging`, {
          offered: action.offered,
          is_acceptable: true,
          is_no_go: false,
          decision: 'allowed_with_warning',
        });
    }

    this.logger.info('rule_engine.rejection_allowed',
      `Rejection allowed: "${action.offered}" — ${action.reason}`, {
        offered: action.offered,
        reason: action.reason,
        decision: 'allowed',
      });

    return { allowed: true, action, reason: 'Rejection is valid', modification: null };
  }

  private evaluateHangup(
    action: Extract<LLMAction, { action: 'hangup_with_outcome' }>,
    state: OrderState
  ): RuleDecision {
    // For 'completed' outcome, verify we have minimum required info
    if (action.outcome === 'completed') {
      if (!state.pizzaConfirmed) {
        this.logger.warn('rule_engine.premature_completion',
          'LLM tried to complete but pizza not confirmed', {
            pizza_confirmed: state.pizzaConfirmed,
            decision: 'rejected',
          });
        return {
          allowed: false,
          action: null,
          reason: 'Cannot complete: pizza not confirmed',
          modification: null,
        };
      }

      if (!state.specialInstructionsDelivered) {
        this.logger.warn('rule_engine.missing_instructions',
          'LLM tried to complete but special instructions not delivered', {
            decision: 'rejected',
          });
        return {
          allowed: false,
          action: null,
          reason: 'Cannot complete: special instructions not delivered',
          modification: null,
        };
      }
    }

    this.logger.info('rule_engine.hangup_allowed',
      `Hangup allowed: outcome=${action.outcome}`, {
        outcome: action.outcome,
        reason: action.reason,
        decision: 'allowed',
      });

    return { allowed: true, action, reason: 'Hangup conditions met', modification: null };
  }

  private evaluateGenericAction(action: LLMAction, state: OrderState): RuleDecision {
    // Budget check: if running total already exceeds budget, don't order more
    if (action.action === 'say' && state.runningTotal > this.order.budget_max) {
      this.logger.warn('rule_engine.over_budget',
        `Running total $${state.runningTotal} exceeds budget $${this.order.budget_max}`, {
          running_total: state.runningTotal,
          budget_max: this.order.budget_max,
          decision: 'allowed_with_warning',
        });
    }

    // Check if drink should be skipped
    if (
      action.action === 'say' &&
      this.order.drink.skip_if_over_budget &&
      !state.drinkConfirmed &&
      !state.drinkSkipped &&
      state.runningTotal + 5 > this.order.budget_max // rough estimate
    ) {
      this.logger.info('rule_engine.drink_skip_recommended',
        'Drink may push total over budget — skip recommended', {
          running_total: state.runningTotal,
          budget_max: this.order.budget_max,
        });
    }

    return { allowed: true, action, reason: 'No rule violations', modification: null };
  }

  /** Get the next side to try from backup options */
  getNextSideOption(state: OrderState): string | null {
    if (state.sideAttemptIndex >= this.order.side.backup_options.length) {
      return null; // All options exhausted
    }
    return this.order.side.backup_options[state.sideAttemptIndex];
  }

  /** Check if drink should be skipped due to budget */
  shouldSkipDrink(state: OrderState, estimatedDrinkPrice: number): boolean {
    if (!this.order.drink.skip_if_over_budget) return false;
    return state.runningTotal + estimatedDrinkPrice > this.order.budget_max;
  }
}
