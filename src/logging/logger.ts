/**
 * Logger facade: dual-output structured logging.
 *   - Console: concise, colorized, human-friendly for live debugging
 *   - File: structured JSONL for machine parsing by Claude/Codex
 *
 * Supports scoped child loggers per component and auto-incrementing sequence numbers.
 */

import {
  CallEvent,
  CreateEventParams,
  EventComponent,
  EventLevel,
  createEvent,
} from './event-schema';

// ─── Console formatting ─────────────────────────────────────────────────────

const LEVEL_COLORS: Record<EventLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function formatConsole(evt: CallEvent): string {
  const color = LEVEL_COLORS[evt.level];
  const time = evt.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const seq = String(evt.sequence).padStart(4, '0');
  const prefix = `${color}${evt.level.toUpperCase().padEnd(5)}${RESET}`;
  const comp = `${BOLD}[${evt.component}]${RESET}`;
  const latency = evt.latency_ms !== null ? ` (${evt.latency_ms}ms)` : '';
  const state = evt.state ? ` state=${evt.state}` : '';
  return `${time} ${seq} ${prefix} ${comp} ${evt.event}: ${evt.message}${latency}${state}`;
}

// ─── Log level filtering ────────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<EventLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Event listener type ────────────────────────────────────────────────────

export type EventListener = (event: CallEvent) => void;

// ─── Logger class ───────────────────────────────────────────────────────────

export class Logger {
  private callId: string;
  private sessionId: string;
  private component: EventComponent;
  private sequence: { value: number }; // shared reference for auto-increment
  private minLevel: EventLevel;
  private listeners: EventListener[];

  constructor(opts: {
    callId: string;
    sessionId: string;
    component: EventComponent;
    sequence?: { value: number };
    minLevel?: EventLevel;
    listeners?: EventListener[];
  }) {
    this.callId = opts.callId;
    this.sessionId = opts.sessionId;
    this.component = opts.component;
    this.sequence = opts.sequence ?? { value: 0 };
    this.minLevel = opts.minLevel ?? 'debug';
    this.listeners = opts.listeners ?? [];
  }

  /** Create a child logger for a different component, sharing the same sequence counter */
  child(component: EventComponent): Logger {
    return new Logger({
      callId: this.callId,
      sessionId: this.sessionId,
      component,
      sequence: this.sequence, // shared reference
      minLevel: this.minLevel,
      listeners: this.listeners,
    });
  }

  /** Register an event listener (used by artifact writer to capture events) */
  onEvent(listener: EventListener): void {
    this.listeners.push(listener);
  }

  /** Emit a structured event */
  emit(
    params: Omit<CreateEventParams, 'call_id' | 'session_id' | 'sequence' | 'component'>
  ): CallEvent {
    const seq = ++this.sequence.value;

    const event = createEvent({
      ...params,
      call_id: this.callId,
      session_id: this.sessionId,
      sequence: seq,
      component: this.component,
    });

    // Console output (filtered by level)
    if (LEVEL_PRIORITY[event.level] >= LEVEL_PRIORITY[this.minLevel]) {
      console.log(formatConsole(event));
    }

    // Notify all listeners (artifact writer, etc.)
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the logging pipeline
      }
    }

    return event;
  }

  // ─── Convenience methods ────────────────────────────────────────────────

  debug(event: string, message: string, data?: Record<string, unknown>): CallEvent {
    return this.emit({ event, level: 'debug', message, data });
  }

  info(event: string, message: string, data?: Record<string, unknown>): CallEvent {
    return this.emit({ event, level: 'info', message, data });
  }

  warn(event: string, message: string, data?: Record<string, unknown>): CallEvent {
    return this.emit({ event, level: 'warn', message, data });
  }

  error(event: string, message: string, data?: Record<string, unknown>): CallEvent {
    return this.emit({ event, level: 'error', message, data });
  }
}

// ─── Factory for creating a root logger for a new call ──────────────────────

export function createCallLogger(
  callId: string,
  sessionId: string,
  component: EventComponent = 'session',
  minLevel: EventLevel = 'debug'
): Logger {
  return new Logger({
    callId,
    sessionId,
    component,
    minLevel,
  });
}
