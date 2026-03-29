/**
 * Generates a human-readable summary.md for a completed call.
 *
 * Points to suspicious spans and quotes relevant event IDs/sequence numbers.
 * Designed so a human or coding agent can quickly understand what happened
 * without reading source code.
 */

import { CallEvent } from './event-schema';
import { CallResult } from '../types';

export interface SummaryInput {
  callId: string;
  startTime: string;
  endTime: string;
  events: CallEvent[];
  result: CallResult | null;
}

export function generateSummary(input: SummaryInput): string {
  const { callId, startTime, endTime, events, result } = input;

  const lines: string[] = [];

  // Header
  lines.push(`# Call Summary: ${callId}`);
  lines.push('');
  lines.push(`**Start:** ${startTime}`);
  lines.push(`**End:** ${endTime}`);

  const durationMs =
    new Date(endTime).getTime() - new Date(startTime).getTime();
  lines.push(`**Duration:** ${(durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  // Outcome
  if (result) {
    lines.push(`## Outcome: \`${result.outcome}\``);
    lines.push('');
    if (result.pizza) {
      lines.push(`- **Pizza:** ${result.pizza.description} — $${result.pizza.price}`);
      if (Object.keys(result.pizza.substitutions).length > 0) {
        lines.push(
          `  - Substitutions: ${Object.entries(result.pizza.substitutions)
            .map(([from, to]) => `${from} → ${to}`)
            .join(', ')}`
        );
      }
    }
    if (result.side) {
      lines.push(`- **Side:** ${result.side.description} — $${result.side.price}`);
      if (result.side.original !== result.side.description) {
        lines.push(`  - Original: ${result.side.original}`);
      }
    }
    if (result.drink) {
      lines.push(`- **Drink:** ${result.drink.description} — $${result.drink.price}`);
    } else {
      lines.push('- **Drink:** skipped');
    }
    if (result.total !== null) {
      lines.push(`- **Total:** $${result.total}`);
    }
    if (result.delivery_time) {
      lines.push(`- **Delivery:** ${result.delivery_time}`);
    }
    if (result.order_number) {
      lines.push(`- **Order #:** ${result.order_number}`);
    }
    lines.push(
      `- **Special instructions delivered:** ${result.special_instructions_delivered}`
    );
    lines.push('');
  } else {
    lines.push('## Outcome: No result (call may have failed)');
    lines.push('');
  }

  // Timeline of key events
  lines.push('## Timeline');
  lines.push('');
  lines.push('| Seq | Time | Component | Event | Message |');
  lines.push('|-----|------|-----------|-------|---------|');

  const keyEvents = events.filter(
    (e) =>
      e.level !== 'debug' ||
      e.event.includes('state_transition') ||
      e.event.includes('error') ||
      e.event.includes('pickup') ||
      e.event.includes('hangup')
  );

  for (const evt of keyEvents.slice(0, 50)) {
    const time = evt.timestamp.slice(11, 23);
    const msg = evt.message.replace(/\|/g, '\\|').slice(0, 80);
    lines.push(
      `| ${evt.sequence} | ${time} | ${evt.component} | ${evt.event} | ${msg} |`
    );
  }
  lines.push('');

  // Warnings and errors
  const warnings = events.filter(
    (e) => e.level === 'warn' || e.level === 'error'
  );
  if (warnings.length > 0) {
    lines.push('## Warnings & Errors');
    lines.push('');
    for (const w of warnings) {
      lines.push(
        `- **[seq ${w.sequence}] ${w.level.toUpperCase()}** (${w.component}.${w.event}): ${w.message}`
      );
    }
    lines.push('');
  }

  // Provider latency highlights
  const latencyEvents = events.filter((e) => e.latency_ms !== null && e.latency_ms > 0);
  if (latencyEvents.length > 0) {
    lines.push('## Latency Highlights');
    lines.push('');
    const sorted = [...latencyEvents].sort(
      (a, b) => (b.latency_ms ?? 0) - (a.latency_ms ?? 0)
    );
    for (const evt of sorted.slice(0, 10)) {
      lines.push(
        `- [seq ${evt.sequence}] ${evt.component}.${evt.event}: ${evt.latency_ms}ms`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated at ${new Date().toISOString()}*`);

  return lines.join('\n');
}
