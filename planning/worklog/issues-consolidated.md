# Consolidated Issues — Calls 4dc7b33e + 13fc0427

Based on two end-to-end test calls with live roleplay.

---

## P0 — Must Fix

### 1. Agent info-dumps on first response
**Both calls:** The agent's first message after human pickup is:
> "Hi, I'd like to place a delivery order. My name is Jordan Mitchell and my phone number is 5125550147. I'd like to order a large thin crust pizza..."

It dumps name, phone, address, and order in one sentence. A real person would say "Hi, I'd like to place a delivery order" and WAIT for the employee to ask questions.

**Root cause:** The system prompt doesn't instruct the agent to wait for prompts. It tries to be "efficient" by front-loading all info.

**Fix:** Update `prompts.ts` — instruct the agent to ONLY answer what's asked. First response should just be "Hi, I'd like to place a delivery order please." Then wait for the employee to ask for name, phone, address individually.

### 2. Running total accumulates incorrectly — $43.99 instead of $28.98
**Call 13fc0427:** Result shows `total: 43.99`. The actual order is $18.50 + $6.99 = $25.49 (drink was skipped). The LLM correctly says "$28.98" in conversation but the code-tracked total is wrong.

**Root cause:** `updatePizzaPrice()` adds to running total every time it's called. The LLM attaches `heard_price` on multiple responses (seq 357, 389, etc.), each adding $18.50 again. Same for side — called twice.

**Fix:** Make `updatePizzaPrice()`, `updateSide()`, `updateDrink()` idempotent — only set the price and add to total on the FIRST call. If already set, skip.

### 3. Agent doesn't hang up after confirm_done (Call 4dc7b33e)
**Call 4dc7b33e:** Agent said "That's all, thank you. My order is complete" (`confirm_done`) but never hung up. User had to end the call manually. Outcome was `nothing_available` because `endCall()` was triggered by Twilio status, not by the agent.

**Call 13fc0427:** This was fixed — after `confirm_done`, the agent sent `hangup_with_outcome` on the next turn. But it required the employee to say "Thank you" first. If the employee had said nothing, the agent would've sat in silence.

**Fix:** Add a post-confirm timeout. After `confirm_done`, if no `hangup_with_outcome` comes within 10 seconds, auto-hangup with `completed`.

### 4. Agent reveals budget ("within my budget of $45")
**Call 13fc0427, action #22:** Agent says "My total comes out to be $28.98, which is within my budget of $45."

A real customer would never tell the pizza shop their budget.

**Fix:** Update prompt — explicitly instruct: "Never mention your budget to the employee."

### 5. Drink skipped but total includes it / drink handling confused
**Call 13fc0427:** The code logged `drink_skipped` multiple times ($43.99 + $3.49 > $45) but the running total was already wrong at $43.99. The actual pizza+side is $25.49, well under budget. Drink should have been ordered.

