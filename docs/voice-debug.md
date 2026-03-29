# voice-debug: Intelligence Layer Debug CLI

A terminal tool for debugging the Groq LLM intelligence layer of the VoiceAgent pizza ordering system. Designed for AI agent operators (Claude Code / Codex sessions) — all output is structured JSON.

## Quick Start

```bash
# 1. Start the debug server with a test order
npx ts-node src/debug/cli.ts start --order scripts/test-order.json

# 2. Send an employee message and see the full pipeline diagnostic
npx ts-node src/debug/cli.ts send "Hi, welcome to Pizza Place! What can I get for you?"

# 3. Check the current order state
npx ts-node src/debug/cli.ts state

# 4. Stop the server when done
npx ts-node src/debug/cli.ts stop
```

Or use npm scripts:
```bash
npm run debug -- start --order scripts/test-order.json
npm run debug -- send "Hi, what can I get started for you?"
npm run debug -- stop
```

---

## Architecture

```
CLI (voice-debug)  ──HTTP──>  Debug Server (Express, localhost:4100)
                                    │
                                    ├── DebugConversationEngine
                                    │     ├── buildSystemPrompt() + debug rules
                                    │     ├── Groq API (real LLM calls)
                                    │     ├── ActionValidator (Zod)
                                    │     └── RuleEngine (business rules)
                                    │
                                    ├── RulesManager (data/debug-rules.json)
                                    ├── IVR Runner (IVRStateMachine)
                                    └── Replay Runner (data/runs/*)
```

**Key design**: The CLI is stateless — each command is one HTTP request. The server holds all session state in memory. Server discovery is via lockfile at `data/.debug-server.json`.

---

## Command Reference

### `start` — Start a debug session

```bash
npx ts-node src/debug/cli.ts start --order <path> [--port 4100]
```

Spawns the debug server as a background process, loads the order, and creates a session.

**Example response:**
```json
{
  "success": true,
  "command": "start",
  "timestamp": "2026-03-29T16:00:00.000Z",
  "data": {
    "session_id": "a1b2c3d4",
    "order_summary": {
      "customer_name": "Jordan Mitchell",
      "pizza": "large thin, pepperoni, mushroom, green pepper",
      "side": "buffalo wings, 12 count",
      "drink": "2L Coke",
      "budget_max": 45
    },
    "port": 4100,
    "groq_model": "llama-3.3-70b-versatile",
    "rules_loaded": 0
  }
}
```

---

### `send` — Send employee text

```bash
npx ts-node src/debug/cli.ts send "That'll be $18.50 for the large pepperoni"
```

Sends text as if the pizza shop employee said it. Returns the **full pipeline diagnostic**: what was sent to Groq, what came back, validation, rule engine decision, and the final speech.

**Example response:**
```json
{
  "success": true,
  "command": "send",
  "timestamp": "2026-03-29T16:01:00.000Z",
  "data": {
    "turn_number": 1,
    "input": "That'll be $18.50 for the large pepperoni",
    "pipeline": {
      "system_prompt": "You are a voice agent placing a pizza...",
      "system_prompt_length": 2847,
      "debug_rules_injected": [],
      "context_prompt": "## Current Order State\n- Pizza confirmed: false...",
      "groq_request": {
        "model": "llama-3.3-70b-versatile",
        "temperature": 0.3,
        "max_tokens": 300,
        "messages_count": 2
      },
      "groq_response_raw": "{\"action\":\"say\",\"text\":\"Got it...\",\"heard_price\":{\"item\":\"pizza\",\"price\":18.50}}",
      "groq_response_parsed": {
        "action": "say",
        "text": "Got it, so that's $18.50 for the large pepperoni. Can I also get a 12 count buffalo wings?",
        "heard_price": { "item": "pizza", "price": 18.50 }
      },
      "groq_latency_ms": 234,
      "groq_tokens": { "prompt": 1200, "completion": 85, "total": 1285 },
      "groq_finish_reason": "stop",
      "groq_error": null,
      "validation": { "valid": true, "error": null },
      "rule_engine": { "allowed": true, "reason": "No rule violations", "modification": null },
      "final_speech": "Got it, so that's $18.50 for the large pepperoni. Can I also get a 12 count buffalo wings?",
      "action_type": "say"
    },
    "state": {
      "pizza_confirmed": true,
      "pizza_price": 18.50,
      "side_confirmed": false,
      "drink_confirmed": false,
      "running_total": 18.50,
      "substitutions": {},
      "delivery_time": null,
      "order_number": null,
      "special_instructions_delivered": false
    },
    "history_length": 2,
    "session_uptime_ms": 60000
  }
}
```

