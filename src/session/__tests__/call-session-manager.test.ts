import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config before any imports
vi.mock('../../config', () => ({
  config: {
    twilioAccountSid: 'AC_test_sid_123456',
    twilioAuthToken: 'test_auth_token',
    twilioPhoneNumber: '+15551234567',
    publicBaseUrl: 'https://test.example.com',
    publicWsBaseUrl: 'wss://test.example.com',
    defaultTargetNumber: '+15559876543',
    groqApiKey: 'test-groq-key',
    groqModel: 'llama-3.3-70b-versatile',
    cartesiaApiKey: 'test-cartesia-key',
    cartesiaModelId: 'test-model',
    cartesiaVoiceId: 'test-voice',
    deepgramApiKey: 'test-deepgram-key',
    logLevel: 'error',
    artifactsDir: '/tmp/test-artifacts',
    enableAudioRecording: false,
  },
}));

// Mock twilio — returns a fake client
vi.mock('twilio', () => {
  const mockUpdate = vi.fn().mockResolvedValue({});
  const mockCallsCreate = vi.fn().mockResolvedValue({
    sid: 'CA_test_call_sid',
    status: 'queued',
  });
  const mockCallInstance = vi.fn(() => ({ update: mockUpdate }));
  (mockCallInstance as any).create = mockCallsCreate;

  return {
    default: vi.fn(() => ({
      calls: mockCallInstance,
    })),
  };
});

import { CallSessionManager, CallSession } from '../call-session-manager';
import { OrderRequest, CallPhase } from '../../types';
import { createCallLogger } from '../../logging/logger';
import { ArtifactWriter } from '../../logging/artifact-writer';
import { ConversationEngine } from '../../conversation/conversation-engine';
import { createInitialOrderState, OrderState } from '../../conversation/rule-engine';

const TEST_ORDER: OrderRequest = {
  customer_name: 'Jordan Mitchell',
  phone_number: '5125550147',
  delivery_address: '4821 Elm Street, Apt 3B, Austin, TX 78745',
  pizza: {
    size: 'large',
    crust: 'thin',
    toppings: ['pepperoni', 'mushroom', 'green pepper'],
    acceptable_topping_subs: ['sausage', 'bacon', 'onion'],
    no_go_toppings: ['olives', 'anchovies', 'pineapple'],
  },
  side: {
    first_choice: 'buffalo wings, 12 count',
    backup_options: ['garlic bread', 'breadsticks'],
    if_all_unavailable: 'skip',
  },
  drink: {
    first_choice: '2L Coke',
    alternatives: ['2L Pepsi'],
    skip_if_over_budget: true,
  },
  budget_max: 45,
  special_instructions: 'Ring doorbell',
};

function createTestManager() {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  return new CallSessionManager(logger);
}

/** Build a minimal fake session for testing internal methods */
function createFakeSession(overrides: Partial<CallSession> = {}): CallSession {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  const artifacts = new ArtifactWriter('test', '/tmp/test-artifacts', false, logger);
  return {
    callId: 'test-call',
    sessionId: 'test-session',
    order: TEST_ORDER,
    targetNumber: '+15559876543',
    phase: 'conversation' as CallPhase,
    twilioCallSid: 'CA_test',
    mediaSocket: null,
    streamSid: null,
    result: null,
    logger,
    artifacts,
    startedAt: new Date().toISOString(),
    collectedEvents: [],
    audioBridge: null,
    ivrMachine: null,
    holdDetector: null,
    conversationEngine: null,
    resultAssembler: null,
    ...overrides,
  };
}

