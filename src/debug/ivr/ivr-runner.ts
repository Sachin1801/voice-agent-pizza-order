/**
 * IVR Auto-Play Runner.
 *
 * Two modes:
 *   1. Auto-play: runs hardcoded happy-path transcripts through the IVR state machine
 *   2. Custom test: feeds user-provided transcripts (from real call logs) to reproduce bugs
 *
 * Custom test mode lets AI agents replay exact Deepgram transcripts from real calls
 * to see how the IVR state machine reacts — essential for diagnosing premature triggers,
 * wrong pattern matches, and missing validation.
 */

import { OrderRequest } from '../../types';
import { Logger } from '../../logging/logger';
import { IVRStateMachine, IVRAction } from '../../ivr/ivr-state-machine';
import { IVR_PROMPTS, getPromptForState } from '../../ivr/ivr-prompts';
import { IVRStepData, IVRAutoPlayData } from '../types';

/**
 * Synthetic transcripts that match each IVR state's prompt patterns.
 * These are what the IVR system would say at each stage.
 */
const SYNTHETIC_TRANSCRIPTS: Record<string, string> = {
  WELCOME: 'Thank you for calling. For delivery, press 1. For pickup, press 2.',
  NAME: 'Please say the name for the order.',
  CALLBACK_NUMBER: 'Please enter your 10-digit callback number.',
  ZIP_CODE: 'Please say your delivery ZIP code.',
  CONFIRMATION: 'Is that correct? Say yes to confirm.',
  TRANSFER: 'Please hold while we connect you to a team member.',
};

/** Extract action details into a flat object for the response */
function describeAction(action: IVRAction): { response_type: string; response_value: string } {
  switch (action.type) {
    case 'send_dtmf': return { response_type: 'dtmf', response_value: action.digits };
    case 'speak': return { response_type: 'speech', response_value: action.text };
    case 'transition_to_hold': return { response_type: 'silence', response_value: '' };
    case 'hangup': return { response_type: 'hangup', response_value: action.reason };
    case 'wait': return { response_type: 'wait', response_value: '' };
    case 'silence': return { response_type: 'silence', response_value: '' };
  }
}

// ─── Auto-play mode (happy path) ───────────────────────────────────────────

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

    const action = machine.processTranscript(syntheticText, true);
    const stateAfter = machine.getState();
    const patternMatched = promptConfig.promptPatterns.find((p) => p.test(syntheticText));
    const { response_type, response_value } = describeAction(action);

    steps.push({
      step: i + 1,
      state_before: stateBefore,
      ivr_says: syntheticText,
      pattern_matched: patternMatched?.source ?? null,
      response_type,
      response_value,
      state_after: stateAfter,
    });

    logger.info('debug.ivr_step', `IVR step ${i + 1}: ${stateBefore} → ${stateAfter}`, {
      step: i + 1,
      state_before: stateBefore,
      state_after: stateAfter,
      response_type: action.type,
    });

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

// ─── Custom test mode (feed specific transcripts) ──────────────────────────

export interface IVRTestInput {
  /** The transcript text (what Deepgram would produce) */
  text: string;
  /** Whether this is a final transcript (true) or partial (false) */
  is_final: boolean;
}

export interface IVRTestStepResult {
  step: number;
  input_text: string;
  is_final: boolean;
  state_before: string;
  action_type: string;
  action_value: string;
  state_after: string;
  pattern_matched: string | null;
  transcript_buffer: string;
  diagnosis: string;
}

export interface IVRTestResult {
  total_inputs: number;
  final_state: string;
  steps: IVRTestStepResult[];
  issues_found: string[];
}

/**
 * Feed custom transcripts through the IVR state machine and diagnose behavior.
 * This reproduces exactly what happens during a real call.
 */
