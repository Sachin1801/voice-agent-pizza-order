import { describe, it, expect, beforeEach } from 'vitest';
import { ResultAssembler } from '../result-assembler';
import { OrderRequest } from '../../types';
import { OrderState, createInitialOrderState } from '../../conversation/rule-engine';
import { createCallLogger } from '../../logging/logger';

const TEST_ORDER: OrderRequest = {
  customer_name: 'Jordan Mitchell',
  phone_number: '5125550147',
  delivery_address: '4821 Elm Street, Apt 3B, Austin, TX 78745',
  pizza: {
    size: 'large',
    crust: 'thin',
    toppings: ['pepperoni', 'mushroom', 'green pepper'],
    acceptable_topping_subs: ['sausage', 'bacon', 'onion'],
    no_go_toppings: ['olives', 'anchovies', 'pineapple'],
  },
  side: {
    first_choice: 'buffalo wings, 12 count',
    backup_options: ['garlic bread', 'breadsticks'],
    if_all_unavailable: 'skip',
  },
  drink: {
    first_choice: '2L Coke',
    alternatives: ['2L Pepsi'],
    skip_if_over_budget: true,
  },
  budget_max: 45,
  special_instructions: 'Ring doorbell',
};

function createTestAssembler() {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  return new ResultAssembler(logger);
}

describe('ResultAssembler', () => {
  let assembler: ResultAssembler;
  let state: OrderState;

  beforeEach(() => {
    assembler = createTestAssembler();
    state = createInitialOrderState();
  });

  describe('completed outcome — full order', () => {
    it('builds complete result with all fields populated', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.sideConfirmed = true;
      state.sideDescription = 'garlic bread';
      state.sidePrice = 6.99;
      state.drinkConfirmed = true;
      state.drinkDescription = '2L Coke';
      state.drinkPrice = 3.49;
      state.runningTotal = 28.98;
      state.substitutions = { mushroom: 'onion' };
      state.deliveryTime = '35 minutes';
      state.orderNumber = '4412';
      state.specialInstructionsDelivered = true;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.outcome).toBe('completed');
      expect(result.pizza).toEqual({
        description: 'large thin with pepperoni, onion, green pepper',
        substitutions: { mushroom: 'onion' },
        price: 18.50,
      });
      expect(result.side).toEqual({
        description: 'garlic bread',
        original: 'buffalo wings, 12 count',
        price: 6.99,
      });
      expect(result.drink).toEqual({
        description: '2L Coke',
        price: 3.49,
      });
      expect(result.drink_skip_reason).toBeNull();
      expect(result.total).toBe(28.98);
      expect(result.delivery_time).toBe('35 minutes');
      expect(result.order_number).toBe('4412');
      expect(result.special_instructions_delivered).toBe(true);
    });
  });

  describe('pizza description with substitutions', () => {
    it('applies substitutions to pizza toppings', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.substitutions = { pepperoni: 'sausage', 'green pepper': 'bacon' };
      state.runningTotal = 18.50;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.pizza!.description).toBe('large thin with sausage, mushroom, bacon');
      expect(result.pizza!.substitutions).toEqual({
        pepperoni: 'sausage',
        'green pepper': 'bacon',
      });
    });

    it('preserves original toppings when no substitutions', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.runningTotal = 18.50;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.pizza!.description).toBe('large thin with pepperoni, mushroom, green pepper');
      expect(result.pizza!.substitutions).toEqual({});
    });
  });

  describe('drink skip with reason', () => {
    it('sets drink to null with skip reason when drink is skipped', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 40;
      state.sideConfirmed = true;
      state.sidePrice = 6.99;
      state.drinkSkipped = true;
      state.runningTotal = 46.99;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.drink).toBeNull();
      expect(result.drink_skip_reason).toBe('Skipped — would exceed budget of $45');
    });

    it('has no skip reason when drink is confirmed', () => {
      state.drinkConfirmed = true;
      state.drinkDescription = '2L Coke';
      state.drinkPrice = 3.49;
      state.runningTotal = 3.49;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.drink).not.toBeNull();
      expect(result.drink_skip_reason).toBeNull();
    });

    it('has no skip reason when drink was not ordered at all', () => {
      const result = assembler.buildResult('nothing_available', TEST_ORDER, state);

      expect(result.drink).toBeNull();
      expect(result.drink_skip_reason).toBeNull();
    });
  });

  describe('heard total vs running total', () => {
    it('prefers heardTotal over runningTotal when available', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.runningTotal = 18.50;
      state.heardTotal = 19.95; // employee stated a different total (tax, etc.)

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.total).toBe(19.95);
    });

    it('falls back to runningTotal when heardTotal is null', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.runningTotal = 18.50;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.total).toBe(18.50);
    });

    it('returns null total when both are zero/null', () => {
      const result = assembler.buildResult('nothing_available', TEST_ORDER, state);

      expect(result.total).toBeNull();
    });
  });

  describe('partial results for non-completed outcomes', () => {
    it('includes whatever was collected before nothing_available', () => {
      state.pizzaConfirmed = true;
      state.pizzaPrice = 18.50;
      state.runningTotal = 18.50;
      // Side and drink were not ordered

      const result = assembler.buildResult('nothing_available', TEST_ORDER, state);

      expect(result.outcome).toBe('nothing_available');
      expect(result.pizza).not.toBeNull();
      expect(result.side).toBeNull();
      expect(result.drink).toBeNull();
    });

    it('includes nothing when call ended before any data', () => {
      const result = assembler.buildResult('detected_as_bot', TEST_ORDER, state);

      expect(result.outcome).toBe('detected_as_bot');
      expect(result.pizza).toBeNull();
      expect(result.side).toBeNull();
      expect(result.drink).toBeNull();
      expect(result.total).toBeNull();
    });
  });

  describe('side uses first_choice as default description', () => {
    it('uses sideDescription when available', () => {
      state.sideConfirmed = true;
      state.sideDescription = 'garlic bread';
      state.sidePrice = 5.99;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.side!.description).toBe('garlic bread');
      expect(result.side!.original).toBe('buffalo wings, 12 count');
    });

    it('falls back to order first_choice when sideDescription is null', () => {
      state.sideConfirmed = true;
      state.sidePrice = 8.99;

      const result = assembler.buildResult('completed', TEST_ORDER, state);

      expect(result.side!.description).toBe('buffalo wings, 12 count');
    });
  });
});