describe('CallSessionManager', () => {
  let manager: CallSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createTestManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Bot Detection ─────────────────────────────────────────────────────

  describe('bot detection', () => {
    // Access private method for direct testing
    const getDetector = (m: CallSessionManager) =>
      (m as any).detectBotAccusation.bind(m) as (text: string) => boolean;

    it('detects "are you a robot"', () => {
      expect(getDetector(manager)('Wait, are you a robot?')).toBe(true);
    });

    it('detects "is this a bot"', () => {
      expect(getDetector(manager)('Is this a bot or something?')).toBe(true);
    });

    it('detects "talking to a computer"', () => {
      expect(getDetector(manager)('Am I talking to a computer right now?')).toBe(true);
    });

    it('detects "you are a bot"', () => {
      expect(getDetector(manager)('I think you are a bot')).toBe(true);
    });

    it("detects \"you're a robot\"", () => {
      expect(getDetector(manager)("You're a robot aren't you")).toBe(true);
    });

    it('detects "sounds like a bot"', () => {
      expect(getDetector(manager)('This sounds like a bot to me')).toBe(true);
    });

    it('detects "can\'t understand you"', () => {
      expect(getDetector(manager)("I can't understand you")).toBe(true);
    });

    it('detects "cannot understand what you\'re saying"', () => {
      expect(getDetector(manager)("I cannot understand what you're saying")).toBe(true);
    });

    it('detects "not a real person"', () => {
      expect(getDetector(manager)("You're not a real person are you")).toBe(true);
    });

    it('does NOT flag normal conversation', () => {
      expect(getDetector(manager)("What size pizza would you like?")).toBe(false);
    });

    it('does NOT flag "you are welcome"', () => {
      expect(getDetector(manager)('You are welcome!')).toBe(false);
    });

    it('does NOT flag "I can help you"', () => {
      expect(getDetector(manager)('I can help you with that order')).toBe(false);
    });

    it('does NOT flag "what are your toppings"', () => {
      expect(getDetector(manager)('What are your available toppings?')).toBe(false);
    });

    it('does NOT flag "what are you trying to order" (live call false positive)', () => {
      // This was the exact phrase that killed call 102fbe96
      expect(getDetector(manager)('Cool. What are you trying to order today?')).toBe(false);
    });

    it('does NOT flag "I can\'t understand your address"', () => {
      expect(getDetector(manager)("I can't understand your address, can you repeat it?")).toBe(false);
    });
  });

  // ─── Debounce Timing ───────────────────────────────────────────────────

  describe('debounce timing', () => {
    it('uses 2500ms full debounce', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Simulate a final conversation transcript
      (manager as any).handleConversationTranscript(session, {
        text: 'That will be eighteen fifty',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // At 1200ms, should NOT have flushed yet
      vi.advanceTimersByTime(1200);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();

      // At 2500ms, should flush
      vi.advanceTimersByTime(1300);
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledWith('That will be eighteen fifty');
    });

    it('a 2-second pause after a final transcript does NOT flush', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      (manager as any).handleConversationTranscript(session, {
        text: 'Let me check on that',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      vi.advanceTimersByTime(2000);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
    });
  });

  // ─── Speech Final Behavior ─────────────────────────────────────────────

  describe('speech_final shortens debounce', () => {
    it('speech_final does NOT flush immediately', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Add a pending transcript
      (manager as any).handleConversationTranscript(session, {
        text: 'The total is twenty nine dollars',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Fire speech_final
      (manager as any).handleSpeechFinal(session);

      // Should NOT have flushed immediately
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
    });

    it('speech_final reschedules to 1200ms instead of 2500ms', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Add a pending transcript
      (manager as any).handleConversationTranscript(session, {
        text: 'Here is your order number 4412',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Fire speech_final immediately after
      (manager as any).handleSpeechFinal(session);

      // At 1000ms — not yet
      vi.advanceTimersByTime(1000);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();

      // At 1200ms — should flush
      vi.advanceTimersByTime(200);
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledWith('Here is your order number 4412');
    });

    it('speech_final with no pending transcripts does nothing', () => {
      const session = createFakeSession();
      session.conversationEngine = {} as any;
      (manager as any).activeSession = session;

      // Should not throw or create a timer
      (manager as any).handleSpeechFinal(session);
      expect((manager as any)._debounceTimer).toBeNull();
    });

    it('speech_final in non-conversation phase does nothing', () => {
      const session = createFakeSession({ phase: 'hold' });
      (manager as any).activeSession = session;
      (manager as any)._pendingTranscripts = ['some text'];

      (manager as any).handleSpeechFinal(session);
      // Timer should not be set for non-conversation phase
      expect((manager as any)._debounceTimer).toBeNull();
    });
  });

  // ─── Confirm-Done Timeout Cancellation ─────────────────────────────────

  describe('confirm-done timeout cancellation', () => {
    it('cancels confirm_done timeout when new transcript arrives', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Simulate a confirm_done timeout being active
      (manager as any)._confirmDoneTimeout = setTimeout(() => {}, 10000);
      expect((manager as any)._confirmDoneTimeout).not.toBeNull();

      // Any inbound transcript should cancel it
      (manager as any).handleConversationTranscript(session, {
        text: 'Oh wait, I also wanted to add something',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      expect((manager as any)._confirmDoneTimeout).toBeNull();
    });

    it('cancels timeout even on partial (non-final) transcripts', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      (manager as any).activeSession = session;

      (manager as any)._confirmDoneTimeout = setTimeout(() => {}, 10000);

      // Partial transcript should also cancel the timeout
      (manager as any).handleConversationTranscript(session, {
        text: 'Actually wait',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.8,
      });

      expect((manager as any)._confirmDoneTimeout).toBeNull();
    });

    it('does NOT cancel timeout on empty transcript', () => {
      const session = createFakeSession();
      session.conversationEngine = {} as any;
      (manager as any).activeSession = session;

      const timeout = setTimeout(() => {}, 10000);
      (manager as any)._confirmDoneTimeout = timeout;

      (manager as any).handleConversationTranscript(session, {
        text: '   ',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.1,
      });

      // Timeout should still be active (empty/whitespace transcript)
      expect((manager as any)._confirmDoneTimeout).not.toBeNull();
    });

    it('confirm_done timeout on terminal Twilio status is also cleared', () => {
      const session = createFakeSession({ twilioCallSid: 'CA_test' });
      session.conversationEngine = {
        getOrderState: () => createInitialOrderState(),
      } as any;
      (manager as any).activeSession = session;

      (manager as any)._confirmDoneTimeout = setTimeout(() => {}, 10000);

      // Simulate terminal Twilio status — should clear confirm timeout
      // We need to mock endCall to prevent it from trying to use real artifacts
      (manager as any).endCall = vi.fn();
      manager.handleTwilioStatus('CA_test', 'completed');

      expect((manager as any)._confirmDoneTimeout).toBeNull();
    });
  });

  // ─── Transcript Accumulation ───────────────────────────────────────────

  describe('transcript accumulation', () => {
    it('combines multiple final transcripts into one flush', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Send two finals in quick succession
      (manager as any).handleConversationTranscript(session, {
        text: 'Okay so that will be',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });
      (manager as any).handleConversationTranscript(session, {
        text: 'eighteen fifty for the pizza',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Flush after debounce
      vi.advanceTimersByTime(2500);

      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledWith(
        'Okay so that will be eighteen fifty for the pizza'
      );
      // Should be called exactly once (combined)
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledTimes(1);
    });

    it('ignores partial transcripts when no debounce is active', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      (manager as any).handleConversationTranscript(session, {
        text: 'partial text here',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.7,
      });

      // No pending transcripts should have been added
      expect((manager as any)._pendingTranscripts).toHaveLength(0);
    });

    it('ignores transcripts while agent is speaking', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      session.audioBridge = { getIsSpeaking: () => true } as any;
      (manager as any).activeSession = session;

      (manager as any).handleConversationTranscript(session, {
        text: 'This should be ignored',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      expect((manager as any)._pendingTranscripts).toHaveLength(0);
    });

    it('does not flush while another Groq request is in-flight', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;
      (manager as any)._isGenerating = true;

      (manager as any).handleConversationTranscript(session, {
        text: 'Hello there',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Let debounce fire
      vi.advanceTimersByTime(2500);

      // addEmployeeSpeech should NOT have been called because _isGenerating
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
      // But the text should still be in pending transcripts
      expect((manager as any)._pendingTranscripts).toContain('Hello there');
    });
  });

  // ─── Bot Accusation Triggers Hangup ────────────────────────────────────

  describe('bot accusation triggers hangup in conversation', () => {
    it('forces hangup when bot accusation detected in final transcript', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      const speakMock = vi.fn();
      session.audioBridge = {
        getIsSpeaking: () => false,
        speak: speakMock,
      } as any;
      (manager as any).activeSession = session;

      // Mock endCall to track if it's called
      const endCallSpy = vi.fn();
      (manager as any).endCall = endCallSpy;

      (manager as any).handleConversationTranscript(session, {
        text: 'Wait, are you a robot?',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Should have spoken a goodbye
      expect(speakMock).toHaveBeenCalledWith("I'm sorry, I have to go. Goodbye.");

      // endCall should be scheduled after 2000ms
      vi.advanceTimersByTime(2000);
      expect(endCallSpy).toHaveBeenCalledWith(
        session,
        'detected_as_bot',
        'Bot accusation detected in transcript'
      );
    });

    it('does NOT trigger bot detection on normal conversation', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      const endCallSpy = vi.fn();
      (manager as any).endCall = endCallSpy;

      (manager as any).handleConversationTranscript(session, {
        text: 'What toppings do you want on that?',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      vi.advanceTimersByTime(5000);
      expect(endCallSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Filler Word Detection ──────────────────────────────────────────────

  describe('filler word detection', () => {
    it('filler word "Okay." keeps full debounce, not speech_final shortened', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Employee says "Okay."
      (manager as any).handleConversationTranscript(session, {
        text: 'Okay.',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // speech_final fires — but "Okay." is a filler, so it should NOT shorten
      (manager as any).handleSpeechFinal(session);

      // At 1200ms (speech_final timer), should NOT have flushed (filler keeps full debounce)
      vi.advanceTimersByTime(1200);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();

      // At 2500ms (full timer), standalone filler is DROPPED — not sent to Groq
      vi.advanceTimersByTime(1300);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
    });

    it('filler word "Got it" keeps full debounce and is dropped', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      (manager as any).handleConversationTranscript(session, {
        text: 'Got it',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      (manager as any).handleSpeechFinal(session);

      // Should NOT flush at shortened timer
      vi.advanceTimersByTime(1200);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();

      // Standalone filler is DROPPED at full timer — not sent to Groq
      vi.advanceTimersByTime(1300);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
    });

    it('non-filler text gets shortened debounce on speech_final', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      (manager as any).handleConversationTranscript(session, {
        text: 'The total is twenty nine dollars',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      (manager as any).handleSpeechFinal(session);

      // Should flush at 1200ms (shortened)
      vi.advanceTimersByTime(1200);
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledWith('The total is twenty nine dollars');
    });

    it('recognizes various filler words', () => {
      const fillers = ['Okay', 'ok', 'Got it', 'Cool', 'Right', 'Alright', 'Sure', 'Yeah', 'Yep', 'Great', 'Perfect', 'Mm-hmm', 'Uh-huh'];
      const pattern = (CallSessionManager as any).FILLER_PATTERN;

      for (const filler of fillers) {
        expect(pattern.test(filler)).toBe(true);
        // Also with trailing period
        expect(pattern.test(filler + '.')).toBe(true);
      }
    });

    it('does NOT treat multi-word sentences as fillers', () => {
      const pattern = (CallSessionManager as any).FILLER_PATTERN;
      expect(pattern.test('Okay so the pizza is eighteen fifty')).toBe(false);
      expect(pattern.test('Got it let me check on that')).toBe(false);
    });
  });

  // ─── Partial Transcript Debounce Extension ──────────────────────────────

  describe('partial transcript extends debounce', () => {
    it('partial transcript during active debounce resets timer to full DEBOUNCE_MS', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // Employee says "Okay." (final) — filler, would be dropped if standalone
      (manager as any).handleConversationTranscript(session, {
        text: 'Okay.',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // 1 second passes, then a partial arrives — employee started talking again
      vi.advanceTimersByTime(1000);
      (manager as any).handleConversationTranscript(session, {
        text: 'So we',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.7,
      });

      // The debounce should have reset. At 3000ms from the partial (4000ms total), still not flushed
      vi.advanceTimersByTime(3000);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();

      // "Okay." alone is a filler — it gets dropped at flush time
      vi.advanceTimersByTime(500);
      expect(mockEngine.addEmployeeSpeech).not.toHaveBeenCalled();
    });

    it('partial transcript without active debounce does nothing', () => {
      const session = createFakeSession();
      session.conversationEngine = { addEmployeeSpeech: vi.fn() } as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // No pending transcripts, no debounce timer
      (manager as any).handleConversationTranscript(session, {
        text: 'some partial',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.7,
      });

      expect((manager as any)._debounceTimer).toBeNull();
      expect((manager as any)._pendingTranscripts).toHaveLength(0);
    });

    it('multi-sentence employee turn accumulated correctly with partial extension', () => {
      const session = createFakeSession();
      const mockEngine = {
        addEmployeeSpeech: vi.fn(),
        generateResponse: vi.fn().mockResolvedValue(null),
        getOrderState: vi.fn().mockReturnValue(createInitialOrderState()),
      };
      session.conversationEngine = mockEngine as any;
      session.audioBridge = { getIsSpeaking: () => false } as any;
      (manager as any).activeSession = session;

      // First sentence final
      (manager as any).handleConversationTranscript(session, {
        text: 'So we are actually out of mushrooms.',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // 1s pause, partial arrives (employee continuing)
      vi.advanceTimersByTime(1000);
      (manager as any).handleConversationTranscript(session, {
        text: 'Would you',
        isFinal: false,
        timestamp: new Date().toISOString(),
        confidence: 0.7,
      });

      // Second sentence final arrives
      vi.advanceTimersByTime(500);
      (manager as any).handleConversationTranscript(session, {
        text: 'Would you like a substitute?',
        isFinal: true,
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      });

      // Wait for full debounce from last final
      vi.advanceTimersByTime(2500);
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledWith(
        'So we are actually out of mushrooms. Would you like a substitute?'
      );
      expect(mockEngine.addEmployeeSpeech).toHaveBeenCalledTimes(1);
    });
  });
});
