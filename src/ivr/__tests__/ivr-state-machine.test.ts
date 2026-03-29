import { describe, it, expect, beforeEach } from 'vitest';
import { IVRStateMachine } from '../ivr-state-machine';
import { OrderRequest } from '../../types';
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

function createTestMachine() {
  const logger = createCallLogger('test', 'test', 'session', 'error'); // suppress console
  return new IVRStateMachine(TEST_ORDER, logger);
}

describe('IVRStateMachine', () => {
  let machine: IVRStateMachine;

  beforeEach(() => {
    machine = createTestMachine();
  });

  it('starts in WELCOME state', () => {
    expect(machine.getState()).toBe('WELCOME');
  });

  it('sends DTMF 1 when it hears the welcome prompt', () => {
    const action = machine.processTranscript(
      'Thank you for calling. Press 1 for delivery. Press 2 for carryout.',
      true
    );
    expect(action).toEqual({ type: 'send_dtmf', digits: '1' });
    expect(machine.getState()).toBe('NAME');
  });

  it('responds with customer name on NAME prompt', () => {
    machine.processTranscript('Press 1 for delivery', true);
    const action = machine.processTranscript('Please say the name for the order.', true);
    expect(action).toEqual({ type: 'speak', text: 'Jordan Mitchell' });
    expect(machine.getState()).toBe('CALLBACK_NUMBER');
  });

  it('sends phone number as DTMF on callback prompt', () => {
    machine.processTranscript('Press 1 for delivery', true);
    machine.processTranscript('Please say the name for the order.', true);
    const action = machine.processTranscript(
      'Please enter your 10-digit callback number.',
      true
    );
    expect(action).toEqual({ type: 'send_dtmf', digits: '5125550147' });
    expect(machine.getState()).toBe('ZIP_CODE');
  });

  it('says zip code on zip prompt', () => {
    machine.processTranscript('Press 1 for delivery', true);
    machine.processTranscript('say the name', true);
    machine.processTranscript('enter your 10-digit callback', true);
    const action = machine.processTranscript('Please say your delivery zip code.', true);
    expect(action).toEqual({ type: 'speak', text: '78745' });
    expect(machine.getState()).toBe('CONFIRMATION');
  });

  it('says yes on confirmation prompt', () => {
    machine.processTranscript('Press 1 for delivery', true);
    machine.processTranscript('say the name', true);
    machine.processTranscript('enter your 10-digit callback', true);
    machine.processTranscript('say your zip code', true);
    const action = machine.processTranscript(
      "I heard Jordan Mitchell, 5125550147, zip code 78745. Is that correct? Say 'yes' to confirm.",
      true
    );
    expect(action).toEqual({ type: 'speak', text: 'yes' });
    expect(machine.getState()).toBe('TRANSFER');
  });

  it('transitions to hold on transfer prompt', () => {
    machine.processTranscript('Press 1 for delivery', true);
    machine.processTranscript('say the name', true);
    machine.processTranscript('enter your 10-digit callback', true);
    machine.processTranscript('say your zip code', true);
    machine.processTranscript("Is that correct? Say 'yes' to confirm.", true);
    const action = machine.processTranscript(
      'Got it. Please hold while we connect you to a team member.',
      true
    );
    expect(action).toEqual({ type: 'transition_to_hold' });
    expect(machine.getState()).toBe('HOLD');
    expect(machine.isComplete()).toBe(true);
  });

  it('handles retry when IVR says it did not understand', () => {
    const action = machine.processTranscript(
      "I didn't understand that. Please try again.",
      true
    );
    expect(action.type).toBe('send_dtmf');
    if (action.type === 'send_dtmf') {
      expect(action.digits).toBe('1');
    }
  });

  it('hangs up after max retries', () => {
    machine.processTranscript("I didn't understand that, please try again", true);
    machine.processTranscript("I didn't understand that, please try again", true);
    machine.processTranscript("I didn't understand that, please try again", true);
    const action = machine.processTranscript("I didn't understand that, please try again", true);
    expect(action.type).toBe('hangup');
  });

  it('hangs up when IVR says call back later', () => {
    const action = machine.processTranscript(
      "I'm sorry, I'm having trouble understanding you. Please call back later.",
      true
    );
    expect(action.type).toBe('hangup');
  });

  it('returns wait for non-matching transcripts', () => {
    const action = machine.processTranscript('some random noise', true);
    expect(action.type).toBe('wait');
  });

  it('returns wait for partial non-matching transcripts', () => {
    const action = machine.processTranscript('some random', false);
    expect(action.type).toBe('wait');
  });

  describe('final-only processing', () => {
    it('partial welcome transcript returns wait and does not change state', () => {
      const action = machine.processTranscript('Thank you for calling', false);
      expect(action).toEqual({ type: 'wait' });
      expect(machine.getState()).toBe('WELCOME');
    });

    it('partial welcome followed by final full menu triggers DTMF only on the final', () => {
      // Partial: should be ignored entirely
      const partialAction = machine.processTranscript('Thank you for calling', false);
      expect(partialAction).toEqual({ type: 'wait' });
      expect(machine.getState()).toBe('WELCOME');

      // Final with the full prompt: should trigger DTMF
      const finalAction = machine.processTranscript(
        'Thank you for calling. Press 1 for delivery. Press 2 for carryout.',
        true
      );
      expect(finalAction).toEqual({ type: 'send_dtmf', digits: '1' });
      expect(machine.getState()).toBe('NAME');
    });

    it('partial transcript with matching content does NOT trigger action', () => {
      // Even if the partial contains "press 1 for delivery", it should be ignored
      const action = machine.processTranscript('Press 1 for delivery', false);
      expect(action).toEqual({ type: 'wait' });
      expect(machine.getState()).toBe('WELCOME');
    });
  });
});