**Key fields for debugging:**
- `pipeline.groq_response_raw` — Exact text Groq returned (check for malformed JSON)
- `pipeline.groq_response_parsed` — Parsed action (check for hallucinated data)
- `pipeline.validation` — Did the JSON parse and validate correctly?
- `pipeline.rule_engine` — Did business rules allow or block the action?
- `pipeline.final_speech` — What the agent would actually say on a real call
- `pipeline.debug_rules_injected` — Which custom rules were active
- `state` — Current order tracking state after this turn

---

### `state` — Get current state

```bash
npx ts-node src/debug/cli.ts state
```

Returns the full conversation history and order state.

---

### `rewind` — Go back N turns

```bash
npx ts-node src/debug/cli.ts rewind 2
```

Removes the last N conversation turns (each turn = 1 employee message + 1 agent response). Use this to retry a different employee message from an earlier point.

---

### `rules list` — List active rules

```bash
npx ts-node src/debug/cli.ts rules list
```

---

### `rules add` — Add a behavioral rule

```bash
npx ts-node src/debug/cli.ts rules add "Never repeat the exact same response text you used in the previous turn"
npx ts-node src/debug/cli.ts rules add "Always ask for exact price when employee gives vague amount" --category=pricing
```

Rules are saved to `data/debug-rules.json` and injected into the system prompt **immediately** (hot-reloaded on every Groq call). They persist across sessions.

---

### `rules remove` — Remove a rule

```bash
npx ts-node src/debug/cli.ts rules remove rule-1743292800000
```

---

### `replay` — Replay a past call

```bash
npx ts-node src/debug/cli.ts replay 13fc0427
```

Loads a past call from `data/runs/<call-id>/`, extracts employee turns from `transcript.jsonl`, and feeds them through the **current** prompt and rules. Returns a turn-by-turn comparison of original vs. new behavior.

**Key response fields per turn:**
- `original_action` — What the LLM did on the actual call
- `current.pipeline` — Full diagnostic of what it would do NOW
- `diff.action_type_match` — Did the action type change?
- `diff.text_similarity` — Jaccard word similarity (0.0-1.0)

**Available call IDs:** List contents of `data/runs/` directory.

---

### `prompt view` — View the full system prompt

```bash
npx ts-node src/debug/cli.ts prompt view
```

Shows the complete prompt being sent to Groq: base system prompt + debug rules block + session override.

---

### `prompt edit` — Set a session prompt override

```bash
npx ts-node src/debug/cli.ts prompt edit "When confirming prices, always repeat the item name and exact dollar amount"
```

Appends text to the system prompt for this session only. Does NOT modify `prompts.ts`. Use `session reset` to clear.

---

### `ivr` — Run IVR auto-play

```bash
npx ts-node src/debug/cli.ts ivr
```

Runs a scripted IVR sequence through the state machine. Shows each step: what the IVR said, which pattern matched, what the agent responded, and the state transitions.

---

### `session info` — Session metadata

```bash
npx ts-node src/debug/cli.ts session info
```

---

### `session reset` — Reset session

```bash
npx ts-node src/debug/cli.ts session reset
```

Clears conversation history, resets order state, and removes prompt override. Keeps the same order and rules.

---

### `stop` — Stop the server

```bash
npx ts-node src/debug/cli.ts stop
```

---

## Response Schema

Every response follows this envelope:

```typescript
interface DebugResponse<T> {
  success: boolean;        // true on success, false on error
  command: string;         // e.g. "send", "rules.add", "replay"
  timestamp: string;       // ISO 8601
  error?: string;          // only present on failure
  data?: T;                // command-specific payload
}
```

---

## Rules File Format

Location: `data/debug-rules.json`

```json
[
  {
    "id": "rule-1743292800000",
    "rule": "Never repeat the same response text you used in the previous turn",
    "category": "behavior",
    "added_by": "agent",
    "timestamp": "2026-03-29T12:00:00.000Z"
  }
]
```

Rules are injected into the system prompt as:
```
## Additional Debug Rules
These rules MUST be followed strictly:
- [rule-1743292800000] Never repeat the same response text you used in the previous turn
```

---

## Debugging Workflows

### Debugging Repetition

The LLM is saying the same thing repeatedly.

1. Start a session and send a few employee messages to reproduce the issue:
   ```bash
   voice-debug send "Hi, what can I get for you?"
   voice-debug send "Okay, what size pizza?"
   voice-debug send "What toppings?"
   ```

2. Check if responses in `pipeline.final_speech` are identical or very similar across turns.

3. Examine `pipeline.context_prompt` — does the conversation history show the repetition? The LLM sees the last 20 turns, so if it's already repeating in context, that's the loop.

