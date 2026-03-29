import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HoldDetector } from '../hold-detector';
import { createCallLogger } from '../../logging/logger';

function createTestDetector(maxHoldMs = 5 * 60 * 1000) {
  const logger = createCallLogger('test', 'test', 'session', 'error');
  return new HoldDetector(logger, maxHoldMs);
}

describe('HoldDetector', () => {
  let detector: HoldDetector;

  beforeEach(() => {
    detector = createTestDetector();
  });

  describe('human greeting detection (high confidence)', () => {
    const humanGreetings = [
      'Hey, thanks for holding!',
      'Hi, how can I help you today?',
      'Hello, what can I get for you?',
      'Thanks for calling, what would you like to order?',
      'Good afternoon, ready to order?',
      'Welcome to Pizza Palace!',
      "What's your name for the order?",
      'Can I help you with something?',
      'Are you ready to order?',
      "What's your phone number?",
    ];

    for (const greeting of humanGreetings) {
      it(`detects final human greeting: "${greeting}"`, () => {
        const result = detector.processTranscript(greeting, true);
        expect(result.detected).toBe(true);
        if (result.detected) {
          expect(result.confidence).toBe('high');
          expect(result.transcript).toBe(greeting);
        }
      });
    }
  });

  describe('non-human (automated hold messages)', () => {
    const holdMessages = [
      'Your call is important to us. Please continue to hold.',
      'The estimated wait time is 3 minutes.',
      'Please remain on the line for the next available representative.',
    ];

    for (const msg of holdMessages) {
      it(`rejects automated message: "${msg}"`, () => {
        const result = detector.processTranscript(msg, true);
        expect(result.detected).toBe(false);
      });
    }
  });

  describe('partial transcripts', () => {
    it('does not detect on partial transcript even with human pattern', () => {
      const result = detector.processTranscript('Hi, how can I help', false);
      expect(result.detected).toBe(false);
    });

    it('detects when the same content comes as final', () => {
      detector.processTranscript('Hi, how can I help', false);
      const result = detector.processTranscript('Hi, how can I help you?', true);
      expect(result.detected).toBe(true);
    });
  });

  describe('short/empty transcripts', () => {
    it('ignores empty strings', () => {
      const result = detector.processTranscript('', true);
      expect(result.detected).toBe(false);
    });

    it('ignores very short strings (< 3 chars)', () => {
      const result = detector.processTranscript('hi', true);
      expect(result.detected).toBe(false);
    });
  });

  describe('consecutive non-pattern speech segments (medium confidence)', () => {
    it('detects human after 2 consecutive final speech segments > 10 chars', () => {
      // First segment: final, > 10 chars, no known pattern
      const r1 = detector.processTranscript('Alright let me pull that up for you', true);
      expect(r1.detected).toBe(false);

      // Second segment: triggers medium confidence detection
      const r2 = detector.processTranscript('Okay so what kind of pizza do you want', true);
      expect(r2.detected).toBe(true);
      if (r2.detected) {
        expect(r2.confidence).toBe('medium');
      }
    });
  });

  describe('consecutive counter reset on automated messages', () => {
    it('resets consecutive counter when automated message appears', () => {
      // One human-like segment
      const r1 = detector.processTranscript('Alright let me pull that up for you', true);
      expect(r1.detected).toBe(false);

      // Automated message resets the counter
      const r2 = detector.processTranscript('Your call is important to us, please continue to hold', true);
      expect(r2.detected).toBe(false);

      // Now we need 2 more consecutive segments again
      const r3 = detector.processTranscript('Another segment of speech here', true);
      expect(r3.detected).toBe(false);

      const r4 = detector.processTranscript('Second segment after the reset', true);
      expect(r4.detected).toBe(true);
    });
  });

  describe('already detected', () => {
    it('returns detected=true on all subsequent calls after first detection', () => {
      // First detection
      detector.processTranscript('Hi, how can I help you?', true);

      // All subsequent calls should return detected
      const r2 = detector.processTranscript('anything at all', true);
      expect(r2.detected).toBe(true);
      if (r2.detected) {
        expect(r2.confidence).toBe('high');
      }
    });
  });

  describe('timeout', () => {
    it('is not timed out initially', () => {
      expect(detector.isTimedOut()).toBe(false);
    });

    it('times out after maxHoldDurationMs', () => {
      vi.useFakeTimers();
      const shortDetector = createTestDetector(1000); // 1 second max
      expect(shortDetector.isTimedOut()).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(shortDetector.isTimedOut()).toBe(true);
      vi.useRealTimers();
    });

    it('reports hold duration', () => {
      vi.useFakeTimers();
      const d = createTestDetector();
      vi.advanceTimersByTime(5000);
      expect(d.getHoldDuration()).toBeGreaterThanOrEqual(5000);
      vi.useRealTimers();
    });
  });
});
