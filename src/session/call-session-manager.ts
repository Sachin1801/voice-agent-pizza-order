/**
 * Call Session Manager.
 *
 * Owns one live call session keyed by call_id. One call at a time for v1.
 * Orchestrates the FULL pipeline:
 *   Twilio call → media stream → AudioBridge → IVR → Hold → Conversation → Hangup
 *
 * This is the wiring layer — it instantiates all components, routes audio
 * and transcripts between them, and manages phase transitions.
 */

import { v4 as uuid } from 'uuid';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import { config } from '../config';
import { OrderRequest, CallPhase, CallResult, CallOutcome } from '../types';
import { Logger, createCallLogger } from '../logging/logger';
import { ArtifactWriter, MetricsData } from '../logging/artifact-writer';
import { CallEvent } from '../logging/event-schema';
import { AudioBridge } from '../audio/audio-bridge';
import { TranscriptEvent } from '../audio/deepgram-client';
import { IVRStateMachine, IVRAction } from '../ivr/ivr-state-machine';
import { HoldDetector } from '../conversation/hold-detector';
import { ConversationEngine } from '../conversation/conversation-engine';
import { ResultAssembler } from './result-assembler';

export interface CallSession {
  callId: string;
  sessionId: string;
  order: OrderRequest;
  targetNumber: string;
  phase: CallPhase;
  twilioCallSid: string | null;
  mediaSocket: WebSocket | null;
  streamSid: string | null;
  result: CallResult | null;
  logger: Logger;
  artifacts: ArtifactWriter;
  startedAt: string;
  collectedEvents: CallEvent[];

  // Pipeline components (created when media stream connects)
  audioBridge: AudioBridge | null;
  ivrMachine: IVRStateMachine | null;
  holdDetector: HoldDetector | null;
  conversationEngine: ConversationEngine | null;
  resultAssembler: ResultAssembler | null;
}

export class CallSessionManager {
  private activeSession: CallSession | null = null;
  private twilioClient: twilio.Twilio;
  private serverLogger: Logger;
  private _parseErrorCount = 0;
  private _mediaMessageCount = 0;
  private _firstMessageLogged = false;

  // Debounce: accumulate final transcripts before calling Groq
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingTranscripts: string[] = [];
  private _isGenerating = false;
  private _debounceStartedAt: number | null = null;
  private _currentDebounceMs: number | null = null;
  private static readonly DEBOUNCE_MS = 2500;
  private static readonly SPEECH_FINAL_DEBOUNCE_MS = 1200;

  // Filler/acknowledgment words that are almost always followed by more speech
  private static readonly FILLER_PATTERN = /^(okay|ok|got it|cool|right|alright|sure|mm-?hmm|uh-?huh|yeah|yep|yup|great|perfect)\.?$/i;

  // Post-confirm auto-hangup
  private _confirmDoneTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly CONFIRM_DONE_TIMEOUT_MS = 10_000;

  constructor(serverLogger: Logger) {
    this.serverLogger = serverLogger;
    this.twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

    this.serverLogger.info('session.manager_initialized', 'Call session manager ready', {
      twilio_account: config.twilioAccountSid.slice(0, 6) + '****',
    });
  }

