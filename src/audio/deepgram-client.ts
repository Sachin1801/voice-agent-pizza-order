/**
 * Deepgram Streaming STT Client.
 *
 * Receives raw mulaw/8000 audio and emits transcript events.
 * No transcoding — Deepgram accepts mulaw natively.
 *
 * SDK v5 correct pattern (from Deepgram docs):
 *   const conn = await client.listen.v1.connect(opts);
 *   conn.on("open", () => {
 *     conn.on("message", (data) => { ... });  // "message" not "transcript"
 *   });
 *   conn.connect();
 *   await conn.waitForOpen();
 */

import { EventEmitter } from 'events';
import { DeepgramClient } from '@deepgram/sdk';
import { config } from '../config';
import { Logger } from '../logging/logger';

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence: number;
  timestamp: string;
  words: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export declare interface DeepgramSTTClient {
  on(event: 'transcript', listener: (data: TranscriptEvent) => void): this;
  on(event: 'speech_final', listener: (data: TranscriptEvent) => void): this;
  on(event: 'speech_started', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'ready', listener: () => void): this;
}

export class DeepgramSTTClient extends EventEmitter {
  private logger: Logger;
  private connection: any = null;
  private connectTime: number = 0;
  private _audioSendCount = 0;
  private _isOpen = false;

  constructor(parentLogger: Logger) {
    super();
    this.logger = parentLogger.child('deepgram');
  }

  /** Open a streaming connection to Deepgram */
  async connect(): Promise<void> {
    this.connectTime = Date.now();

    this.logger.emit({
      event: 'deepgram.connecting',
      level: 'info',
      message: 'Opening Deepgram streaming connection',
      direction: 'outbound',
      provider: 'deepgram',
    });

    const client = new DeepgramClient({ apiKey: config.deepgramApiKey });

    // Step 1: Create the connection object (does NOT open the socket yet)
    this.connection = await client.listen.v1.connect({
      model: 'nova-3',
      language: 'en',
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      punctuate: true,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      endpointing: 300,
    } as any);

    // Step 2: Register "open" handler — other listeners go INSIDE here per Deepgram docs
    this.connection.on('open', () => {
      this._isOpen = true;
      this.logger.emit({
        event: 'deepgram.connected',
        level: 'info',
        message: 'Deepgram streaming connection opened',
        direction: 'inbound',
        provider: 'deepgram',
        latency_ms: Date.now() - this.connectTime,
      });

      // Register message handler INSIDE open (per Deepgram docs)
      // The event is "message" NOT "transcript"
      this.connection.on('message', (data: any) => {
        if (data.type === 'Results') {
          this.handleTranscriptResult(data);
        } else if (data.type === 'SpeechStarted') {
          this.logger.debug('deepgram.speech_started', 'VAD: speech started');
          this.emit('speech_started');
        }
      });

      this.connection.on('error', (err: any) => {
        const message = err?.message ?? String(err);
        this.logger.emit({
          event: 'deepgram.error',
          level: 'error',
          message: `Deepgram error: ${message}`,
          direction: 'inbound',
          provider: 'deepgram',
          data: { error: message },
        });
        this.emit('error', err instanceof Error ? err : new Error(message));
      });

      this.connection.on('close', () => {
        this._isOpen = false;
        const duration = Date.now() - this.connectTime;
        this.logger.emit({
          event: 'deepgram.disconnected',
          level: 'info',
          message: `Deepgram connection closed after ${duration}ms`,
          direction: 'internal',
          provider: 'deepgram',
          latency_ms: duration,
        });
        this.emit('close');
      });

      // Signal that we're ready to receive audio
      this.emit('ready');
    });

    // Step 3: Actually open the WebSocket
    this.connection.connect();

    // Step 4: Wait until the socket is truly open before returning
    await this.connection.waitForOpen();

    this.logger.info('deepgram.ready', 'Deepgram STT ready — socket is open and accepting audio');
  }

  /** Handle a transcript result from Deepgram */
  private handleTranscriptResult(data: any): void {
    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    const text = alt.transcript.trim();
    if (!text) return;

    const isFinal = data.is_final === true;
    const confidence = alt.confidence ?? 0;

    const transcript: TranscriptEvent = {
      text,
      isFinal,
      confidence,
      timestamp: new Date().toISOString(),
      words: alt.words ?? [],
    };

    this.logger.emit({
      event: isFinal ? 'deepgram.transcript_final' : 'deepgram.transcript_partial',
      level: isFinal ? 'info' : 'debug',
      message: `${isFinal ? 'Final' : 'Partial'}: "${text}"`,
      direction: 'inbound',
      provider: 'deepgram',
      data: {
        text,
        is_final: isFinal,
        confidence,
        speech_final: data.speech_final,
        word_count: alt.words?.length ?? 0,
      },
    });

    this.emit('transcript', transcript);

    // Emit speech_final when Deepgram signals the speaker has finished their utterance
    // This is distinct from isFinal (end of a transcript segment) — speech_final means
    // the speaker actually stopped talking (based on silence/endpointing)
    if (data.speech_final === true && isFinal) {
      this.emit('speech_final', transcript);
    }
  }

  /** Send raw mulaw audio data to Deepgram */
  sendAudio(audioData: Buffer): void {
    if (!this.connection || !this._isOpen) return;

    try {
      this.connection.sendMedia(audioData);
      this._audioSendCount++;

      if (this._audioSendCount === 1) {
        this.logger.info('deepgram.first_audio_sent', `First audio packet sent to Deepgram (${audioData.length} bytes)`, {
          buffer_size: audioData.length,
          first_bytes: audioData.slice(0, 8).toString('hex'),
        });
      } else if (this._audioSendCount % 500 === 0) {
        this.logger.info('deepgram.audio_send_stats', `Audio packets sent: ${this._audioSendCount}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this._audioSendCount < 5) {
        this.logger.error('deepgram.send_media_failed', `Failed to send audio: ${message}`, {
          error: message,
          buffer_size: audioData.length,
          send_count: this._audioSendCount,
        });
      }
    }
  }

  /** Check if the connection is open */
  isOpen(): boolean {
    return this._isOpen;
  }

  /** Close the connection */
  close(): void {
    if (this.connection) {
      this.logger.debug('deepgram.closing', 'Closing Deepgram connection');
      this._isOpen = false;
      try {
        this.connection.close();
      } catch {
        // Connection may already be closed
      }
      this.connection = null;
    }
  }
}
