/**
 * Hold Detector & Human Pickup Detection.
 *
 * During HOLD state:
 *   - Agent stays completely silent
 *   - Monitors Deepgram transcripts for human speech patterns
 *   - Distinguishes hold music/silence from actual human pickup
 *
 * Required logs:
 *   - Hold start timestamp
 *   - Suspected human speech events (with transcript snippet)
 *   - False positive detections
 *   - Confirmed human pickup
 *   - Timeout behavior
 */

import { Logger } from '../logging/logger';

// Patterns that indicate a human has picked up
const HUMAN_GREETING_PATTERNS = [
  /\b(hey|hi|hello|thanks?\s*for\s*(calling|holding)|what\s*can\s*i|how\s*can\s*i|can\s*i\s*help)\b/i,
  /\b(welcome\s*to|good\s*(morning|afternoon|evening))\b/i,
  /\b(what('s|\s*is)\s*your|name\s*for\s*the|phone\s*number)\b/i,
  /\b(ready\s*to\s*order|get\s*started|help\s*you)\b/i,
];

// Patterns that suggest hold music or automated messages (not a real human)
const NON_HUMAN_PATTERNS = [
  /\b(your\s*call\s*is\s*important|please\s*continue\s*to\s*hold|estimated\s*wait)\b/i,
  /\b(remain\s*on\s*the\s*line|next\s*available)\b/i,
];

export type HoldDetectorResult =
  | { detected: false }
  | { detected: true; transcript: string; confidence: 'high' | 'medium' };

export class HoldDetector {
  private logger: Logger;
  private holdStartTime: number;
  private speechSegments: { text: string; timestamp: number }[] = [];
  private consecutiveHumanLikeSegments = 0;
  private maxHoldDurationMs: number;
  private humanDetected = false;

  constructor(
    parentLogger: Logger,
    maxHoldDurationMs = 5 * 60 * 1000 // 5 minute default max hold
  ) {
    this.logger = parentLogger.child('hold');
    this.holdStartTime = Date.now();
    this.maxHoldDurationMs = maxHoldDurationMs;

    this.logger.info('hold.started', 'Hold period started — agent is silent', {
      hold_start: new Date(this.holdStartTime).toISOString(),
      max_hold_duration_ms: maxHoldDurationMs,
    });
  }

  /** Process a transcript segment from Deepgram during hold */
  processTranscript(text: string, isFinal: boolean): HoldDetectorResult {
    if (this.humanDetected) {
      return { detected: true, transcript: text, confidence: 'high' };
    }

    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 3) {
      return { detected: false };
    }

    // Check hold duration timeout
    const elapsed = Date.now() - this.holdStartTime;
    if (elapsed > this.maxHoldDurationMs) {
      this.logger.warn('hold.timeout', `Hold exceeded max duration: ${elapsed}ms`, {
        elapsed_ms: elapsed,
        max_ms: this.maxHoldDurationMs,
      });
      // Don't auto-hangup here — let the session manager decide
    }

    // Check if it sounds like a non-human (hold message)
    for (const pattern of NON_HUMAN_PATTERNS) {
      if (pattern.test(trimmed)) {
        this.logger.debug('hold.automated_message', 'Detected automated hold message', {
          transcript: trimmed,
          elapsed_ms: elapsed,
        });
        this.consecutiveHumanLikeSegments = 0;
        return { detected: false };
      }
    }

    // Check if it sounds like a human greeting
    for (const pattern of HUMAN_GREETING_PATTERNS) {
      if (pattern.test(trimmed)) {
        this.consecutiveHumanLikeSegments++;

        if (isFinal) {
          // Final transcript with human pattern = high confidence
          this.logger.info('hold.human_detected', `Human pickup detected: "${trimmed}"`, {
            transcript: trimmed,
            confidence: 'high',
            elapsed_ms: elapsed,
            consecutive_segments: this.consecutiveHumanLikeSegments,
          });
          this.humanDetected = true;
          return { detected: true, transcript: trimmed, confidence: 'high' };
        } else {
          // Partial transcript — log as suspected
          this.logger.debug('hold.suspected_human', `Suspected human speech (partial): "${trimmed}"`, {
            transcript: trimmed,
            confidence: 'medium',
            elapsed_ms: elapsed,
          });
          return { detected: false };
        }
      }
    }

    // Generic speech that doesn't match known patterns
    // If we get enough consecutive non-hold segments, likely a human
    if (isFinal && trimmed.length > 10) {
      this.speechSegments.push({ text: trimmed, timestamp: Date.now() });
      this.consecutiveHumanLikeSegments++;

      if (this.consecutiveHumanLikeSegments >= 2) {
        this.logger.info('hold.human_detected', `Human pickup detected (multiple speech segments): "${trimmed}"`, {
          transcript: trimmed,
          confidence: 'medium',
          elapsed_ms: elapsed,
          consecutive_segments: this.consecutiveHumanLikeSegments,
          recent_segments: this.speechSegments.slice(-3).map((s) => s.text),
        });
        this.humanDetected = true;
        return { detected: true, transcript: trimmed, confidence: 'medium' };
      }
    }

    return { detected: false };
  }

  /** Check if hold has timed out */
  isTimedOut(): boolean {
    return Date.now() - this.holdStartTime > this.maxHoldDurationMs;
  }

  /** Get hold duration in ms */
  getHoldDuration(): number {
    return Date.now() - this.holdStartTime;
  }
}
