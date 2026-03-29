/**
 * Per-call artifact writer.
 *
 * Creates data/runs/{call_id}/ and manages 7 default artifact files:
 *   - request.json    — normalized incoming request + resolved config
 *   - events.jsonl    — append-only canonical event stream
 *   - transcript.jsonl — timestamped speaker turns, partials, finals, confidence
 *   - actions.jsonl   — LLM action proposals, validation results, rule decisions
 *   - summary.md      — human-readable narrative (written at call end)
 *   - result.json     — final structured outcome (written at call end)
 *   - metrics.json    — per-provider latency, token usage, audio duration (written at call end)
 *   - Optional audio/  directory when ENABLE_AUDIO_RECORDING=true
 */

import fs from 'fs';
import path from 'path';
import { CallEvent } from './event-schema';
import { CallResult, OrderRequest } from '../types';
import { Logger } from './logger';

export interface TranscriptEntry {
  timestamp: string;
  speaker: 'agent' | 'human' | 'ivr' | 'system';
  type: 'partial' | 'final';
  text: string;
  confidence: number | null;
  normalization_notes: string | null;
}

export interface ActionEntry {
  timestamp: string;
  sequence: number;
  proposal: unknown;
  validation: 'valid' | 'invalid';
  validation_error: string | null;
  rule_decision: 'allowed' | 'rejected' | 'modified' | null;
  rule_reason: string | null;
  emitted_speech: string | null;
}

export interface MetricsData {
  call_duration_ms: number | null;
  providers: {
    twilio: { requests: number; errors: number };
    deepgram: { connected_ms: number | null; transcripts: number; errors: number };
    groq: {
      requests: number;
      total_tokens: number;
      avg_latency_ms: number | null;
      errors: number;
    };
    cartesia: {
      requests: number;
      total_audio_ms: number | null;
      avg_latency_ms: number | null;
      errors: number;
    };
  };
}

export class ArtifactWriter {
  private runDir: string;
  private eventsStream: fs.WriteStream;
  private transcriptStream: fs.WriteStream;
  private actionsStream: fs.WriteStream;
  private audioDir: string | null = null;
  private closed = false;
  private logger: Logger;

  constructor(
    private callId: string,
    private artifactsBaseDir: string,
    private enableAudioRecording: boolean,
    logger: Logger
  ) {
    this.logger = logger.child('artifact');
    this.runDir = path.join(artifactsBaseDir, callId);

    // Create directories
    fs.mkdirSync(this.runDir, { recursive: true });
    if (enableAudioRecording) {
      this.audioDir = path.join(this.runDir, 'audio');
      fs.mkdirSync(this.audioDir, { recursive: true });
    }

    // Open append streams for JSONL files
    this.eventsStream = fs.createWriteStream(
      path.join(this.runDir, 'events.jsonl'),
      { flags: 'a' }
    );
    this.transcriptStream = fs.createWriteStream(
      path.join(this.runDir, 'transcript.jsonl'),
      { flags: 'a' }
    );
    this.actionsStream = fs.createWriteStream(
      path.join(this.runDir, 'actions.jsonl'),
      { flags: 'a' }
    );

    this.logger.info('artifact.directory_created', `Artifact directory created: ${this.runDir}`, {
      run_dir: this.runDir,
      audio_enabled: enableAudioRecording,
    });
  }

  /** Get the event listener to attach to a Logger instance */
  getEventListener(): (event: CallEvent) => void {
    return (event: CallEvent) => {
      this.writeEvent(event);
    };
  }

  /** Append an event to events.jsonl */
  writeEvent(event: CallEvent): void {
    if (this.closed) return;
    this.eventsStream.write(JSON.stringify(event) + '\n');
  }

  /** Write the initial request payload */
  writeRequest(order: OrderRequest, resolvedConfig: Record<string, unknown>): void {
    const payload = {
      timestamp: new Date().toISOString(),
      call_id: this.callId,
      order,
      resolved_config: resolvedConfig,
    };
    fs.writeFileSync(
      path.join(this.runDir, 'request.json'),
      JSON.stringify(payload, null, 2)
    );
    this.logger.debug('artifact.request_written', 'Request payload saved');
  }

  /** Append a transcript entry */
  writeTranscript(entry: TranscriptEntry): void {
    this.transcriptStream.write(JSON.stringify(entry) + '\n');
  }

  /** Append an action entry */
  writeAction(entry: ActionEntry): void {
    this.actionsStream.write(JSON.stringify(entry) + '\n');
  }

  /** Write the final result (at call end) */
  writeResult(result: CallResult): void {
    fs.writeFileSync(
      path.join(this.runDir, 'result.json'),
      JSON.stringify(result, null, 2)
    );
    this.logger.info('artifact.result_written', `Call result saved: outcome=${result.outcome}`);
  }

  /** Write metrics (at call end) */
  writeMetrics(metrics: MetricsData): void {
    fs.writeFileSync(
      path.join(this.runDir, 'metrics.json'),
      JSON.stringify(metrics, null, 2)
    );
    this.logger.debug('artifact.metrics_written', 'Metrics saved');
  }

  /** Write the human-readable summary (at call end) */
  writeSummary(markdown: string): void {
    fs.writeFileSync(path.join(this.runDir, 'summary.md'), markdown);
    this.logger.info('artifact.summary_written', 'Call summary saved');
  }

  /** Get the audio directory path (null if recording disabled) */
  getAudioDir(): string | null {
    return this.audioDir;
  }

  /** Get the run directory path */
  getRunDir(): string {
    return this.runDir;
  }

  /** Flush and close all streams */
  async close(): Promise<void> {
    // Log before closing so the event can still be written
    this.logger.info('artifact.streams_closing', 'Closing all artifact streams');
    this.closed = true;

    return new Promise((resolve) => {
      let closed = 0;
      const total = 3;
      const onClose = () => {
        closed++;
        if (closed === total) resolve();
      };

      this.eventsStream.end(onClose);
      this.transcriptStream.end(onClose);
      this.actionsStream.end(onClose);
    });
  }
}
