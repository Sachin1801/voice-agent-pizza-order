/**
 * Cartesia WebSocket TTS Client.
 *
 * Sends text, receives audio chunks in mulaw/8000 format.
 * Streams back to Twilio without transcoding.
 *
 * Required logs:
 *   - TTS request timing (request sent → first chunk → last chunk)
 *   - Synthesis failures
 *   - Audio chunk streaming events
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../config';
import { Logger } from '../logging/logger';

export interface CartesiaAudioChunk {
  audioData: string; // base64-encoded audio
  isFinal: boolean;
}

export declare interface CartesiaClient {
  on(event: 'audio', listener: (chunk: CartesiaAudioChunk) => void): this;
  on(event: 'done', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export class CartesiaClient extends EventEmitter {
  private logger: Logger;
  private ws: WebSocket | null = null;
  private requestCount = 0;
  private activeContextId: string | null = null;

  constructor(parentLogger: Logger) {
    super();
    this.logger = parentLogger.child('cartesia');
  }

  /** Connect to Cartesia WebSocket */
  async connect(): Promise<void> {
    const startTime = Date.now();

    this.logger.emit({
      event: 'cartesia.connecting',
      level: 'info',
      message: 'Opening Cartesia WebSocket connection',
      direction: 'outbound',
      provider: 'cartesia',
    });

    return new Promise((resolve, reject) => {
      const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${config.cartesiaApiKey}&cartesia_version=2024-06-10`;

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.logger.emit({
          event: 'cartesia.connected',
          level: 'info',
          message: 'Cartesia WebSocket connected',
          direction: 'inbound',
          provider: 'cartesia',
          latency_ms: Date.now() - startTime,
        });
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          this.logger.error('cartesia.parse_error', 'Failed to parse Cartesia message', {
            error: err instanceof Error ? err.message : 'Unknown',
          });
        }
      });

      this.ws.on('error', (err) => {
        this.logger.emit({
          event: 'cartesia.error',
          level: 'error',
          message: `Cartesia WebSocket error: ${err.message}`,
          direction: 'inbound',
          provider: 'cartesia',
          data: { error: err.message },
        });
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('close', () => {
        this.logger.info('cartesia.disconnected', 'Cartesia WebSocket closed');
      });
    });
  }

  /** Synthesize text to speech */
  speak(text: string, contextId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.error('cartesia.not_connected', 'Cannot speak — Cartesia not connected');
      return;
    }

    this.requestCount++;
    const reqId = `tts-${this.requestCount}`;

    this.logger.emit({
      event: 'cartesia.tts_request',
      level: 'info',
      message: `TTS request: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
      direction: 'outbound',
      provider: 'cartesia',
      correlation_id: reqId,
      data: {
        text_length: text.length,
        context_id: contextId,
        model_id: config.cartesiaModelId,
        voice_id: config.cartesiaVoiceId,
      },
    });

    const request = {
      model_id: config.cartesiaModelId,
      transcript: text,
      voice: {
        mode: 'id',
        id: config.cartesiaVoiceId,
      },
      output_format: {
        container: 'raw',
        encoding: 'pcm_mulaw',
        sample_rate: 8000,
      },
      context_id: contextId ?? reqId,
      continue: false,
    };

    this.activeContextId = request.context_id;
    this.ws.send(JSON.stringify(request));
  }

  /** Handle incoming Cartesia WebSocket messages */
  private handleMessage(msg: any): void {
    if (msg.type === 'chunk') {
      const chunk: CartesiaAudioChunk = {
        audioData: msg.data,
        isFinal: false,
      };
      this.emit('audio', chunk);
    } else if (msg.type === 'done') {
      this.logger.debug('cartesia.tts_done', 'TTS synthesis complete', {
        context_id: msg.context_id,
      });
      const finalChunk: CartesiaAudioChunk = {
        audioData: '',
        isFinal: true,
      };
      this.emit('audio', finalChunk);
      this.emit('done');
    } else if (msg.type === 'error') {
      this.logger.emit({
        event: 'cartesia.tts_error',
        level: 'error',
        message: `Cartesia synthesis error: ${msg.error || 'Unknown'}`,
        direction: 'inbound',
        provider: 'cartesia',
        data: { error: msg.error, details: msg },
      });
      this.emit('error', new Error(msg.error || 'Cartesia synthesis error'));
    } else {
      this.logger.debug('cartesia.unknown_message', `Unknown Cartesia message type: ${msg.type}`, {
        type: msg.type,
      });
    }
  }

  /** Cancel in-progress TTS synthesis (for barge-in) */
  cancel(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.activeContextId) return;

    this.logger.info('cartesia.cancel', `Cancelling TTS context: ${this.activeContextId}`);
    this.ws.send(JSON.stringify({
      context_id: this.activeContextId,
      cancel: true,
    }));
    this.activeContextId = null;
  }

  /** Close the connection */
  close(): void {
    if (this.ws) {
      this.logger.debug('cartesia.closing', 'Closing Cartesia connection');
      this.ws.close();
      this.ws = null;
    }
  }
}
