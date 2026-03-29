# Debug Status — 2026-03-29 Evening

## What Works
- Twilio outbound call connects ✓
- Phone rings, user picks up ✓
- Twilio voice webhook returns TwiML with `<Stream>` ✓
- WebSocket media stream connects ✓
- Twilio sends JSON media messages (~50/sec) ✓
- JSON parsing now works — `first_message_parsed: event=connected` ✓
- Media packets flow — `audio_bridge.first_media: 160 bytes from 216 chars base64` ✓
- Base64 decode works correctly ✓
- Cartesia TTS WebSocket connects ✓
- IVR state machine initializes ✓

## What's Broken
**Audio never reaches Deepgram. Agent can't hear. Agent stays silent.**

### Root Cause (confirmed from artifacts)
From `data/runs/aa0671e2/events.jsonl`:
```
0015 [deepgram] deepgram.ready: Deepgram STT ready
0023 [session] session.media_flow: Media packets received: 1
0024 [audio_bridge] first_media: 160 bytes from 216 chars base64
0025 [deepgram] send_media_failed: Socket is not open.
0026 [deepgram] send_media_failed: Socket is not open.
...repeats forever
```

**The Deepgram WebSocket is not actually open when we start sending audio.**

Our code calls `await connection.connect()` which returns immediately, but the WebSocket handshake hasn't completed yet. Audio starts flowing from Twilio before Deepgram is ready to receive it.

### Three bugs in `src/audio/deepgram-client.ts`:

1. **Event name wrong**: We listen for `"transcript"` but the SDK v5 fires `"message"` (confirmed by Deepgram docs: `connection.on("message", (data) => { if (data.type === "Results") ... })`)

2. **Event listeners registered too early**: The Deepgram docs show listeners must be registered INSIDE the `"open"` handler. We register them before calling `connect()`.

3. **No `waitForOpen()`**: The SDK provides `connection.waitForOpen()` to wait until the WebSocket is actually open. We don't use it, so audio sending starts before the socket is ready.

### The correct pattern (from Deepgram docs):
```javascript
const connection = await deepgram.listen.v1.connect({ model: "nova-3", ... });
connection.on("open", () => {
  connection.on("message", (data) => {
    if (data.type === "Results") {
      console.log(data.channel.alternatives[0].transcript);
    }
  });
  connection.on("error", (err) => console.error(err));
  connection.on("close", () => console.log("closed"));
  // NOW safe to send audio
});
connection.connect();
await connection.waitForOpen();
```

## Bugs Fixed So Far (this session)
1. ✓ Deepgram SDK v5 API: `listen.v1.connect()` returns Promise (was calling sync)
2. ✓ Deepgram `sendMedia()` not `send()`
3. ✓ Twilio message parsing: was flooding with parse errors
4. ✓ Session cleanup: completed sessions blocking new calls
5. ✓ Diagnostic logging: can now trace exactly where pipeline breaks

## Fixes Applied

### P0 #1 — Deepgram event name + waitForOpen() ✓
- Changed `"transcript"` → `"message"` with `data.type === "Results"` filter
- Moved all event listeners inside `"open"` handler
- Added `connection.connect()` then `await connection.waitForOpen()`
- Added `_isOpen` flag so `sendAudio()` checks socket state

### P0 #2 — Audio buffering before Deepgram ready ✓
- `AudioBridge` now buffers audio packets in `audioBuffer[]` until Deepgram emits `"ready"`
- On ready, flushes all buffered packets so no audio from call start is lost

### P0 #3 — Terminal status never finalized artifacts ✓
- `handleTwilioStatus()` now routes ALL terminal states through `endCall()`
- `endCall()` always writes `result.json`, `summary.md`, `metrics.json`

### P1 #1 — Conversation can't produce completed order ✓
- Added structured data fields to `say` action: `heard_price`, `heard_total`, `heard_delivery_time`, `heard_order_number`, `delivering_special_instructions`
- `generateAndSpeak()` now extracts these and calls `updatePizzaPrice()`, `updateSide()`, `updateDrink()`, etc.
- Updated Groq prompt to instruct LLM to include these fields

### P1 #2 — Agent hears own TTS (self-loop) ✓
- Media handler now filters: only forwards `track !== 'outbound'` to STT

### P1 #3 — Parse errors vs handler errors conflated ✓
- Split into two separate try-catch blocks: one for `JSON.parse()`, one for `handleTwilioMessage()`

## Still Unimplemented
- P2: Audio recording (empty `audio/` dirs)
- P2: Integration tests for live pipeline
- Turn-taking thresholds, barge-in tuning
- Operational guardrails (max call duration, etc.)
