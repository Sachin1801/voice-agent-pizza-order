/**
 * IVR Auto-Play Runner.
 *
 * Runs a scripted IVR sequence through the existing IVRStateMachine,
 * using hardcoded synthetic transcripts that match each IVR_PROMPTS pattern.
 * Returns a step-by-step trace of what the state machine did.
 */

import { OrderRequest } from '../../types';
import { Logger } from '../../logging/logger';
import { IVRStateMachine } from '../../ivr/ivr-state-machine';
import { IVR_PROMPTS } from '../../ivr/ivr-prompts';
import { IVRStepData, IVRAutoPlayData } from '../types';

/**
 * Synthetic transcripts that match each IVR state's prompt patterns.
 * These are what the IVR system would say at each stage.
 */
const SYNTHETIC_TRANSCRIPTS: Record<string, string> = {
  WELCOME: 'Thank you for calling. Press 1 for delivery.',
  NAME: 'Please say the name for the order.',
  CALLBACK_NUMBER: 'Please enter your 10-digit callback number.',
  ZIP_CODE: 'Please say your delivery ZIP code.',
  CONFIRMATION: 'Is that correct? Say yes to confirm.',
  TRANSFER: 'Please hold while we connect you to a team member.',
};

export function runIVRAutoPlay(order: OrderRequest, logger: Logger): IVRAutoPlayData {
  const machine = new IVRStateMachine(order, logger);
  const steps: IVRStepData[] = [];

  logger.info('debug.ivr_autoplay_started', 'IVR auto-play started', {
    customer_name: order.customer_name,
    total_prompts: IVR_PROMPTS.length,
  });

  for (let i = 0; i < IVR_PROMPTS.length; i++) {
    const promptConfig = IVR_PROMPTS[i];
    const stateBefore = machine.getState();
    const syntheticText = SYNTHETIC_TRANSCRIPTS[promptConfig.state] ?? `Synthetic prompt for ${promptConfig.state}`;

    // Feed the synthetic transcript through the state machine
    const action = machine.processTranscript(syntheticText, true);

    const stateAfter = machine.getState();
    const patternMatched = promptConfig.promptPatterns.find((p) => p.test(syntheticText));

    steps.push({
      step: i + 1,
      state_before: stateBefore,
      ivr_says: syntheticText,
      pattern_matched: patternMatched?.source ?? null,
      response_type: action.type === 'send_dtmf' ? 'dtmf' :
                     action.type === 'speak' ? 'speech' :
                     action.type === 'transition_to_hold' ? 'silence' :
                     action.type,
      response_value: action.type === 'send_dtmf' ? action.digits :
                      action.type === 'speak' ? action.text :
                      '',
      state_after: stateAfter,
    });

    logger.info('debug.ivr_step', `IVR step ${i + 1}: ${stateBefore} → ${stateAfter}`, {
      step: i + 1,
      state_before: stateBefore,
      state_after: stateAfter,
      response_type: action.type,
    });

    // Stop if IVR is complete
    if (machine.isComplete()) break;
  }

  logger.info('debug.ivr_autoplay_complete', `IVR auto-play finished in ${steps.length} steps`, {
    total_steps: steps.length,
    final_state: machine.getState(),
  });

  return {
    total_steps: steps.length,
    final_state: machine.getState(),
    steps,
  };
}
