/**
 * IVR prompt definitions.
 *
 * Each prompt maps an expected IVR prompt to the response type and
 * how to derive the response value from the order data.
 *
 * The IVR is a legacy system — it only accepts exact responses in the
 * format it asked for. No extra words, no natural language.
 */

import { IVRState, OrderRequest } from '../types';

export type IVRResponseType = 'dtmf' | 'speech' | 'silence';

export interface IVRPromptConfig {
  state: IVRState;
  /** Regex patterns to match the IVR prompt (what we hear via STT) */
  promptPatterns: RegExp[];
  /** How to respond */
  responseType: IVRResponseType;
  /** Function to derive the response value from order data */
  getResponse: (order: OrderRequest) => string;
  /** Next state after successful response */
  nextState: IVRState;
  /** Max retries before forced hangup */
  maxRetries: number;
}

/**
 * Extract the zip code from a delivery address.
 * Expects format like "4821 Elm Street, Apt 3B, Austin, TX 78745"
 */
function extractZipCode(address: string): string {
  const match = address.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (!match) {
    throw new Error(`Could not extract zip code from address: ${address}`);
  }
  return match[1];
}

/**
 * IVR prompt definitions in order.
 * The state machine walks through these sequentially.
 */
export const IVR_PROMPTS: IVRPromptConfig[] = [
  {
    state: 'WELCOME',
    promptPatterns: [
      /press\s*1\s*(for)?\s*delivery/i,
      /thank\s*you\s*for\s*calling/i,
    ],
    responseType: 'dtmf',
    getResponse: () => '1',
    nextState: 'NAME',
    maxRetries: 3,
  },
  {
    state: 'NAME',
    promptPatterns: [
      /say\s*(the)?\s*name/i,
      /name\s*for\s*the\s*order/i,
    ],
    responseType: 'speech',
    getResponse: (order) => order.customer_name,
    nextState: 'CALLBACK_NUMBER',
    maxRetries: 3,
  },
  {
    state: 'CALLBACK_NUMBER',
    promptPatterns: [
      /enter\s*(your)?\s*10.?digit/i,
      /callback\s*number/i,
    ],
    responseType: 'dtmf',
    getResponse: (order) => order.phone_number,
    nextState: 'ZIP_CODE',
    maxRetries: 3,
  },
  {
    state: 'ZIP_CODE',
    promptPatterns: [
      /say\s*(your)?\s*(delivery)?\s*zip/i,
      /zip\s*code/i,
    ],
    responseType: 'speech',
    getResponse: (order) => extractZipCode(order.delivery_address),
    nextState: 'CONFIRMATION',
    maxRetries: 3,
  },
  {
    state: 'CONFIRMATION',
    promptPatterns: [
      /is\s*that\s*correct/i,
      /say\s*'?yes'?\s*to\s*confirm/i,
    ],
    responseType: 'speech',
    getResponse: () => 'yes',
    nextState: 'TRANSFER',
    maxRetries: 3,
  },
  {
    state: 'TRANSFER',
    promptPatterns: [
      /please\s*hold/i,
      /connect\s*you/i,
      /team\s*member/i,
    ],
    responseType: 'silence',
    getResponse: () => '',
    nextState: 'HOLD',
    maxRetries: 1,
  },
];

/** Find the prompt config for a given IVR state */
export function getPromptForState(state: IVRState): IVRPromptConfig | undefined {
  return IVR_PROMPTS.find((p) => p.state === state);
}

/** Try to match a transcript against all prompt patterns for a given state */
export function matchPrompt(state: IVRState, transcript: string): IVRPromptConfig | null {
  const promptConfig = getPromptForState(state);
  if (!promptConfig) return null;

  for (const pattern of promptConfig.promptPatterns) {
    if (pattern.test(transcript)) {
      return promptConfig;
    }
  }

  return null;
}
