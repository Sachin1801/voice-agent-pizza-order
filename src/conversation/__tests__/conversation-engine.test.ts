import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock config before any imports that use it
vi.mock('../../config', () => ({
  config: {
    groqApiKey: 'test-key',
    groqModel: 'llama-3.3-70b-versatile',
    logLevel: 'error',
    artifactsDir: '/tmp/test-artifacts',
    enableAudioRecording: false,
  },
}));

import { ConversationEngine } from '../conversation-engine';
import { OrderRequest } from '../../types';
import { createCallLogger } from '../../logging/logger';
import { ArtifactWriter } from '../../logging/artifact-writer';

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
  const artifacts = new ArtifactWriter('test', '/tmp/test-artifacts', false, logger);
  return new ConversationEngine(TEST_ORDER, logger, artifacts);
}

describe('ConversationEngine — idempotent price updates', () => {
  let engine: ConversationEngine;

  beforeEach(() => {
    engine = createTestEngine();
  });

  describe('updatePizzaPrice', () => {
    it('sets pizza price and updates running total on first call', () => {
      engine.updatePizzaPrice(18.50);
      const state = engine.getOrderState();
      expect(state.pizzaConfirmed).toBe(true);
      expect(state.pizzaPrice).toBe(18.50);
      expect(state.runningTotal).toBe(18.50);
    });

    it('ignores duplicate pizza price updates', () => {
      engine.updatePizzaPrice(18.50);
      engine.updatePizzaPrice(18.50);
      engine.updatePizzaPrice(18.50);
      const state = engine.getOrderState();
      expect(state.pizzaPrice).toBe(18.50);
      expect(state.runningTotal).toBe(18.50);
    });

    it('ignores duplicate even with different price', () => {
      engine.updatePizzaPrice(18.50);
      engine.updatePizzaPrice(22.00);
      const state = engine.getOrderState();
      expect(state.pizzaPrice).toBe(18.50);
      expect(state.runningTotal).toBe(18.50);
    });
  });

  describe('updateSide', () => {
    it('sets side and updates running total on first call', () => {
      engine.updateSide('garlic bread', 6.99);
      const state = engine.getOrderState();
      expect(state.sideConfirmed).toBe(true);
      expect(state.sidePrice).toBe(6.99);
      expect(state.runningTotal).toBe(6.99);
    });

    it('ignores duplicate side price updates', () => {
      engine.updateSide('garlic bread', 6.99);
      engine.updateSide('garlic bread', 6.99);
      const state = engine.getOrderState();
      expect(state.sidePrice).toBe(6.99);
      expect(state.runningTotal).toBe(6.99);
    });
  });

  describe('updateDrink', () => {
    it('sets drink and updates running total on first call', () => {
      engine.updateDrink('2L Coke', 3.49);
      const state = engine.getOrderState();
      expect(state.drinkConfirmed).toBe(true);
      expect(state.drinkPrice).toBe(3.49);
      expect(state.runningTotal).toBe(3.49);
    });

    it('ignores duplicate drink price updates', () => {
      engine.updateDrink('2L Coke', 3.49);
      engine.updateDrink('2L Coke', 3.49);
      const state = engine.getOrderState();
      expect(state.drinkPrice).toBe(3.49);
      expect(state.runningTotal).toBe(3.49);
    });

    it('skips drink when over budget', () => {
      engine.updatePizzaPrice(40.00);
      engine.updateDrink('2L Coke', 6.00);
      const state = engine.getOrderState();
      expect(state.drinkSkipped).toBe(true);
      expect(state.drinkPrice).toBeNull();
      expect(state.runningTotal).toBe(40.00);
    });

    it('correctly allows drink with non-inflated total', () => {
      // Verifies cascading fix: pizza + side = $25.49, drink $3.49 is under $45
      engine.updatePizzaPrice(18.50);
      engine.updateSide('garlic bread', 6.99);
      engine.updateDrink('2L Coke', 3.49);
      const state = engine.getOrderState();
      expect(state.drinkConfirmed).toBe(true);
      expect(state.drinkPrice).toBe(3.49);
      expect(state.runningTotal).toBeCloseTo(28.98, 2);
    });
  });

  describe('full order total with duplicates', () => {
    it('calculates correct total even when all prices are set multiple times', () => {
      engine.updatePizzaPrice(18.50);
      engine.updatePizzaPrice(18.50);
      engine.updateSide('garlic bread', 6.99);
      engine.updateSide('garlic bread', 6.99);
      engine.updateDrink('2L Coke', 3.49);
      engine.updateDrink('2L Coke', 3.49);

      const state = engine.getOrderState();
      expect(state.runningTotal).toBeCloseTo(28.98, 2);
    });
  });
});
