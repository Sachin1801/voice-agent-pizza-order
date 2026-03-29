import { describe, it, expect, beforeEach } from 'vitest';
import { RuleEngine, OrderState, createInitialOrderState } from '../rule-engine';
import { OrderRequest, LLMAction } from '../../types';
import { createCallLogger } from '../../logging/logger';

const TEST_ORDER: OrderRequest = {
  customer_name: 'Jordan Mitchell',
  phone_number: '5125550147',
  delivery_address: '4821 Elm Street, Apt 3B, Austin, TX 78745',
  pizza: {
    size: 'large',
    crust: 'thin',
    toppings: ['pepperoni', 'mushroom', 'green pepper'],
    acceptable_topping_subs: ['sausage', 'bacon', 'onion', 'spinach', 'jalapeño'],
    no_go_toppings: ['olives', 'anchovies', 'pineapple'],
  },
  side: {
    first_choice: 'buffalo wings, 12 count',
    backup_options: ['garlic bread', 'breadsticks', 'mozzarella sticks'],
    if_all_unavailable: 'skip',
  },
  drink: {
    first_choice: '2L Coke',
    alternatives: ['2L Pepsi', '2L Sprite'],
    skip_if_over_budget: true,
  },
  budget_max: 45,
  special_instructions: 'Ring doorbell',
};

function createTestEngine() {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  return new RuleEngine(TEST_ORDER, logger);
}

describe('RuleEngine', () => {
  let engine: RuleEngine;
  let state: OrderState;

  beforeEach(() => {
    engine = createTestEngine();
    state = createInitialOrderState();
  });

  describe('substitution rules', () => {
    it('allows acceptable topping substitutions', () => {
      const action: LLMAction = {
        action: 'accept_substitution',
        original: 'mushroom',
        replacement: 'onion',
        text: 'Sure, onion is fine',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(true);
    });

    it('blocks no-go toppings', () => {
      const action: LLMAction = {
        action: 'accept_substitution',
        original: 'mushroom',
        replacement: 'olives',
        text: 'Sure, olives work',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('no-go');
    });

    it('blocks anchovies (no-go)', () => {
      const action: LLMAction = {
        action: 'accept_substitution',
        original: 'mushroom',
        replacement: 'anchovies',
        text: 'Anchovies are fine',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
    });

    it('blocks pineapple (no-go)', () => {
      const action: LLMAction = {
        action: 'accept_substitution',
        original: 'mushroom',
        replacement: 'pineapple',
        text: 'Pineapple works',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
    });

    it('blocks substitutions not in the acceptable list', () => {
      const action: LLMAction = {
        action: 'accept_substitution',
        original: 'mushroom',
        replacement: 'artichoke',
        text: 'Artichoke sounds good',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('acceptable substitutions');
    });
  });

  describe('hangup rules', () => {
    it('blocks completion if pizza not confirmed', () => {
      const action: LLMAction = {
        action: 'hangup_with_outcome',
        outcome: 'completed',
        reason: 'Order done',
        text: 'Thanks, bye!',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('pizza not confirmed');
    });

    it('blocks completion if special instructions not delivered', () => {
      state.pizzaConfirmed = true;
      const action: LLMAction = {
        action: 'hangup_with_outcome',
        outcome: 'completed',
        reason: 'Order done',
        text: 'Thanks!',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('special instructions');
    });

    it('allows completion when pizza confirmed and instructions delivered', () => {
      state.pizzaConfirmed = true;
      state.specialInstructionsDelivered = true;
      const action: LLMAction = {
        action: 'hangup_with_outcome',
        outcome: 'completed',
        reason: 'All done',
        text: 'Thank you!',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(true);
    });

    it('allows non-completed outcomes without requirements', () => {
      const action: LLMAction = {
        action: 'hangup_with_outcome',
        outcome: 'detected_as_bot',
        reason: 'Employee asked if I am a bot',
        text: 'Sorry, goodbye',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('budget rules', () => {
    it('shouldSkipDrink returns true when over budget', () => {
      state.runningTotal = 42;
      expect(engine.shouldSkipDrink(state, 4)).toBe(true);
    });

    it('shouldSkipDrink returns false when within budget', () => {
      state.runningTotal = 30;
      expect(engine.shouldSkipDrink(state, 4)).toBe(false);
    });
  });

  describe('generic actions', () => {
    it('allows say actions', () => {
      const action: LLMAction = {
        action: 'say',
        text: 'Hi, I would like to order a pizza',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(true);
    });

    it('allows repeat_field actions', () => {
      const action: LLMAction = {
        action: 'repeat_field',
        field: 'name',
        text: 'Jordan Mitchell',
      };
      const decision = engine.evaluate(action, state);
      expect(decision.allowed).toBe(true);
    });
  });
});
