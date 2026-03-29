/**
 * Canonical event schema for all structured logging.
 * Every event emitted by any component MUST conform to this shape.
 *
 * Required fields (from build plan):
 *   timestamp, call_id, session_id, sequence, component, event, level,
 *   direction, provider, correlation_id, latency_ms, state, message, data, redaction_level
 */

// ─── Stable enum-like event component names ─────────────────────────────────

export type EventComponent =
  | 'config'
  | 'server'
  | 'api'
  | 'twilio'
  | 'websocket'
  | 'session'
  | 'ivr'
  | 'hold'
  | 'deepgram'
  | 'groq'
  | 'cartesia'
  | 'conversation'
  | 'rule_engine'
  | 'audio_bridge'
  | 'artifact'
  | 'tts'
  | 'stt';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventDirection = 'inbound' | 'outbound' | 'internal';

export type RedactionLevel = 'raw' | 'redacted' | 'public';

// ─── The canonical event type ───────────────────────────────────────────────

export interface CallEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Unique call identifier */
  call_id: string;
  /** Session identifier (may differ from call_id on reconnects) */
  session_id: string;
  /** Auto-incrementing sequence number per call */
  sequence: number;
  /** Which module emitted this event */
  component: EventComponent;
  /** Stable event name (e.g., 'ivr.prompt_matched', 'groq.action_proposed') */
  event: string;
  /** Severity level */
  level: EventLevel;
  /** Direction of the interaction */
  direction: EventDirection;
  /** External provider involved, if any */
  provider: string | null;
  /** Links related events together (e.g., request-response pairs) */
  correlation_id: string | null;
  /** Milliseconds elapsed for timed operations */
  latency_ms: number | null;
  /** Current state of the session/component when event fired */
  state: string | null;
  /** Human-readable description */
  message: string;
  /** Arbitrary structured payload */
  data: Record<string, unknown> | null;
  /** Privacy level of this event's data */
  redaction_level: RedactionLevel;
}

// ─── Helper to create events with defaults ──────────────────────────────────

export interface CreateEventParams {
  call_id: string;
  session_id: string;
  sequence: number;
  component: EventComponent;
  event: string;
  level: EventLevel;
  message: string;
  direction?: EventDirection;
  provider?: string | null;
  correlation_id?: string | null;
  latency_ms?: number | null;
  state?: string | null;
  data?: Record<string, unknown> | null;
  redaction_level?: RedactionLevel;
}

export function createEvent(params: CreateEventParams): CallEvent {
  return {
    timestamp: new Date().toISOString(),
    call_id: params.call_id,
    session_id: params.session_id,
    sequence: params.sequence,
    component: params.component,
    event: params.event,
    level: params.level,
    direction: params.direction ?? 'internal',
    provider: params.provider ?? null,
    correlation_id: params.correlation_id ?? null,
    latency_ms: params.latency_ms ?? null,
    state: params.state ?? null,
    message: params.message,
    data: params.data ?? null,
    redaction_level: params.redaction_level ?? 'raw',
  };
}
