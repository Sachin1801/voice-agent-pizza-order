/**
 * IVR State Machine.
 *
 * Deterministic handler for the automated phone menu.
 * No LLM involvement — just pattern matching and exact responses.
 *
 * Required logs:
 *   - Every prompt match (what was heard vs what was expected)
 *   - Expected response type and actual response sent
 *   - Retry count per prompt
 *   - Every state transition with from/to states
 *   - DTMF control path events
 */

import { IVRState, OrderRequest } from '../types';
import { Logger } from '../logging/logger';
import { IVR_PROMPTS, matchPrompt, getPromptForState, IVRPromptConfig } from './ivr-prompts';

export type IVRAction =
  | { type: 'send_dtmf'; digits: string }
  | { type: 'speak'; text: string }
  | { type: 'silence' }
  | { type: 'transition_to_hold' }
  | { type: 'hangup'; reason: string }
  | { type: 'wait' };

export class IVRStateMachine {
  private state: IVRState = 'WELCOME';
  private retryCount: Map<IVRState, number> = new Map();
  private logger: Logger;
  private order: OrderRequest;
  private transcriptBuffer = '';

  constructor(order: OrderRequest, parentLogger: Logger) {
    this.order = order;
    this.logger = parentLogger.child('ivr');

    this.logger.info('ivr.initialized', 'IVR state machine initialized', {
      initial_state: this.state,
      customer_name: order.customer_name,
    });
  }

  /** Get the current IVR state */
  getState(): IVRState {
    return this.state;
  }

  /** Check if the IVR is complete (transitioned to HOLD or HUMAN_CONNECTED) */
  isComplete(): boolean {
    return this.state === 'HOLD' || this.state === 'HUMAN_CONNECTED';
  }

  /**
   * Process a transcript from STT.
   * Only acts on final transcripts — partials are ignored to prevent
   * premature IVR actions from incomplete speech (e.g., triggering on
   * "Thank you for calling" before "Press 1 for delivery" arrives).
   * Returns an action to take.
   */
  processTranscript(transcript: string, isFinal: boolean): IVRAction {
    // Ignore partial transcripts entirely — only finals are reliable enough for IVR actions
    if (!isFinal) {
      return { type: 'wait' };
    }

    // Accumulate final transcript
    this.transcriptBuffer += ' ' + transcript;

    // Try to match the accumulated transcript
    const match = matchPrompt(this.state, this.transcriptBuffer);
    if (match) {
      return this.handleMatch(match, this.transcriptBuffer);
    }

    // Check if this looks like a retry prompt ("I didn't understand")
    if (/didn't\s*understand|try\s*again|please\s*try/i.test(this.transcriptBuffer)) {
      return this.handleRetry();
    }

    // Check if IVR is giving up
    if (/call\s*back\s*later|goodbye/i.test(this.transcriptBuffer)) {
      this.logger.error('ivr.ivr_hangup', 'IVR gave up — too many failed attempts', {
        state: this.state,
        transcript: this.transcriptBuffer,
      });
      return { type: 'hangup', reason: 'IVR exhaustion — too many failed attempts' };
    }

    this.logger.debug('ivr.no_match', 'Transcript did not match expected prompt', {
      state: this.state,
      transcript: this.transcriptBuffer.trim(),
    });

    return { type: 'wait' };
  }

  /** Handle a successful prompt match */
  private handleMatch(promptConfig: IVRPromptConfig, transcript: string): IVRAction {
    const response = promptConfig.getResponse(this.order);

    this.logger.info('ivr.prompt_matched', `Matched ${this.state} prompt`, {
      state: this.state,
      expected_patterns: promptConfig.promptPatterns.map((p) => p.source),
      heard: transcript.trim(),
      response_type: promptConfig.responseType,
      response_value: promptConfig.responseType === 'dtmf' ? response : `"${response}"`,
    });

    // Clear buffer for next prompt
    this.transcriptBuffer = '';

    // Transition state
    const fromState = this.state;
    this.state = promptConfig.nextState;
    this.retryCount.delete(fromState);

    this.logger.info('ivr.state_transition', `${fromState} → ${this.state}`, {
      from: fromState,
      to: this.state,
    });

    // Return appropriate action
    switch (promptConfig.responseType) {
      case 'dtmf':
        return { type: 'send_dtmf', digits: response };

      case 'speech':
        return { type: 'speak', text: response };

      case 'silence':
        return { type: 'transition_to_hold' };
    }
  }

  /** Handle a retry (IVR didn't understand our response) */
  private handleRetry(): IVRAction {
    const currentRetries = (this.retryCount.get(this.state) ?? 0) + 1;
    this.retryCount.set(this.state, currentRetries);

    const promptConfig = getPromptForState(this.state);
    if (!promptConfig) {
      this.logger.error('ivr.retry_no_config', `No config for state ${this.state}`);
      return { type: 'hangup', reason: `No prompt config for state ${this.state}` };
    }

    if (currentRetries > promptConfig.maxRetries) {
      this.logger.error('ivr.max_retries_exceeded', `Max retries exceeded for ${this.state}`, {
        state: this.state,
        retry_count: currentRetries,
        max_retries: promptConfig.maxRetries,
      });
      return { type: 'hangup', reason: `Max retries (${promptConfig.maxRetries}) exceeded at ${this.state}` };
    }

    const response = promptConfig.getResponse(this.order);

    this.logger.warn('ivr.retry', `Retrying ${this.state} (attempt ${currentRetries}/${promptConfig.maxRetries})`, {
      state: this.state,
      retry_count: currentRetries,
      max_retries: promptConfig.maxRetries,
      response_type: promptConfig.responseType,
      response_value: response,
    });

    // Clear buffer and re-send
    this.transcriptBuffer = '';

    switch (promptConfig.responseType) {
      case 'dtmf':
        return { type: 'send_dtmf', digits: response };
      case 'speech':
        return { type: 'speak', text: response };
      case 'silence':
        return { type: 'silence' };
    }
  }
}
