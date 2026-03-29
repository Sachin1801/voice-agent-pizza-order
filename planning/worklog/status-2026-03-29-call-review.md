# Call Review: 4dc7b33e — First Successful End-to-End Call

## What Worked
- Full IVR navigation: WELCOME→NAME→CALLBACK→ZIP→CONFIRM→TRANSFER→HOLD ✓
- IVR state preserved across DTMF reconnects ✓
- Hold detection: correctly identified human pickup ✓
- Conversation: 27 Groq requests, all valid JSON, all under 1s latency ✓
- Topping substitution: rejected olives (no-go), accepted sausage (acceptable) ✓
- Side fallback: wings unavailable → garlic bread accepted ✓
- Price extraction: pizza $18.50, garlic bread $6.99 ✓
- Delivery time: 35 minutes ✓
- Order number: 4412 ✓
- Special instructions delivered ✓
- Artifacts written: result.json, summary.md, events.jsonl, actions.jsonl ✓

## Bugs Found

### Bug 1: Outcome is `nothing_available` instead of `completed`
**Root cause:** The agent never calls `hangup_with_outcome`. It says "That's all, thank you. My order is complete" (a `confirm_done` action), but then does nothing — it doesn't hang up. The user hangs up, which triggers `handleTwilioStatus("completed")` → `endCall()` with default outcome `nothing_available`.

**Fix:** Two changes needed:
1. After `confirm_done`, the agent should immediately follow up with a `hangup_with_outcome` action (or we should treat `confirm_done` as triggering a hangup with `completed` outcome).
2. When the far end hangs up and we have a valid order state (pizza confirmed, instructions delivered), `endCall()` should infer `completed` instead of defaulting to `nothing_available`.

### Bug 2: Running total is $69.48 instead of $28.98
**Root cause:** `updatePizzaPrice()` is called multiple times. The logs show:
- seq 406: `pizza_price_set: $18.5` (correct, first time)
- seq 425: `pizza_price_set: $18.5` (duplicate — garlic bread response also had `heard_price`)
- seq 484: `pizza_price_set: $18.5` (third time)

Each call to `updatePizzaPrice()` ADDS to the running total. Three calls = $55.50 for pizza alone.

**Fix:** `updatePizzaPrice()` should be idempotent — only add to running total if not already set. Same for `updateSide()` and `updateDrink()`.

### Bug 3: Agent says "2L Coke" — employee can't understand
**Root cause:** The order data has `"2L Coke"` and the agent says it literally. A human would say "two liter Coke."

**Fix:** Add text normalization in the TTS path. Before sending to Cartesia, expand common abbreviations: `2L` → `two liter`, `12 count` → `twelve count`, `Apt` → `Apartment`.

### Bug 4: Agent doesn't hang up — user must end the call
**Root cause:** After `confirm_done`, nothing triggers the next action. The conversation engine waits for the next employee transcript, but the conversation is done. There's no timeout or auto-hangup after confirmation.

**Fix:** After `confirm_done`, schedule a hangup with `completed` outcome. Also add a conversation inactivity timeout (e.g., 15 seconds of silence after the agent finishes speaking → hang up).

### Bug 5: Agent repeats itself / not patient
**Root cause:** The agent interprets short employee utterances ("Okay", "Got it") as needing a response, and the LLM repeats the order. Also, when Deepgram splits the employee's speech into multiple final transcripts (e.g., "should be about" then "thirty five minutes"), the agent responds to each fragment separately instead of waiting for the full thought.

**Fix:**
1. Add a silence/debounce timer: after a final transcript, wait 1.5-2 seconds for more speech before triggering the LLM. This lets the employee finish their sentence.
2. Update the Groq prompt to instruct the LLM to NOT repeat information the employee already acknowledged, and to wait for clear questions rather than reacting to filler words.

### Bug 6: Agent rejected onion (it's in the acceptable list)
At seq 370, the employee said "Can we do onion?" and the agent rejected it ("I'm not really looking for onion"). The rule engine flagged this: `unnecessary_rejection: LLM rejected "onion" but it's in acceptable list`. The rule engine allowed the rejection because it's valid to reject even acceptable options, but the LLM made a bad call.

**Fix:** Update the Groq prompt to emphasize: when a topping is in `acceptable_topping_subs`, the agent SHOULD accept it, not reject it. The acceptable list is explicitly what the customer approved.

### Bug 7: Agent corrected the employee's math then agreed with it
At seq 462, the agent said "That's not correct. The pizza is $18.50 and the garlic bread is $6.99, so the total should be $25.49. Actually, that's correct." This is the LLM hallucinating a correction then immediately backing down.

**Fix:** This is a prompt quality issue. The LLM shouldn't argue about math — just acknowledge the total the employee gives.

## Fix Priority

| # | Bug | Severity | Fix Location |
|---|-----|----------|-------------|
| 1 | Wrong outcome | P0 | call-session-manager.ts `endCall()` |
| 2 | Running total doubled/tripled | P0 | conversation-engine.ts `updatePizzaPrice()` etc |
| 3 | "2L" not human-readable | P1 | audio-bridge.ts or new text normalizer |
| 4 | Agent doesn't hang up | P0 | call-session-manager.ts after `confirm_done` |
| 5 | Agent repeats / not patient | P1 | Transcript debounce + prompt tuning |
| 6 | Rejected acceptable topping | P1 | prompts.ts — stronger wording |
| 7 | Argued about math | P2 | prompts.ts — don't correct employee math |