  /** Initiate a new outbound call. Returns the call_id. */
  async initiateCall(order: OrderRequest, targetNumber?: string): Promise<string> {
    // Clear completed/failed sessions
    if (this.activeSession && (this.activeSession.phase === 'completed' || this.activeSession.phase === 'failed')) {
      this.serverLogger.info('session.cleared', `Cleared previous session: ${this.activeSession.callId}`);
      this.activeSession = null;
    }

    if (this.activeSession) {
      throw new Error(
        `A call is already active: ${this.activeSession.callId} (phase: ${this.activeSession.phase})`
      );
    }

    const callId = uuid().slice(0, 8);
    const sessionId = uuid();
    const target = targetNumber ?? config.defaultTargetNumber;

    if (!target) {
      throw new Error('No target number provided and DEFAULT_TARGET_NUMBER not set');
    }

    const callLogger = createCallLogger(callId, sessionId, 'session', config.logLevel);
    const artifacts = new ArtifactWriter(callId, config.artifactsDir, config.enableAudioRecording, callLogger);
    const collectedEvents: CallEvent[] = [];

    callLogger.onEvent((event) => {
      artifacts.writeEvent(event);
      collectedEvents.push(event);
    });

    artifacts.writeRequest(order, {
      target_number: target,
      groq_model: config.groqModel,
      cartesia_model: config.cartesiaModelId,
      cartesia_voice: config.cartesiaVoiceId,
    });

    callLogger.info('session.initiating', `Initiating outbound call to ${target.slice(0, 4)}****`, {
      customer_name: order.customer_name,
      pizza_size: order.pizza.size,
      budget_max: order.budget_max,
    });

    try {
      const twilioCall = await this.twilioClient.calls.create({
        to: target,
        from: config.twilioPhoneNumber,
        url: `${config.publicBaseUrl}/api/twilio/voice`,
        statusCallback: `${config.publicBaseUrl}/api/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
      });

      callLogger.info('session.twilio_call_created', `Twilio call created: ${twilioCall.sid}`, {
        twilio_call_sid: twilioCall.sid,
        twilio_status: twilioCall.status,
      });

      this.activeSession = {
        callId,
        sessionId,
        order,
        targetNumber: target,
        phase: 'initializing',
        twilioCallSid: twilioCall.sid,
        mediaSocket: null,
        streamSid: null,
        result: null,
        logger: callLogger,
        artifacts,
        startedAt: new Date().toISOString(),
        collectedEvents,
        audioBridge: null,
        ivrMachine: null,
        holdDetector: null,
        conversationEngine: null,
        resultAssembler: null,
      };

      callLogger.info('session.ownership_acquired', 'Session is now active', { phase: 'initializing' });
      return callId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      callLogger.error('session.twilio_call_failed', `Failed to create Twilio call: ${message}`, {
        error: message,
      });
      throw err;
    }
  }

  /** Link a Twilio CallSid to the active session */
  linkTwilioCallSid(callSid: string): void {
    if (this.activeSession && !this.activeSession.twilioCallSid) {
      this.activeSession.twilioCallSid = callSid;
      this.activeSession.logger.info('session.twilio_sid_linked', `Linked Twilio SID: ${callSid}`);
    }
  }

  /** Handle incoming Twilio media stream WebSocket — this is where the pipeline starts */
  handleMediaStream(ws: WebSocket): void {
    const session = this.activeSession;
    if (!session) {
      this.serverLogger.warn('session.media_no_session', 'Media stream connected but no active session');
      ws.close();
      return;
    }

    session.mediaSocket = ws;

    // Check if this is a reconnect (e.g., after DTMF call update) or first connection
    const isReconnect = session.ivrMachine !== null;

    if (isReconnect) {
      session.logger.info('session.media_stream_reconnected', `Media stream reconnected (IVR state preserved: ${session.ivrMachine!.getState()})`, {
        ivr_state: session.ivrMachine!.getState(),
        phase: session.phase,
      });
      // Only reconnect audio — keep IVR state, conversation engine, etc.
      this.reconnectAudioBridge(session);
    } else {
      session.logger.info('session.media_stream_connected', 'Twilio media stream WebSocket attached (first connection)');
      this.initializePipeline(session);
    }

    // Handle incoming Twilio WebSocket messages
    // Twilio sends ALL messages as JSON text frames (never binary).
    // The ws library delivers them as Buffer objects regardless.
    this._parseErrorCount = 0;
    this._mediaMessageCount = 0;
    this._firstMessageLogged = false;

    ws.on('message', (data: Buffer | string) => {
      // Convert to string — Twilio always sends UTF-8 JSON text frames
      const messageStr = typeof data === 'string' ? data : data.toString('utf-8');

      // Step 1: Parse JSON
      let msg: any;
      try {
        msg = JSON.parse(messageStr);
      } catch (err) {
        this._parseErrorCount++;
        if (this._parseErrorCount <= 5 || this._parseErrorCount % 500 === 0) {
          session.logger.error('session.json_parse_error', `JSON parse error #${this._parseErrorCount}`, {
            error: err instanceof Error ? err.message : 'Unknown',
            data_length: messageStr.length,
            preview: messageStr.slice(0, 200),
          });
        }
        return;
      }

      // Diagnostic: log the first parsed message
      if (!this._firstMessageLogged) {
        this._firstMessageLogged = true;
        session.logger.info('session.first_message_parsed', `First Twilio message parsed: event=${msg.event}`, {
          event: msg.event,
          keys: Object.keys(msg),
        });
      }

