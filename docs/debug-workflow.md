# LLM Debugging Workflow

How to use the `voice-debug` CLI to reproduce issues, diagnose root causes, and verify fixes — designed for Claude Code and Codex sessions.

## Prerequisites

```bash
# Start the debug server (run once)
npx ts-node src/debug/cli.ts start --order scripts/test-order.json
```

## Workflow: Reproduce → Diagnose → Fix → Verify

### Step 1: Reproduce the issue

You've been given a description of what went wrong on a real call (e.g., "the agent repeated itself on turns 5-8" or "the agent hallucinated a price"). Simulate it:

```bash
# Play out the employee side of the conversation
npx ts-node src/debug/cli.ts send "Hi welcome, what can I get for you?"
npx ts-node src/debug/cli.ts send "Okay what size pizza?"
npx ts-node src/debug/cli.ts send "We're out of mushroom, how about olives?"
```

Or replay a real past call:
```bash
# List available calls
ls data/runs/

# Replay a specific call through the current pipeline
npx ts-node src/debug/cli.ts replay 13fc0427
```

### Step 2: Diagnose the root cause

For each response, examine the full pipeline diagnostic:

```bash
# After each send, check:
# 1. pipeline.groq_response_parsed — what the LLM actually returned
# 2. pipeline.context_prompt — what context the LLM saw (does it explain the bad behavior?)
# 3. pipeline.rule_engine — did the rule engine catch or miss anything?
# 4. pipeline.system_prompt — are the instructions clear enough?
# 5. state — is the order state tracking correctly?
```

**Common patterns:**

| Symptom | What to check | Likely cause |
|---------|--------------|--------------|
| Agent repeats itself | `pipeline.context_prompt` — are previous responses visible? | LLM ignoring conversation history; needs explicit anti-repetition rule |
| Agent hallucinated a price | `pipeline.groq_response_parsed.heard_price` vs `data.input` | LLM invented a price not stated by employee; needs stricter extraction rule |
| Agent accepted forbidden topping | `pipeline.rule_engine` | Rule engine should have blocked it; check if the topping name matched the no-go list |
| Agent gave too-long response | `pipeline.groq_response_parsed.text` | System prompt behavior section needs "keep it short" reinforcement |
| Agent tried to complete too early | `pipeline.rule_engine.reason` | Rule engine should block with specific reason; check OrderState |

### Step 3: Apply a fix

**Option A: Add a debug rule** (fastest, persists across sessions):
```bash
npx ts-node src/debug/cli.ts rules add "Never repeat the exact same response text from any previous turn. If you would repeat, acknowledge differently."
```

**Option B: Edit the prompt** (session-scoped override):
```bash
npx ts-node src/debug/cli.ts prompt edit "When confirming prices, always explicitly state the item name and exact dollar amount. Never infer prices."
```

**Option C: Modify production code** (permanent, requires code change):
Edit `src/conversation/prompts.ts` or `src/conversation/rule-engine.ts` directly, then restart:
```bash
npx ts-node src/debug/cli.ts session reset
```

### Step 4: Verify the fix

**Method A: Rewind and retry**
```bash
# Go back to before the problematic turn
npx ts-node src/debug/cli.ts rewind 3

# Re-send the same employee message
npx ts-node src/debug/cli.ts send "We're out of mushroom, how about olives?"

# Check: Is pipeline.final_speech different and correct now?
# Check: Does pipeline.debug_rules_injected show the new rule?
```

**Method B: Replay the full call**
```bash
npx ts-node src/debug/cli.ts replay 13fc0427

# For each turn in the response, check:
# - diff.action_type_match — did the action type change?
# - diff.text_similarity — how different is the text? (< 0.5 = very different)
# - current.pipeline.debug_rules_injected — was the rule active?
```

**Method C: Fresh session test**
```bash
npx ts-node src/debug/cli.ts session reset
npx ts-node src/debug/cli.ts send "Hi, what would you like to order?"
# ... continue full conversation
```

### Step 5: Report findings

After debugging, produce a structured report:

```
## Issue: [description]

### Reproduction
- Sent: "[employee message]"
- Got: "[agent response]" (action_type: say)
- Expected: "[what should have happened]"

### Root Cause
[What the LLM saw in context that caused the wrong behavior]

### Fix Applied
- Rule added: "[rule text]" (rule ID: rule-XXXXX)
- OR: Prompt modified in prompts.ts: [description of change]
- OR: Rule engine updated in rule-engine.ts: [description of change]

### Verification
- Rewind + retry: [response after fix]
- Replay call 13fc0427: [N turns changed, text similarity dropped from X to Y on turn Z]
```

---

## Quick Reference: All Commands

```bash
# Session lifecycle
npx ts-node src/debug/cli.ts start --order scripts/test-order.json
npx ts-node src/debug/cli.ts stop
npx ts-node src/debug/cli.ts session info
npx ts-node src/debug/cli.ts session reset

# Conversation
npx ts-node src/debug/cli.ts send "employee message here"
npx ts-node src/debug/cli.ts rewind 2
npx ts-node src/debug/cli.ts state

# Rules
npx ts-node src/debug/cli.ts rules list
npx ts-node src/debug/cli.ts rules add "rule text"
npx ts-node src/debug/cli.ts rules remove rule-XXXXX

# Analysis
npx ts-node src/debug/cli.ts replay <call-id>
npx ts-node src/debug/cli.ts prompt view
npx ts-node src/debug/cli.ts prompt edit "override text"
npx ts-node src/debug/cli.ts ivr
```