**Root cause:** Running total was $43.99 due to duplicate price additions (bug #2). The drink skip logic compared against the inflated total.

**Fix:** Fixing bug #2 (idempotent prices) will fix this cascading issue.

---

## P1 — Important for Quality

### 6. Agent impatient — responds to fragments / filler words
**Both calls:** When the employee says "Okay" or pauses mid-sentence, the agent immediately generates a response. Examples:
- Employee: "Okay." → Agent repeats the entire order
- Employee: "That will be" (pause) → Agent: "Yes, please go ahead with the total"
- Employee: "should be about" (pause) → Agent interrupts asking for exact time

Deepgram splits speech into fragments. Each final transcript triggers a Groq call.

**Fix:** Add a debounce timer in `handleConversationTranscript()`:
- After receiving a final transcript, start a 2-second timer
- If another transcript arrives within 2 seconds, reset the timer and concatenate
- Only call `generateAndSpeak()` after 2 seconds of silence
- This lets the employee finish their thought

### 7. Agent repeats itself when employee acknowledges
**Both calls:** When employee says "Got it" or "Okay", the agent re-states the same information or asks the same question again. Actions #5-6 in call 13fc0427 show the address repeated twice back-to-back.

**Root cause:** The LLM interprets acknowledgments as confusion and repeats. Also, fragmented transcripts cause duplicate Groq calls.

**Fix:** Debounce (bug #6) plus prompt update: "When the employee acknowledges with 'okay', 'got it', 'sure', etc., do NOT repeat what you just said. Wait for their next question."

### 8. "2L" spoken literally by TTS
**Both calls:** Cartesia says "two ell" instead of "two liter."

**Fix:** Add text normalization before Cartesia TTS. Replace common abbreviations:
- `2L` → `two liter`
- `12 count` → `twelve count`
- `Apt` → `Apartment`
- `TX` → `Texas`

### 9. Agent argues about math / corrects employee
**Call 4dc7b33e, action #17:** "That's not correct. The pizza is $18.50 and the garlic bread is $6.99, so the total should be $25.49. Actually, that's correct."
**Call 13fc0427, action #19:** "That's less than I expected. My total was $28.98, but I think there might be some mistake..."

**Fix:** Prompt update: "Never argue about prices or totals with the employee. Accept the numbers they give you. They have the register, you don't."

### 10. Rejected acceptable topping (onion) in call 4dc7b33e
The agent rejected onion even though it's in `acceptable_topping_subs`. The rule engine flagged `unnecessary_rejection` but allowed it.

**Call 13fc0427:** This was better — agent accepted onion.

**Fix:** Prompt update: "When a topping is in your acceptable substitutions list, you MUST accept it. These are pre-approved by the customer."

### 11. Concurrent Groq requests on fragmented transcripts
**Call 13fc0427, actions #4-5:** Two Groq requests fired simultaneously because "What about the" and "delivery address?" came as separate final transcripts milliseconds apart. Both returned `repeat_field` with the same address, and the agent spoke it twice.

**Fix:** The debounce timer (bug #6) will prevent this. Also add a guard: don't send a new Groq request while one is in-flight.

---

## P2 — Polish

### 12. Agent says "Can I get the price for that?" on every item
Nearly every response includes "Can I get the price for that?" — sounds robotic.

**Fix:** Prompt tuning — vary the phrasing, or only ask for price when the employee hasn't offered it.

### 13. Agent confirms with redundant detail
Action #22 in call 13fc0427: "Okay, so the delivery time is 35 minutes and the order number is 4412. My total comes out to be $28.98, which is within my budget of $45. Before I complete the order, I just need to let you know that I have a special instruction..."

This is unnaturally verbose for a phone call.

**Fix:** Prompt update: "Keep responses short and natural. Don't repeat back every detail. Just acknowledge and move to the next thing."

### 14. Outcome is `nothing_available` when it should infer `completed`
When the far end hangs up (Twilio status: completed), `endCall()` defaults to `nothing_available`. But if `pizzaConfirmed` and `specialInstructionsDelivered` are true, it should infer `completed`.

**Fix:** In `endCall()`, check the order state before defaulting. If key fields are filled, use `completed`.

---

## Fix Implementation Order

1. **Idempotent price updates** (P0 #2, fixes #5 cascading) — `conversation-engine.ts`
2. **Debounce transcript handler** (P1 #6, fixes #7, #11) — `call-session-manager.ts`
3. **Prompt overhaul** (P0 #1, #4, P1 #9, #10, #12, #13) — `prompts.ts`
4. **Text normalization for TTS** (P1 #8) — new utility or in `audio-bridge.ts`
5. **Post-confirm auto-hangup** (P0 #3) — `call-session-manager.ts`
6. **Infer outcome from order state** (P2 #14) — `call-session-manager.ts`
7. **In-flight Groq guard** (P1 #11) — `call-session-manager.ts`