4. Add a rule to fix it:
   ```bash
   voice-debug rules add "Never repeat the exact same response text from any previous turn. If you find yourself about to repeat, acknowledge what the employee said differently."
   ```

5. Rewind and retry:
   ```bash
   voice-debug rewind 3
   voice-debug send "Hi, what can I get for you?"
   ```

6. Check if `pipeline.debug_rules_injected` shows the new rule and if the response is different.

### Debugging Hallucination

The LLM is inventing prices, items, or details not mentioned by the employee.

1. Send a message and check `pipeline.groq_response_parsed`:
   ```bash
   voice-debug send "Sure, we can do a large pepperoni"
   ```

2. Compare `data.input` (what the employee said) with `pipeline.groq_response_parsed.heard_price` — did the LLM invent a price?

3. Check `pipeline.context_prompt` — what state information was sent to the LLM? Was there a price in the context it might have confused?

4. Add a rule:
   ```bash
   voice-debug rules add "Only include heard_price when the employee explicitly states a dollar amount. Never infer or guess prices."
   ```

5. Rewind and retry to verify the fix.

### Testing a Prompt Change

1. View the current prompt:
   ```bash
   voice-debug prompt view
   ```

2. Add a session override:
   ```bash
   voice-debug prompt edit "After each price confirmation, summarize all confirmed items and the running total."
   ```

3. Send messages and observe the effect in `pipeline.final_speech`.

4. If the change works, convert it to a permanent rule or edit `src/conversation/prompts.ts`.

### Replaying a Past Call

1. Pick a problematic call ID from `data/runs/`:
   ```bash
   ls data/runs/
   ```

2. Add rules you think would fix the issue:
   ```bash
   voice-debug rules add "Never confirm a price without the employee explicitly stating a dollar amount"
   ```

3. Replay the call:
   ```bash
   voice-debug replay 13fc0427
   ```

4. Examine each turn's `diff` to see where behavior changed:
   - `diff.action_type_match: false` — the LLM chose a different action type
   - `diff.text_similarity < 0.5` — the response text changed significantly

---

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `No active session` | No `start` command run yet | Run `voice-debug start --order <file>` |
| `Debug server not running` | Server not started or crashed | Run `voice-debug start --order <file>` |
| `Order validation failed` | Invalid order JSON | Check the order file against the schema in `src/types.ts` |
| `GROQ_API_KEY is required` | Missing API key | Add `GROQ_API_KEY=...` to `.env` |
| `Groq request failed` | Groq API error (rate limit, auth) | Check API key, wait for rate limit reset |
| `Call artifacts not found` | Invalid call ID for replay | List available calls with `ls data/runs/` |
| `Server already running` | Duplicate start | Run `voice-debug stop` first |

---

## Order File Format

The order file must match the `OrderRequest` schema from `src/types.ts`:

```json
{
  "customer_name": "Jordan Mitchell",
  "phone_number": "5125550147",
  "delivery_address": "4821 Elm Street, Apt 3B, Austin, TX 78745",
  "pizza": {
    "size": "large",
    "crust": "thin",
    "toppings": ["pepperoni", "mushroom", "green pepper"],
    "acceptable_topping_subs": ["sausage", "bacon", "onion", "spinach", "jalapeno"],
    "no_go_toppings": ["olives", "anchovies", "pineapple"]
  },
  "side": {
    "first_choice": "buffalo wings, 12 count",
    "backup_options": ["garlic bread", "breadsticks", "mozzarella sticks"],
    "if_all_unavailable": "skip"
  },
  "drink": {
    "first_choice": "2L Coke",
    "alternatives": ["2L Pepsi", "2L Sprite"],
    "skip_if_over_budget": true
  },
  "budget_max": 45.00,
  "special_instructions": "Ring doorbell, don't knock (baby sleeping)"
}
```

---

## Pipeline Data Flow

When you run `voice-debug send "text"`, this is exactly what happens:

```
1. Employee text added to conversation history
2. buildSystemPrompt(order) → base system prompt
3. Append debug rules from data/debug-rules.json
4. Append session prompt override (if set)
5. buildConversationContext(history, orderState) → context with last 20 turns
6. Groq API call:
   - model: llama-3.3-70b-versatile
   - messages: [system prompt, context]
   - temperature: 0.3
   - max_tokens: 300
   - response_format: json_object
7. Parse raw response → JSON action
8. ActionValidator.validate() → Zod schema check
9. RuleEngine.evaluate() → business rule check
10. Update order state (prices, subs, etc.)
11. Return full diagnostic with all intermediate values
```

Every value from steps 2-11 is captured and returned in the response.
