/**
 * Audio Bridge.
 *
 * Bidirectional audio pipeline:
 *   Twilio WebSocket (mulaw/8000) → Deepgram STT → transcripts
 *   Cartesia TTS → mulaw/8000 audio → Twilio WebSocket
 *
 * No transcoding — mulaw/8000 throughout.
 *
 * Required logs:
 *   - Audio chunk streaming events
 *   - Playback start/stop
 *   - Barge-in behavior
 *   - End-to-end latency
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';
import { DeepgramSTTClient, TranscriptEvent } from './deepgram-client';
import { CartesiaClient, CartesiaAudioChunk } from './cartesia-client';

export declare interface AudioBridge {
  on(event: 'transcript', listener: (data: TranscriptEvent) => void): this;
  on(event: 'speaking_started', listener: () => void): this;
  on(event: 'speaking_finished', listener: () => void): this;
}

export class AudioBridge extends EventEmitter {
  private logger: Logger;
  private deepgram: DeepgramSTTClient;
  private cartesia: CartesiaClient;
  private twilioSocket: WebSocket | null = null;
  private streamSid: string | null = null;

  private isSpeaking = false;
  private mediaPacketCount = 0;
  private speakStartTime: number | null = null;
  private audioBuffer: Buffer[] = [];
  private deepgramReady = false;

  constructor(parentLogger: Logger) {
    super();
    this.logger = parentLogger.child('audio_bridge');
    this.deepgram = new DeepgramSTTClient(parentLogger);
    this.cartesia = new CartesiaClient(parentLogger);

    // Wire Deepgram transcripts to our event emitter
    this.deepgram.on('transcript', (data) => {
      this.emit('transcript', data);
    });

    // When Deepgram signals ready, flush any buffered audio
    this.deepgram.on('ready', () => {
      this.deepgramReady = true;
      if (this.audioBuffer.length > 0) {
        this.logger.info('audio_bridge.flushing_buffer', `Flushing ${this.audioBuffer.length} buffered audio packets to Deepgram`);
        for (const buf of this.audioBuffer) {
          this.deepgram.sendAudio(buf);
        }
        this.audioBuffer = [];
      }
    });

    this.deepgram.on('error', (err) => {
      this.logger.error('audio_bridge.stt_error', `STT error: ${err.message}`, {
        error: err.message,
      });
    });

    // Wire Cartesia audio chunks to Twilio
    this.cartesia.on('audio', (chunk: CartesiaAudioChunk) => {
      if (chunk.isFinal) {
        this.isSpeaking = false;
        const duration = this.speakStartTime ? Date.now() - this.speakStartTime : 0;
        this.logger.info('audio_bridge.playback_finished', `Agent finished speaking (${duration}ms)`, {
          duration_ms: duration,
        });
        this.speakStartTime = null;
        this.emit('speaking_finished');
        return;
      }

      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speakStartTime = Date.now();
        this.logger.info('audio_bridge.playback_started', 'Agent started speaking');
        this.emit('speaking_started');
      }

      this.sendAudioToTwilio(chunk.audioData);
    });

    this.cartesia.on('error', (err) => {
      this.logger.error('audio_bridge.tts_error', `TTS error: ${err.message}`, {
        error: err.message,
      });
    });
  }

  /** Initialize connections to Deepgram and Cartesia */
  async connect(): Promise<void> {
    this.logger.info('audio_bridge.connecting', 'Initializing audio bridge');
    await Promise.all([
      this.deepgram.connect(),
      this.cartesia.connect(),
    ]);
    this.logger.info('audio_bridge.connected', 'Audio bridge ready (Deepgram + Cartesia)');
  }

  /** Attach a Twilio WebSocket for receiving/sending audio */
  attachTwilioSocket(socket: WebSocket, streamSid: string): void {
    this.twilioSocket = socket;
    this.streamSid = streamSid;
    this.logger.info('audio_bridge.twilio_attached', `Twilio socket attached, streamSid=${streamSid}`);
  }

  /** Process incoming audio from Twilio (forward to Deepgram) */
  processIncomingAudio(base64Audio: string): void {
    this.mediaPacketCount++;

    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');

      // Diagnostic: log first packet to confirm decode works
      if (this.mediaPacketCount === 1) {
        this.logger.info('audio_bridge.first_media', `First audio packet: ${audioBuffer.length} bytes from ${base64Audio.length} chars base64`, {
          buffer_size: audioBuffer.length,
          base64_length: base64Audio.length,
          first_hex: audioBuffer.slice(0, 16).toString('hex'),
        });
      }

      if (audioBuffer.length === 0) {
        return; // skip empty payloads
      }

      // Buffer audio if Deepgram isn't ready yet
      if (!this.deepgramReady) {
        this.audioBuffer.push(audioBuffer);
        return;
      }

      this.deepgram.sendAudio(audioBuffer);

      // Log periodically (every 500 packets ≈ every 10 seconds of audio)
      if (this.mediaPacketCount % 500 === 0) {
        this.logger.info('audio_bridge.media_stats', `Audio packets processed: ${this.mediaPacketCount}`, {
          total_packets: this.mediaPacketCount,
        });
      }
    } catch (err) {
      if (this.mediaPacketCount <= 3) {
        this.logger.error('audio_bridge.decode_error', `Failed to decode audio packet #${this.mediaPacketCount}: ${err instanceof Error ? err.message : 'Unknown'}`, {
          base64_preview: base64Audio.slice(0, 50),
        });
      }
    }
  }

  /** Speak text through Cartesia → Twilio */
  speak(text: string): void {
    const startTime = Date.now();
    this.logger.info('audio_bridge.speak_request', `Speaking: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`, {
      text_length: text.length,
    });
    this.cartesia.speak(text);
  }

  /** Send audio data back to Twilio */
  private sendAudioToTwilio(base64Audio: string): void {
    if (!this.twilioSocket || this.twilioSocket.readyState !== WebSocket.OPEN || !this.streamSid) {
      return;
    }

    const msg = JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: {
        payload: base64Audio,
      },
    });

    this.twilioSocket.send(msg);
  }

  /** Check if the agent is currently speaking */
  getIsSpeaking(): boolean {
    return this.isSpeaking;
  }

  /** Send a clear message to Twilio to stop current playback (for barge-in) */
  clearPlayback(): void {
    if (!this.twilioSocket || this.twilioSocket.readyState !== WebSocket.OPEN || !this.streamSid) {
      return;
    }

    this.logger.info('audio_bridge.barge_in', 'Clearing playback (barge-in detected)');

    const msg = JSON.stringify({
      event: 'clear',
      streamSid: this.streamSid,
    });

    this.twilioSocket.send(msg);
    this.isSpeaking = false;
  }

  /** Close all connections */
  async close(): Promise<void> {
    this.logger.info('audio_bridge.closing', 'Closing audio bridge');
    this.deepgram.close();
    this.cartesia.close();
  }
}
