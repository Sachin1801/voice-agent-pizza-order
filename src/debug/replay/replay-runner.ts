/**
 * Replay Runner.
 *
 * Loads a past call's artifacts from data/runs/{call-id}/, extracts the
 * employee turns, and re-runs them through the CURRENT system prompt + rules.
 * This lets AI agents see how their prompt/rule changes would affect a
 * previously-problematic call.
 */

import fs from 'fs';
import path from 'path';
import { OrderRequest, OrderRequestSchema } from '../../types';
import { Logger, createCallLogger } from '../../logging/logger';
import { DebugConversationEngine } from '../session/debug-conversation-engine';
import { RulesManager } from '../rules/rules-manager';
import { DebugConfig } from '../config/debug-config';
import { ReplayData, ReplayTurnData, SendResponseData, toStateSnapshot } from '../types';

interface TranscriptEntry {
  timestamp: string;
  speaker: string;
  type: string;
  text: string;
  confidence: number | null;
}

interface ActionEntry {
  timestamp: string;
  sequence: number;
  proposal: unknown;
  validation: string;
  emitted_speech: string | null;
}

/**
 * Simple text similarity (Jaccard on words).
 * Returns 0.0 to 1.0.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return Math.round((intersection / union) * 100) / 100;
}

export async function runReplay(
  callId: string,
  config: DebugConfig,
  rulesManager: RulesManager,
  parentLogger: Logger
): Promise<ReplayData> {
  const runDir = path.join(path.resolve(config.artifactsDir), callId);

  if (!fs.existsSync(runDir)) {
    throw new Error(`Call artifacts not found: ${runDir}. Available calls can be listed from data/runs/.`);
  }

  parentLogger.info('debug.replay_started', `Replaying call ${callId}`, { call_id: callId });

  // 1. Load original order from request.json
  const requestPath = path.join(runDir, 'request.json');
  if (!fs.existsSync(requestPath)) {
    throw new Error(`request.json not found in ${runDir}`);
  }
  const requestData = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
  const orderResult = OrderRequestSchema.safeParse(requestData.order);
  if (!orderResult.success) {
    throw new Error(`Invalid order in request.json: ${orderResult.error.message}`);
  }
  const order = orderResult.data;

  // 2. Load transcript — extract human final turns (employee utterances)
  const transcriptPath = path.join(runDir, 'transcript.jsonl');
  const employeeTurns: string[] = [];
  if (fs.existsSync(transcriptPath)) {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.speaker === 'human' && entry.type === 'final' && entry.text.trim()) {
          employeeTurns.push(entry.text.trim());
        }
      } catch { /* skip malformed lines */ }
    }
  }

  if (employeeTurns.length === 0) {
    throw new Error(`No employee turns found in transcript.jsonl for call ${callId}`);
  }

  // 3. Load original actions for comparison
  const actionsPath = path.join(runDir, 'actions.jsonl');
  const originalActions: ActionEntry[] = [];
  if (fs.existsSync(actionsPath)) {
    const lines = fs.readFileSync(actionsPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        originalActions.push(JSON.parse(line) as ActionEntry);
      } catch { /* skip malformed lines */ }
    }
  }

  // 4. Create a fresh engine with current rules
  const replayLogger = createCallLogger(`replay-${callId}`, callId, 'session', config.logLevel);
  const engine = new DebugConversationEngine(
    order,
    rulesManager,
    replayLogger,
    {
      groqApiKey: config.groqApiKey,
      model: config.groqModel,
    }
  );

  // 5. Replay each employee turn
  const turns: ReplayTurnData[] = [];
  for (let i = 0; i < employeeTurns.length; i++) {
    const employeeText = employeeTurns[i];

    parentLogger.info('debug.replay_turn', `Replaying turn ${i + 1}/${employeeTurns.length}`, {
      turn: i + 1,
      employee_text: employeeText.slice(0, 100),
    });

    engine.addEmployeeSpeech(employeeText);
    const result = await engine.generateResponse();

    // Find the matching original action (by sequence or index)
    const originalAction = originalActions[i]?.proposal ?? null;
    const originalSpeech = originalActions[i]?.emitted_speech ?? '';

    // Compare
    const currentSpeech = result.pipeline.final_speech;
    const currentActionType = result.pipeline.action_type;
    const originalActionType = typeof originalAction === 'object' && originalAction !== null
      ? (originalAction as Record<string, unknown>).action as string ?? 'unknown'
      : 'unknown';

    turns.push({
      turn_number: i + 1,
      employee_text: employeeText,
      original_action: originalAction,
      current: {
        turn_number: result.turn_number,
        input: employeeText,
        pipeline: result.pipeline,
        state: result.state,
        history_length: result.history_length,
        session_uptime_ms: 0,
      },
      diff: {
        action_type_match: currentActionType === originalActionType,
        text_similarity: textSimilarity(currentSpeech, originalSpeech),
      },
    });
  }

  parentLogger.info('debug.replay_complete', `Replay finished: ${turns.length} turns`, {
    call_id: callId,
    total_turns: turns.length,
  });

  return {
    call_id: callId,
    order_summary: {
      customer_name: order.customer_name,
      pizza: `${order.pizza.size} ${order.pizza.crust}, ${order.pizza.toppings.join(', ')}`,
    },
    total_employee_turns: employeeTurns.length,
    turns,
  };
}
