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
  /** Function to derive the response value from order data (and optionally the matched transcript) */
  getResponse: (order: OrderRequest, transcript?: string) => string;
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
      // Only match when we hear the actual delivery option with its key number.
      // The key might be any digit (1, 2, 8, etc.) — we capture it dynamically.
      // Do NOT match on "thank you for calling" alone — that's just the greeting.
      /press\s*(\d)\s*(for)?\s*delivery/i,
      /delivery.{0,20}press\s*(\d)/i,
      /for\s*delivery\s*press\s*(\d)/i,
    ],
    responseType: 'dtmf',
    getResponse: (_order, transcript?: string) => {
      // Extract the actual digit from the transcript
      if (transcript) {
        const match = transcript.match(/press\s*(\d)\s*(for)?\s*delivery/i)
          ?? transcript.match(/delivery.{0,20}press\s*(\d)/i)
          ?? transcript.match(/for\s*delivery\s*press\s*(\d)/i);
        if (match?.[1]) return match[1];
      }
      return '1'; // fallback
    },
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
    getResponse: (order, transcript?: string) => {
      // Verify the IVR repeated the correct ZIP before confirming.
      // The IVR says something like "I heard seven eight seven four five. Is that correct?"
      // If the spoken digits don't match the expected ZIP, say "no" to reject.
      if (transcript) {
        const expectedZip = extractZipCode(order.delivery_address);
        const digitWords: Record<string, string> = {
          zero: '0', one: '1', two: '2', three: '3', four: '4',
          five: '5', six: '6', seven: '7', eight: '8', nine: '9',
        };
        // Check spoken digit words (e.g., "seven eight seven four five")
        const spokenDigits = transcript.match(/(?:seven|eight|nine|zero|one|two|three|four|five|six)/gi);
        if (spokenDigits && spokenDigits.length >= 5) {
          // Take the LAST 5 spoken digits (the ZIP, not phone number digits before it)
          const lastFive = spokenDigits.slice(-5);
          const spokenZip = lastFive.map((w) => digitWords[w.toLowerCase()] ?? '').join('');
          if (spokenZip && spokenZip !== expectedZip) {
            return 'no';
          }
        }
        // Check for raw 5-digit ZIP near "zip" keyword
        const zipContextMatch = transcript.match(/zip\s*(?:code)?\s*(\d{5})/i);
        if (zipContextMatch && zipContextMatch[1] !== expectedZip) {
          return 'no';
        }
      }
      return 'yes';
    },
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