export function runIVRTest(
  order: OrderRequest,
  inputs: IVRTestInput[],
  logger: Logger
): IVRTestResult {
  const machine = new IVRStateMachine(order, logger);
  const steps: IVRTestStepResult[] = [];
  const issues: string[] = [];

  logger.info('debug.ivr_test_started', `IVR custom test: ${inputs.length} transcripts`, {
    input_count: inputs.length,
  });

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const stateBefore = machine.getState();

    const action = machine.processTranscript(input.text, input.is_final);
    const stateAfter = machine.getState();
    const { response_type, response_value } = describeAction(action);

    // Check which pattern matched (if any)
    const promptConfig = getPromptForState(stateBefore);
    let patternMatched: string | null = null;
    if (promptConfig && action.type !== 'wait') {
      for (const pattern of promptConfig.promptPatterns) {
        if (pattern.test(input.text)) {
          patternMatched = pattern.source;
          break;
        }
      }
      // If no single-input match, the accumulated buffer matched
      if (!patternMatched) {
        patternMatched = '(accumulated buffer match)';
      }
    }

    // Diagnose potential issues
    let diagnosis = 'OK';
    if (action.type !== 'wait' && stateBefore !== stateAfter) {
      // State changed — check if this was premature
      if (stateBefore === 'WELCOME' && !(/delivery/i.test(input.text) || /press\s*\d/i.test(input.text))) {
        diagnosis = 'PREMATURE: Matched WELCOME on greeting text before delivery option was mentioned';
        issues.push(`Step ${i + 1}: ${diagnosis}. Heard: "${input.text}"`);
      }
      if (stateBefore === 'CONFIRMATION' && action.type === 'speak' && response_value === 'yes') {
        // Check if ANY recent transcript contained the wrong data
        const expectedZip = order.delivery_address.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1];
        if (expectedZip) {
          // Look at this input + recent inputs for the IVR's read-back of the ZIP
          const recentTexts = inputs.slice(Math.max(0, i - 3), i + 1).map((t) => t.text).join(' ');
          const digitsInRecent = recentTexts.match(/\d/g)?.join('') ?? '';
          const spokenDigits = recentTexts.match(/(?:seven|eight|nine|zero|one|two|three|four|five|six)/gi);
          const digitWords: Record<string, string> = {
            zero: '0', one: '1', two: '2', three: '3', four: '4',
            five: '5', six: '6', seven: '7', eight: '8', nine: '9',
          };
          const spokenZip = spokenDigits?.map((w) => digitWords[w.toLowerCase()] ?? '').join('') ?? '';

          if (spokenZip && spokenZip !== expectedZip) {
            diagnosis = `WRONG_CONFIRMATION: Said "yes" but IVR repeated wrong ZIP. Expected "${expectedZip}", IVR said "${spokenZip}" (from: "${recentTexts}")`;
            issues.push(`Step ${i + 1}: ${diagnosis}`);
          } else if (digitsInRecent && !digitsInRecent.includes(expectedZip)) {
            diagnosis = `WRONG_CONFIRMATION: Said "yes" but digits in recent transcripts "${digitsInRecent}" don't match expected ZIP "${expectedZip}"`;
            issues.push(`Step ${i + 1}: ${diagnosis}`);
          }
        }
      }
    }

    steps.push({
      step: i + 1,
      input_text: input.text,
      is_final: input.is_final,
      state_before: stateBefore,
      action_type: response_type,
      action_value: response_value,
      state_after: stateAfter,
      pattern_matched: patternMatched,
      transcript_buffer: '(internal)',
      diagnosis,
    });

    logger.info('debug.ivr_test_step', `IVR test step ${i + 1}: "${input.text.slice(0, 60)}" → ${response_type}`, {
      step: i + 1,
      state_before: stateBefore,
      state_after: stateAfter,
      action_type: response_type,
      diagnosis,
    });

    if (machine.isComplete()) break;
  }

  logger.info('debug.ivr_test_complete', `IVR test finished: ${steps.length} steps, ${issues.length} issues`, {
    total_steps: steps.length,
    issues_count: issues.length,
    final_state: machine.getState(),
  });

  return {
    total_inputs: inputs.length,
    final_state: machine.getState(),
    steps,
    issues_found: issues,
  };
}
