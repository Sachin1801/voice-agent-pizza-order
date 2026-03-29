/**
 * Debug tool types.
 *
 * Response envelope and diagnostic types for the voice-debug CLI.
 * Every HTTP response from the debug server conforms to DebugResponse<T>.
 * Designed for machine parsing by AI agents (Claude/Codex).
 */

import { LLMAction } from '../types';
import { OrderState } from '../conversation/rule-engine';

// ─── Response Envelope ─────────────────────────────────────────────────────

export interface DebugResponse<T = unknown> {
  success: boolean;
  command: string;
  timestamp: string;
  error?: string;
  data?: T;
}

// ─── Pipeline Diagnostic (returned by /send) ───────────────────────────────

export interface GroqRequestInfo {
  model: string;
  temperature: number;
  max_tokens: number;
  messages_count: number;
}

export interface GroqTokens {
  prompt: number | undefined;
  completion: number | undefined;
  total: number | undefined;
}

export interface ValidationResult {
  valid: boolean;
  error: string | null;
}

export interface RuleEngineResult {
  allowed: boolean;
  reason: string;
  modification: string | null;
}

export interface PipelineDiagnostic {
  system_prompt: string;
  system_prompt_length: number;
  debug_rules_injected: string[];
  context_prompt: string;
  groq_request: GroqRequestInfo;
  groq_response_raw: string;
  groq_response_parsed: LLMAction | null;
  groq_latency_ms: number;
  groq_tokens: GroqTokens;
  groq_finish_reason: string | undefined;
  groq_error: string | null;
  validation: ValidationResult;
  rule_engine: RuleEngineResult | null;
  final_speech: string;
  action_type: string;
}

export interface StateSnapshot {
  pizza_confirmed: boolean;
  pizza_price: number | null;
  side_confirmed: boolean;
  side_skipped: boolean;
  side_description: string | null;
  side_price: number | null;
  drink_confirmed: boolean;
  drink_skipped: boolean;
  drink_description: string | null;
  drink_price: number | null;
  running_total: number;
  substitutions: Record<string, string>;
  delivery_time: string | null;
  order_number: string | null;
  special_instructions_delivered: boolean;
}

export interface SendResponseData {
  turn_number: number;
  input: string;
  pipeline: PipelineDiagnostic;
  state: StateSnapshot;
  history_length: number;
  session_uptime_ms: number;
}

// ─── Session Info ──────────────────────────────────────────────────────────

export interface SessionInfoData {
  active: boolean;
  order_summary: {
    customer_name: string;
    pizza: string;
    side: string;
    drink: string;
    budget_max: number;
  };
  turn_count: number;
  history_length: number;
  rules_count: number;
  prompt_override_active: boolean;
  started_at: string;
  uptime_ms: number;
}

// ─── Start Response ────────────────────────────────────────────────────────

export interface StartResponseData {
  session_id: string;
  order_summary: {
    customer_name: string;
    pizza: string;
    side: string;
    drink: string;
    budget_max: number;
  };
  port: number;
  groq_model: string;
  rules_loaded: number;
}

// ─── Rules ─────────────────────────────────────────────────────────────────

export interface DebugRule {
  id: string;
  rule: string;
  category: string;
  added_by: string;
  timestamp: string;
}

export interface RulesListData {
  count: number;
  rules: DebugRule[];
}

export interface RuleAddedData {
  rule: DebugRule;
  total_rules: number;
}

export interface RuleRemovedData {
  removed_id: string;
  remaining_rules: number;
}

// ─── Rewind ────────────────────────────────────────────────────────────────

export interface RewindData {
  turns_removed: number;
  history_length_before: number;
  history_length_after: number;
}

// ─── IVR Auto-Play ─────────────────────────────────────────────────────────

export interface IVRStepData {
  step: number;
  state_before: string;
  ivr_says: string;
  pattern_matched: string | null;
  response_type: string;
  response_value: string;
  state_after: string;
}

export interface IVRAutoPlayData {
  total_steps: number;
  final_state: string;
  steps: IVRStepData[];
}

// ─── Replay ────────────────────────────────────────────────────────────────

export interface ReplayTurnDiff {
  action_type_match: boolean;
  text_similarity: number;
}

export interface ReplayTurnData {
  turn_number: number;
  employee_text: string;
  original_action: unknown;
  current: SendResponseData;
  diff: ReplayTurnDiff;
}

export interface ReplayData {
  call_id: string;
  order_summary: {
    customer_name: string;
    pizza: string;
  };
  total_employee_turns: number;
  turns: ReplayTurnData[];
}

// ─── Prompt ────────────────────────────────────────────────────────────────

export interface PromptViewData {
  system_prompt: string;
  system_prompt_length: number;
  debug_rules_block: string;
  prompt_override: string | null;
  full_prompt_length: number;
  prompt_version: string;
}

export interface PromptEditData {
  modification: string;
  previous_override: string | null;
  full_prompt_length: number;
}

// ─── Utility: Convert OrderState to StateSnapshot ──────────────────────────

export function toStateSnapshot(state: OrderState): StateSnapshot {
  return {
    pizza_confirmed: state.pizzaConfirmed,
    pizza_price: state.pizzaPrice,
    side_confirmed: state.sideConfirmed,
    side_skipped: state.sideSkipped,
    side_description: state.sideDescription,
    side_price: state.sidePrice,
    drink_confirmed: state.drinkConfirmed,
    drink_skipped: state.drinkSkipped,
    drink_description: state.drinkDescription,
    drink_price: state.drinkPrice,
    running_total: state.runningTotal,
    substitutions: { ...state.substitutions },
    delivery_time: state.deliveryTime,
    order_number: state.orderNumber,
    special_instructions_delivered: state.specialInstructionsDelivered,
  };
}