      // Count media messages to prove flow
      if (msg.event === 'media') {
        this._mediaMessageCount++;
        if (this._mediaMessageCount === 1 || this._mediaMessageCount % 500 === 0) {
          session.logger.info('session.media_flow', `Media packets received: ${this._mediaMessageCount}`, {
            count: this._mediaMessageCount,
          });
        }
      }

      // Step 2: Handle the message (errors here are handler bugs, not parse errors)
      try {
        this.handleTwilioMessage(session, msg);
      } catch (err) {
        session.logger.error('session.handler_error', `Error handling ${msg.event} message`, {
          error: err instanceof Error ? err.message : 'Unknown',
          event: msg.event,
        });
      }
    });

    ws.on('close', (code, reason) => {
      session.logger.info('session.media_stream_closed', `Media stream closed: code=${code}`, {
        code, reason: reason.toString(),
      });
    });

    ws.on('error', (err) => {
      session.logger.error('session.media_stream_error', `Media stream error: ${err.message}`);
    });
  }

  /** Initialize all pipeline components */
  private async initializePipeline(session: CallSession): Promise<void> {
    session.logger.info('session.pipeline_initializing', 'Initializing audio pipeline components');

    // Create audio bridge (Deepgram STT + Cartesia TTS)
    session.audioBridge = new AudioBridge(session.logger);

    // Create IVR state machine
    session.ivrMachine = new IVRStateMachine(session.order, session.logger);

    // Create result assembler
    session.resultAssembler = new ResultAssembler(session.logger);

    // Wire transcript events from audio bridge to phase router
    session.audioBridge.on('transcript', (transcript: TranscriptEvent) => {
      this.routeTranscript(session, transcript);
    });

    // Wire speech_final as a timer-shortening signal, not an immediate flush
    session.audioBridge.onSpeechFinal(() => {
      this.handleSpeechFinal(session);
    });

    // Connect to Deepgram and Cartesia
    try {
      await session.audioBridge.connect();
      session.phase = 'ivr';
      session.logger.info('session.pipeline_ready', 'Audio pipeline ready — entering IVR phase', {
        phase: 'ivr',
      });
    } catch (err) {
      session.logger.error('session.pipeline_failed', `Failed to initialize audio pipeline: ${err instanceof Error ? err.message : 'Unknown'}`, {
        error: err instanceof Error ? err.message : 'Unknown',
      });
    }
  }

  /** Reconnect audio bridge after a stream restart (e.g., after DTMF call update).
   *  Preserves IVR state, conversation engine, hold detector — only reconnects audio. */
  private async reconnectAudioBridge(session: CallSession): Promise<void> {
    // Close the old audio bridge if it exists
    if (session.audioBridge) {
      await session.audioBridge.close();
    }

    // Create a fresh audio bridge
    session.audioBridge = new AudioBridge(session.logger);

    // Re-wire transcript events to the existing phase router
    session.audioBridge.on('transcript', (transcript: TranscriptEvent) => {
      this.routeTranscript(session, transcript);
    });

    // Re-wire speech_final as a timer-shortening signal
    session.audioBridge.onSpeechFinal(() => {
      this.handleSpeechFinal(session);
    });

    try {
      await session.audioBridge.connect();
      session.logger.info('session.audio_reconnected', `Audio bridge reconnected (phase=${session.phase}, IVR=${session.ivrMachine?.getState()})`, {
        phase: session.phase,
        ivr_state: session.ivrMachine?.getState(),
      });
    } catch (err) {
      session.logger.error('session.audio_reconnect_failed', `Failed to reconnect audio: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  /** Route a transcript to the appropriate handler based on current phase */
  private routeTranscript(session: CallSession, transcript: TranscriptEvent): void {
    // Write to transcript artifacts
    session.artifacts.writeTranscript({
      timestamp: transcript.timestamp,
      speaker: session.phase === 'conversation' ? 'human' : 'ivr',
      type: transcript.isFinal ? 'final' : 'partial',
      text: transcript.text,
      confidence: transcript.confidence,
      normalization_notes: null,
    });

    switch (session.phase) {
      case 'ivr':
        this.handleIVRTranscript(session, transcript);
        break;
      case 'hold':
        this.handleHoldTranscript(session, transcript);
        break;
      case 'conversation':
        this.handleConversationTranscript(session, transcript);
        break;
      default:
        // In other phases, transcripts are logged but not acted on
        break;
    }
  }

  /** Handle transcript during IVR phase */
  private handleIVRTranscript(session: CallSession, transcript: TranscriptEvent): void {
    if (!session.ivrMachine) return;

    const action = session.ivrMachine.processTranscript(transcript.text, transcript.isFinal);
    this.executeIVRAction(session, action);
  }

  /** Execute an IVR action */
  private async executeIVRAction(session: CallSession, action: IVRAction): Promise<void> {
    switch (action.type) {
      case 'send_dtmf':
        session.logger.info('session.ivr_action', `Executing: send DTMF "${action.digits}"`, {
          action: 'send_dtmf', digits: action.digits,
        });
        try {
          await this.sendDTMF(action.digits);
        } catch (err) {
          session.logger.error('session.ivr_dtmf_failed', `DTMF failed: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        break;

      case 'speak':
        session.logger.info('session.ivr_action', `Executing: speak "${action.text}"`, {
          action: 'speak', text: action.text,
        });
        session.audioBridge?.speak(action.text);
        break;

      case 'silence':
        session.logger.debug('session.ivr_action', 'Executing: silence');
        break;

      case 'transition_to_hold':
        session.logger.info('session.phase_transition', 'IVR complete → entering HOLD phase', {
          from: 'ivr', to: 'hold',
        });
        session.phase = 'hold';
        session.holdDetector = new HoldDetector(session.logger);
        break;

      case 'hangup':
        session.logger.warn('session.ivr_hangup', `IVR forced hangup: ${action.reason}`, {
          reason: action.reason,
        });
        await this.endCall(session, 'nothing_available', action.reason);
        break;

      case 'wait':
        // Do nothing — waiting for more transcript
        break;
    }
  }

  /** Handle transcript during HOLD phase */
  private handleHoldTranscript(session: CallSession, transcript: TranscriptEvent): void {
    if (!session.holdDetector) return;

    const result = session.holdDetector.processTranscript(transcript.text, transcript.isFinal);

    if (result.detected) {
      session.logger.info('session.phase_transition', 'Human detected → entering CONVERSATION phase', {
        from: 'hold', to: 'conversation',
        hold_duration_ms: session.holdDetector.getHoldDuration(),
        detection_transcript: result.transcript,
      });

      session.phase = 'conversation';
      // Enable barge-in now that we're in conversation with a human
      session.audioBridge?.setBargeinEnabled(true);
      session.conversationEngine = new ConversationEngine(
        session.order,
        session.logger,
        session.artifacts
      );

      // The human just greeted us — add their speech and generate our response
      session.conversationEngine.addEmployeeSpeech(result.transcript);
      this.generateAndSpeak(session);
    }

    // Check for hold timeout
    if (session.holdDetector.isTimedOut()) {
      session.logger.warn('session.hold_timeout', 'Hold timeout — hanging up');
      this.endCall(session, 'nothing_available', 'Hold timeout exceeded');
    }
  }

  /** Handle transcript during CONVERSATION phase (with debounce) */
  private handleConversationTranscript(session: CallSession, transcript: TranscriptEvent): void {
    // Cancel confirm-done timeout on ANY inbound speech during conversation —
    // the employee is still talking, so we shouldn't auto-hangup
    if (this._confirmDoneTimeout && transcript.text.trim().length > 0) {
      clearTimeout(this._confirmDoneTimeout);
      this._confirmDoneTimeout = null;
      session.logger.info('session.confirm_timeout_cancelled', 'Confirm-done timeout cancelled — employee still speaking');
    }

    if (!session.conversationEngine) return;

    // Partial transcripts: if a partial arrives while the debounce timer is running
    // and we have pending transcripts, reset the timer — the employee is still talking
    if (!transcript.isFinal) {
      if (this._debounceTimer && this._pendingTranscripts.length > 0) {
        clearTimeout(this._debounceTimer);
        this._currentDebounceMs = CallSessionManager.DEBOUNCE_MS;
        this._debounceTimer = setTimeout(() => {
          this.flushDebouncedTranscripts(session);
        }, CallSessionManager.DEBOUNCE_MS);

        session.logger.info('session.debounce_extended_by_partial', 'Debounce timer reset by partial transcript — employee still speaking', {
          partial_text: transcript.text,
          pending_count: this._pendingTranscripts.length,
          new_debounce_ms: CallSessionManager.DEBOUNCE_MS,
        });
      }
      return;
    }

    // Check for bot detection in transcript before other processing
    if (this.detectBotAccusation(transcript.text)) {
      session.logger.warn('session.bot_detected', 'Bot accusation detected in transcript — forcing immediate hangup', {
        text: transcript.text,
      });
      session.audioBridge?.speak("I'm sorry, I have to go. Goodbye.");
      setTimeout(() => {
        this.endCall(session, 'detected_as_bot', 'Bot accusation detected in transcript');
      }, 2000);
      return;
    }

    // Don't process transcripts while the agent is speaking
    if (session.audioBridge?.getIsSpeaking()) {
      session.logger.debug('session.transcript_while_speaking', 'Ignoring transcript while agent is speaking', {
        text: transcript.text,
      });
      return;
    }

    // Accumulate final transcripts and debounce — wait for the employee to finish
    this._pendingTranscripts.push(transcript.text);

    // Reset debounce timer
    const isFirstPending = this._pendingTranscripts.length === 1;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      session.logger.info('session.debounce_timer_reset', 'Debounce timer reset by new final transcript', {
        pending_count: this._pendingTranscripts.length,
        new_debounce_ms: CallSessionManager.DEBOUNCE_MS,
        elapsed_ms: this._debounceStartedAt ? Date.now() - this._debounceStartedAt : null,
      });
    }

    if (isFirstPending) {
      this._debounceStartedAt = Date.now();
    }
    this._currentDebounceMs = CallSessionManager.DEBOUNCE_MS;

    this._debounceTimer = setTimeout(() => {
      this.flushDebouncedTranscripts(session);
    }, CallSessionManager.DEBOUNCE_MS);

    session.logger.info('session.debounce_timer_started', 'Debounce timer started', {
      debounce_ms: CallSessionManager.DEBOUNCE_MS,
      pending_count: this._pendingTranscripts.length,
      trigger: 'new_final_transcript',
      text: transcript.text,
    });
  }

  /** Handle speech_final as a confidence hint — shorten debounce instead of immediate flush */
  private handleSpeechFinal(session: CallSession): void {
    if (session.phase !== 'conversation') return;
    if (this._pendingTranscripts.length === 0) return;

    // Check if accumulated text is just a filler word — if so, keep the full debounce
    const combinedText = this._pendingTranscripts.join(' ').trim();
    const isFiller = CallSessionManager.FILLER_PATTERN.test(combinedText);

    if (isFiller) {
      session.logger.info('session.debounce_filler_detected', 'Filler word detected — keeping full debounce timer', {
        text: combinedText,
        debounce_ms: CallSessionManager.DEBOUNCE_MS,
      });
      return; // Don't shorten — filler words are almost always followed by more speech
    }

    // Clear existing debounce and start a shorter one
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }

    this._currentDebounceMs = CallSessionManager.SPEECH_FINAL_DEBOUNCE_MS;
    this._debounceTimer = setTimeout(() => {
      this.flushDebouncedTranscripts(session);
    }, CallSessionManager.SPEECH_FINAL_DEBOUNCE_MS);

    session.logger.info('session.debounce_timer_shortened', 'Debounce timer shortened by speech_final', {
      new_debounce_ms: CallSessionManager.SPEECH_FINAL_DEBOUNCE_MS,
      text: combinedText,
      is_filler: false,
    });
  }

  // Bot accusation patterns — similar approach to hold-detector.ts
  // IMPORTANT: These must be specific enough to avoid false positives on normal
  // questions like "What are you trying to order?" (see call 102fbe96)
  private static readonly BOT_ACCUSATION_PATTERNS = [
    /are\s+you\s+a\s+(robot|bot|computer|machine|ai)\b/i,
    /is\s+this\s+a\s+(robot|bot|computer|machine|ai)\b/i,
    /talking\s+to\s+a\s+(robot|bot|computer|machine)\b/i,
    /you('re|\s+are)\s+(a\s+)?(robot|bot|computer|ai)\b/i,
    /sounds?\s+like\s+a\s+(robot|bot|computer)\b/i,
    /can('t|not)\s+understand\s+(you\b|what\s+you('re|\s+are)\s+saying)/i,
    /not\s+a\s+real\s+person/i,
  ];

  /** Detect if the employee is accusing the agent of being a bot */
  private detectBotAccusation(text: string): boolean {
    return CallSessionManager.BOT_ACCUSATION_PATTERNS.some((p) => p.test(text));
  }

  /** Resolve a descriptive name for the side when LLM only sends category "side" */
  private resolveSideDescription(session: CallSession): string {
    // Check if a backup option was being discussed
    const state = session.conversationEngine!.getOrderState();
    const backups = session.order.side.backup_options;
    if (state.sideAttemptIndex > 0 && state.sideAttemptIndex <= backups.length) {
      return backups[state.sideAttemptIndex - 1];
    }
    // Fall back to first choice or first backup
    if (state.sideAttemptIndex === 0) return session.order.side.first_choice;
    return backups[0] ?? session.order.side.first_choice;
  }

  /** Resolve a descriptive name for the drink when LLM only sends category "drink" */
  private resolveDrinkDescription(session: CallSession): string {
    return session.order.drink.first_choice;
  }

  /** Flush accumulated transcripts and trigger Groq (called by debounce timer or speech_final) */
  private flushDebouncedTranscripts(session: CallSession): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._pendingTranscripts.length === 0 || !session.conversationEngine || session.phase !== 'conversation') return;

    // Don't fire while another Groq request is in-flight
    if (this._isGenerating) {
      session.logger.debug('session.debounce_skipped', 'Groq request already in-flight, skipping');
      return;
    }

    const combinedText = this._pendingTranscripts.join(' ').trim();
    const totalWaitMs = this._debounceStartedAt ? Date.now() - this._debounceStartedAt : null;
    this._pendingTranscripts = [];
    this._debounceStartedAt = null;

    // Drop standalone fillers — they are not meaningful turns.
    // "Okay.", "Got it.", "Sure." alone should NOT trigger a Groq response.
    const isFiller = CallSessionManager.FILLER_PATTERN.test(combinedText);
    if (isFiller) {
      session.logger.info('session.debounce_filler_dropped', `Dropping standalone filler: "${combinedText}" — not sending to Groq`, {
        text: combinedText,
        total_wait_ms: totalWaitMs,
      });
      this._currentDebounceMs = null;
      return;
    }

    session.logger.info('session.debounce_flushed', `Flushed ${combinedText.split(' ').length} words to Groq`, {
      text: combinedText,
      debounce_type: this._currentDebounceMs === CallSessionManager.SPEECH_FINAL_DEBOUNCE_MS ? 'shortened' : 'full',
      total_wait_ms: totalWaitMs,
      debounce_ms: this._currentDebounceMs,
    });
    this._currentDebounceMs = null;

    session.conversationEngine.addEmployeeSpeech(combinedText);
    this.generateAndSpeak(session);
  }

  /** Generate LLM response and speak it */
  private async generateAndSpeak(session: CallSession): Promise<void> {
    if (!session.conversationEngine || !session.audioBridge) return;

    // In-flight guard: prevent concurrent Groq requests
    if (this._isGenerating) {
      session.logger.debug('session.generate_skipped', 'Already generating — skipping');
      return;
    }

    this._isGenerating = true;
    try {
      const response = await session.conversationEngine.generateResponse();
      if (!response) {
        session.logger.warn('session.no_response', 'Conversation engine returned no response');
        return;
      }

      const { action } = response;

      // Extract structured data from the LLM action (prices, totals, etc.)
      if (action.action === 'say') {
        if (action.heard_price) {
          const { item, price } = action.heard_price;
          const itemLower = item.toLowerCase();
          if (itemLower === 'pizza' || itemLower.includes('pizza')) {
            session.conversationEngine.updatePizzaPrice(price);
          } else if (itemLower === 'side' || itemLower.includes('bread') || itemLower.includes('wing') || itemLower.includes('stick') || itemLower.includes('side')) {
            // Use a descriptive name, not just the category "side".
            // Try to resolve from the employee's recent speech or fall back to the order's side options.
            const sideDescription = itemLower === 'side'
              ? this.resolveSideDescription(session)
              : item;
            session.conversationEngine.updateSide(sideDescription, price);
          } else if (itemLower === 'drink' || itemLower.includes('coke') || itemLower.includes('pepsi') || itemLower.includes('sprite') || itemLower.includes('drink')) {
            // Use a descriptive name, not just the category "drink".
            const drinkDescription = itemLower === 'drink'
              ? this.resolveDrinkDescription(session)
              : item;
            session.conversationEngine.updateDrink(drinkDescription, price);
          }
        }
        if (action.heard_total != null) {
          session.conversationEngine.updateHeardTotal(action.heard_total);
        }
        if (action.heard_delivery_time) {
          session.conversationEngine.updateDeliveryTime(action.heard_delivery_time);
        }
        if (action.heard_order_number) {
          session.conversationEngine.updateOrderNumber(action.heard_order_number);
        }
        if (action.delivering_special_instructions) {
          session.conversationEngine.markSpecialInstructionsDelivered();
        }
      }

      // Proactive over-budget check: after extracting prices, check if pizza+side already exceed budget
      const currentState = session.conversationEngine.getOrderState();
      if (
        currentState.pizzaConfirmed &&
        (currentState.sideConfirmed || currentState.sideSkipped) &&
        !currentState.drinkConfirmed &&
        !currentState.drinkSkipped &&
        currentState.runningTotal > session.order.budget_max
      ) {
        session.logger.warn('session.over_budget_detected', `Running total $${currentState.runningTotal} exceeds budget $${session.order.budget_max} — forcing over_budget hangup`, {
          running_total: currentState.runningTotal,
          budget_max: session.order.budget_max,
        });
        session.audioBridge!.speak("I'm sorry, that's actually going to be over my budget. I'll have to cancel the order. Thank you for your help.");
        setTimeout(() => {
          this.endCall(session, 'over_budget', `Running total $${currentState.runningTotal} exceeds budget $${session.order.budget_max}`);
        }, 3000);
        return;
      }

      // Check if this is a hangup action — cancel confirm timeout if we're hanging up properly
      if (action.action === 'hangup_with_outcome') {
        if (this._confirmDoneTimeout) {
          clearTimeout(this._confirmDoneTimeout);
          this._confirmDoneTimeout = null;
        }
        session.audioBridge.speak(response.textToSpeak);
        setTimeout(() => {
          this.endCall(session, action.outcome, action.reason);
        }, 3000);
        return;
      }

      // Post-confirm auto-hangup: if agent just confirmed the order is done,
      // start a timeout to auto-hangup if no hangup_with_outcome follows
      if (action.action === 'confirm_done') {
        session.audioBridge.speak(response.textToSpeak);
        this._confirmDoneTimeout = setTimeout(() => {
          session.logger.info('session.confirm_done_timeout', 'Auto-hangup after confirm_done — no hangup_with_outcome received');
          this.endCall(session, 'completed', 'Auto-hangup after confirm_done timeout');
        }, CallSessionManager.CONFIRM_DONE_TIMEOUT_MS);
        return;
      }

      // Speak the response
      session.audioBridge.speak(response.textToSpeak);

    } catch (err) {
      session.logger.error('session.generate_failed', `Failed to generate response: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      this._isGenerating = false;
    }
  }

  /** End the call with an outcome */
  private async endCall(session: CallSession, outcome: CallOutcome, reason: string): Promise<void> {
    session.logger.info('session.ending_call', `Ending call: outcome=${outcome}, reason=${reason}`, {
      outcome, reason,
    });

    // Build result
    const orderState = session.conversationEngine?.getOrderState();
    const assembler = session.resultAssembler ?? new ResultAssembler(session.logger);

    if (orderState) {
      session.result = assembler.buildResult(outcome, session.order, orderState);
    } else {
      // No conversation happened — minimal result
      session.result = {
        outcome,
        pizza: null,
        side: null,
        drink: null,
        drink_skip_reason: null,
        total: null,
        delivery_time: null,
        order_number: null,
        special_instructions_delivered: false,
      };
    }

    // Write closing artifacts
    const metrics: MetricsData = {
      call_duration_ms: Date.now() - new Date(session.startedAt).getTime(),
      providers: {
        twilio: { requests: 1, errors: 0 },
        deepgram: { connected_ms: null, transcripts: 0, errors: 0 },
        groq: { requests: 0, total_tokens: 0, avg_latency_ms: null, errors: 0 },
        cartesia: { requests: 0, total_audio_ms: null, avg_latency_ms: null, errors: 0 },
      },
    };

    await assembler.writeClosingArtifacts(
      session.artifacts,
      session.result,
      session.collectedEvents,
      session.callId,
      session.startedAt,
      metrics
    );

    // Close audio bridge
    await session.audioBridge?.close();

    // Hang up Twilio call
    await this.hangup(reason);

    session.phase = 'completed';
    session.logger.info('session.call_complete', `Call complete: ${outcome}`, { outcome });
  }

  /** Process a Twilio WebSocket message */
  private handleTwilioMessage(
    session: CallSession,
    msg: { event: string; streamSid?: string; media?: { payload: string }; start?: any; mark?: any; [key: string]: unknown }
  ): void {
    switch (msg.event) {
      case 'connected':
        session.logger.info('twilio.stream_connected', 'Twilio stream connected', {
          stream_sid: msg.streamSid,
        });
        break;

      case 'start':
        session.streamSid = msg.streamSid ?? null;
        session.logger.info('twilio.stream_started', `Twilio stream started: ${msg.streamSid}`, {
          stream_sid: msg.streamSid,
        });
        // Attach the Twilio socket to the audio bridge now that we have the streamSid
        if (session.audioBridge && session.mediaSocket && session.streamSid) {
          session.audioBridge.attachTwilioSocket(session.mediaSocket, session.streamSid);
        }
        break;

      case 'media':
        // Only forward INBOUND audio (caller's voice) to STT
        // Skip outbound (our own TTS) to prevent self-hearing loops
        if (msg.media?.payload && session.audioBridge && (msg.media as any).track !== 'outbound') {
          session.audioBridge.processIncomingAudio(msg.media.payload);
        }
        break;

      case 'stop':
        session.logger.info('twilio.stream_stopped', 'Twilio stream stopped');
        break;

      case 'mark':
        session.logger.debug('twilio.mark_received', `Mark: ${msg.mark}`);
        break;

      default:
        session.logger.debug('twilio.unknown_event', `Unknown event: ${msg.event}`);
    }
  }

  /** Handle Twilio status callback */
  handleTwilioStatus(callSid: string, status: string): void {
    const session = this.activeSession;
    if (!session || session.twilioCallSid !== callSid) return;

    session.logger.info('session.twilio_status', `Twilio call status: ${status}`, {
      twilio_call_sid: callSid, twilio_status: status,
    });

    if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
      // Cancel any pending confirm timeout
      if (this._confirmDoneTimeout) {
        clearTimeout(this._confirmDoneTimeout);
        this._confirmDoneTimeout = null;
      }

      // Route ALL terminal states through endCall() so artifacts are always written
      if (session.phase !== 'completed') {
        // Infer outcome from order state instead of defaulting to nothing_available
        let inferredOutcome: CallOutcome = 'nothing_available';
        if (status === 'completed' && session.conversationEngine) {
          const state = session.conversationEngine.getOrderState();
          if (state.pizzaConfirmed && state.specialInstructionsDelivered) {
            inferredOutcome = 'completed';
            session.logger.info('session.outcome_inferred', 'Inferred completed outcome from order state (pizza confirmed + instructions delivered)');
          }
        }
        this.endCall(session, inferredOutcome, `Twilio status: ${status}`);
      }
    }
  }

  /** Get a session by call_id */
  getSession(callId: string): CallSession | null {
    if (this.activeSession?.callId === callId) return this.activeSession;
    return null;
  }

  /** Send DTMF digits via Twilio REST API */
  async sendDTMF(digits: string): Promise<void> {
    const session = this.activeSession;
    if (!session?.twilioCallSid) throw new Error('No active session with Twilio call SID');

    const startTime = Date.now();
    session.logger.emit({
      event: 'twilio.dtmf_sending', level: 'info',
      message: `Sending DTMF digits: ${digits}`,
      direction: 'outbound', provider: 'twilio',
      data: { digits },
    });

    try {
      await this.twilioClient.calls(session.twilioCallSid).update({
        twiml: `<Response><Play digits="${digits}"/><Connect><Stream url="${config.publicWsBaseUrl}/api/twilio/media-stream"><Parameter name="callSid" value="${session.twilioCallSid}" /></Stream></Connect></Response>`,
      });

      session.logger.emit({
        event: 'twilio.dtmf_sent', level: 'info',
        message: `DTMF digits sent: ${digits}`,
        direction: 'outbound', provider: 'twilio',
        latency_ms: Date.now() - startTime,
        data: { digits },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown';
      session.logger.emit({
        event: 'twilio.dtmf_failed', level: 'error',
        message: `Failed to send DTMF: ${message}`,
        direction: 'outbound', provider: 'twilio',
        latency_ms: Date.now() - startTime,
        data: { digits, error: message },
      });
      throw err;
    }
  }

  /** Hang up the active call */
  async hangup(reason: string): Promise<void> {
    const session = this.activeSession;
    if (!session?.twilioCallSid) return;

    session.logger.info('session.hangup', `Hanging up: ${reason}`, { reason });

    try {
      await this.twilioClient.calls(session.twilioCallSid).update({ status: 'completed' });
      session.logger.info('session.hangup_complete', 'Call terminated via Twilio');
    } catch (err) {
      session.logger.error('session.hangup_failed', `Hangup failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    }

    session.phase = 'completed';
  }
}
