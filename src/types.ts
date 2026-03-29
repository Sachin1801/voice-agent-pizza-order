import { z } from 'zod';

// ─── Order Request (matches spec payload exactly) ───────────────────────────

export const PizzaSchema = z.object({
  size: z.string(),
  crust: z.string(),
  toppings: z.array(z.string()),
  acceptable_topping_subs: z.array(z.string()),
  no_go_toppings: z.array(z.string()),
});

export const SideSchema = z.object({
  first_choice: z.string(),
  backup_options: z.array(z.string()),
  if_all_unavailable: z.enum(['skip']),
});

export const DrinkSchema = z.object({
  first_choice: z.string(),
  alternatives: z.array(z.string()),
  skip_if_over_budget: z.boolean(),
});

export const OrderRequestSchema = z.object({
  customer_name: z.string().min(1),
  phone_number: z.string().length(10),
  delivery_address: z.string().min(1),
  pizza: PizzaSchema,
  side: SideSchema,
  drink: DrinkSchema,
  budget_max: z.number().positive(),
  special_instructions: z.string(),
});

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

// ─── Call Outcome ───────────────────────────────────────────────────────────

export type CallOutcome =
  | 'completed'
  | 'nothing_available'
  | 'over_budget'
  | 'detected_as_bot';

// ─── Call Result (output after call ends) ───────────────────────────────────

export interface PizzaResult {
  description: string;
  substitutions: Record<string, string>;
  price: number;
}

export interface SideResult {
  description: string;
  original: string;
  price: number;
}

export interface DrinkResult {
  description: string;
  price: number;
}

export interface CallResult {
  outcome: CallOutcome;
  pizza: PizzaResult | null;
  side: SideResult | null;
  drink: DrinkResult | null;
  drink_skip_reason: string | null;
  total: number | null;
  delivery_time: string | null;
  order_number: string | null;
  special_instructions_delivered: boolean;
}

// ─── API Types ──────────────────────────────────────────────────────────────

export interface CreateCallRequest {
  order: OrderRequest;
  target_number?: string;
}

export interface CreateCallResponse {
  call_id: string;
  status: string;
}

// ─── LLM Action Types ──────────────────────────────────────────────────────

export const LLMActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('say'),
    text: z.string(),
    // Optional structured data the LLM can attach when it hears prices/info
    heard_price: z.object({ item: z.string(), price: z.number() }).optional(),
    heard_total: z.number().optional(),
    heard_delivery_time: z.string().optional(),
    heard_order_number: z.string().optional(),
    delivering_special_instructions: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('ask_for_exact_price'),
    item: z.string(),
    text: z.string(),
  }),
  z.object({
    action: z.literal('accept_substitution'),
    original: z.string(),
    replacement: z.string(),
    text: z.string(),
  }),
  z.object({
    action: z.literal('reject_substitution'),
    offered: z.string(),
    reason: z.string(),
    text: z.string(),
  }),
  z.object({
    action: z.literal('repeat_field'),
    field: z.string(),
    text: z.string(),
  }),
  z.object({
    action: z.literal('confirm_done'),
    text: z.string(),
  }),
  z.object({
    action: z.literal('hangup_with_outcome'),
    outcome: z.enum([
      'completed',
      'nothing_available',
      'over_budget',
      'detected_as_bot',
    ]),
    reason: z.string(),
    text: z.string(),
  }),
]);

export type LLMAction = z.infer<typeof LLMActionSchema>;

// ─── Call Session State ─────────────────────────────────────────────────────

export type CallPhase =
  | 'initializing'
  | 'ivr'
  | 'hold'
  | 'conversation'
  | 'hangup'
  | 'completed'
  | 'failed';

export type IVRState =
  | 'WELCOME'
  | 'NAME'
  | 'CALLBACK_NUMBER'
  | 'ZIP_CODE'
  | 'CONFIRMATION'
  | 'TRANSFER'
  | 'HOLD'
  | 'HUMAN_CONNECTED';
