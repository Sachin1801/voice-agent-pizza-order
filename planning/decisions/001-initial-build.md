# Decision Trace: Initial Build — Phases 0-8

**Date:** 2026-03-29
**Agent:** Claude Opus 4.6
**Session:** Initial implementation of all 8 phases

## What I Understood

The task is to build a voice agent that places outbound phone calls to order pizza. The agent must:
1. Navigate an IVR (automated phone menu) with exact responses
2. Wait on hold silently
3. Speak with a human employee to place an order
4. Follow strict substitution, budget, and business rules
5. Return structured JSON results

The build plan (`planning/plans/voice-agent-build-plan.md`) provided:
- Full architecture with module boundaries
- Detailed logging requirements (14-field event schema, 7 artifact files per call)
- Phase ordering: observability first, then telephony, then logic
- Open architecture decisions to resolve during implementation

## Decisions Made

### 1. Observability built before providers
**Decision:** Logger, event schema, artifact writer, and redaction all created in Phase 1, before any Twilio/Deepgram/Groq/Cartesia integration.
**Why:** The build plan mandates "missing logs = missing functionality." By building the logging system first, every subsequent module is born with structured logging — not retrofitted later.

### 2. JSONL for event streams
**Decision:** `events.jsonl`, `transcript.jsonl`, and `actions.jsonl` use append-only JSONL format.
**Why:** JSONL survives process crashes mid-call (unlike JSON arrays that need a closing bracket). Each line is independently parseable by agents.

### 3. Shared sequence counter via reference
**Decision:** Child loggers share a mutable `{ value: number }` reference for auto-incrementing sequence numbers.
**Why:** Events from different components (IVR, Groq, Cartesia) need globally ordered sequence numbers within a single call. Sharing a reference object avoids a global counter while keeping the sequence consistent.

### 4. Deepgram SDK v5 API
**Decision:** Used `client.listen.v1.connect()` with `any` casts for config options.
**Why:** The `@deepgram/sdk` v5 has TypeScript types that don't match the actual runtime API for some config fields (e.g., `punctuate` expects `string` not `boolean`). The runtime works correctly with boolean values, so we cast to `any` rather than fight the types.

### 5. IVR as pure state machine — no LLM
**Decision:** The IVR state machine is completely deterministic with regex pattern matching. No LLM calls during IVR navigation.
**Why:** The IVR prompts are fixed and only accept exact responses. Using an LLM would add latency, cost, and hallucination risk for zero benefit. Pattern matching is fast, reliable, and testable.

### 6. DTMF via Twilio REST API
**Decision:** Send DTMF digits through `client.calls(sid).update()` with TwiML, not through the WebSocket audio stream.
**Why:** DTMF tones sent through the audio stream can be mangled by encoding/timing. The REST API sends them through the telephony network directly, which is what the IVR expects.

### 7. Rule engine as code-level guardrail
**Decision:** Business rules (no-go toppings, budget limits, side ordering) enforced in TypeScript code, not just in the LLM prompt.
**Why:** LLMs can be persuaded or hallucinate. If the employee says "how about anchovies?" and the LLM forgets the no-go list, the code-level check blocks it. The rule engine evaluates every LLM action before it's spoken.

### 8. Tests focused on deterministic logic
**Decision:** Tests cover IVR state machine (12 tests), rule engine (14 tests), action validator (10 tests), and redaction (9 tests). No tests for audio bridge or provider clients.
**Why:** The IVR and rule engine are pure logic — wrong behavior here means the call fails or violates business rules. Provider clients are thin WebSocket wrappers; mocking them would test the mock, not the integration. Real integration testing happens by calling your phone.

### 9. Cartesia WebSocket for streaming TTS
**Decision:** Used Cartesia's WebSocket API with `pcm_mulaw` output format at 8000Hz.
**Why:** Streaming TTS means the first audio chunk arrives in ~100ms (vs 500ms+ for REST). The `pcm_mulaw/8000` format matches Twilio's native format — no transcoding needed.

## How Code Connects

```
POST /api/calls
    → routes/calls.ts validates order (zod)
    → session/call-session-manager.ts creates call via Twilio REST

Twilio calls back → POST /api/twilio/voice
    → routes/twilio-webhooks.ts returns TwiML opening WebSocket stream

Twilio opens WebSocket → /api/twilio/media-stream
    → server.ts handles upgrade, passes to session manager
    → session manager enters IVR phase

IVR Phase:
    audio → Deepgram STT → transcript → ivr/ivr-state-machine.ts
    state machine decides: send DTMF | speak | transition to hold
    DTMF → Twilio REST API
    speak → Cartesia TTS → audio → Twilio WebSocket

Hold Phase:
    audio → Deepgram STT → conversation/hold-detector.ts
    detector looks for human greeting patterns
    on detection → transition to conversation

Conversation Phase:
    audio → Deepgram STT → transcript
    transcript → conversation/conversation-engine.ts
    engine sends to Groq → gets JSON action
    action → conversation/action-validator.ts (zod parse)
    validated action → conversation/rule-engine.ts (business rules)
    if allowed: speak via Cartesia, update order state
    if blocked: generate corrective response

Hangup:
    session/result-assembler.ts builds CallResult
    logging/artifact-writer.ts writes all 7 artifact files
    logging/summary-writer.ts generates summary.md
```

## What's Still Needed
- Twilio account setup (not yet created)
- ngrok/tunnel for public webhook URL
- Integration wiring: the session manager currently handles media stream messages but doesn't yet route audio through the full pipeline (Deepgram→IVR/Conversation→Cartesia→Twilio)
- The open architecture decisions from the build plan (turn-taking thresholds, failure taxonomy, etc.)
- End-to-end test with a real phone call
