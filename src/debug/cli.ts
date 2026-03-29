/**
 * voice-debug CLI.
 *
 * Thin HTTP client that communicates with the debug server.
 * Designed for AI agents (Claude/Codex) to invoke via shell commands.
 * All output is structured JSON written to stdout.
 *
 * Usage:
 *   npx ts-node src/debug/cli.ts start --order scripts/test-order.json [--port 4100]
 *   npx ts-node src/debug/cli.ts send "Hi, what can I get for you?"
 *   npx ts-node src/debug/cli.ts state
 *   npx ts-node src/debug/cli.ts rewind 2
 *   npx ts-node src/debug/cli.ts rules list
 *   npx ts-node src/debug/cli.ts rules add "Never repeat yourself"
 *   npx ts-node src/debug/cli.ts rules remove rule-1743292800000
 *   npx ts-node src/debug/cli.ts replay 13fc0427
 *   npx ts-node src/debug/cli.ts prompt view
 *   npx ts-node src/debug/cli.ts prompt edit "Always confirm prices"
 *   npx ts-node src/debug/cli.ts session info
 *   npx ts-node src/debug/cli.ts session reset
 *   npx ts-node src/debug/cli.ts ivr
 *   npx ts-node src/debug/cli.ts stop
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const LOCKFILE_PATH = path.resolve('./data/.debug-server.json');
const DEFAULT_PORT = 4100;

// ─── Output helpers ────────────────────────────────────────────────────────

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function outputError(command: string, error: string): void {
  output({
    success: false,
    command,
    timestamp: new Date().toISOString(),
    error,
  });
  process.exit(1);
}

// ─── Server discovery ──────────────────────────────────────────────────────

function getServerInfo(): { port: number; pid: number } | null {
  if (!fs.existsSync(LOCKFILE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function getBaseUrl(): string {
  const info = getServerInfo();
  if (!info) {
    outputError('unknown', `Debug server not running. Start it with: voice-debug start --order <file>`);
    process.exit(1);
  }
  return `http://localhost:${info.port}`;
}

// ─── HTTP client ───────────────────────────────────────────────────────────

async function request(
  method: 'GET' | 'POST' | 'DELETE',
  endpoint: string,
  body?: unknown
): Promise<unknown> {
  const url = `${getBaseUrl()}${endpoint}`;

  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      outputError('unknown', `Could not connect to debug server on port. Is it running? Start with: voice-debug start --order <file>`);
    }
    outputError('unknown', `HTTP request failed: ${message}`);
    return null;
  }
}

// ─── Start command (special: spawns the server) ────────────────────────────

async function handleStart(args: string[]): Promise<void> {
  // Parse --order and --port flags
  let orderFile: string | null = null;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--order' && args[i + 1]) {
      orderFile = args[++i];
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--order=')) {
      orderFile = args[i].split('=')[1];
    } else if (args[i].startsWith('--port=')) {
      port = parseInt(args[i].split('=')[1], 10);
    }
  }

  if (!orderFile) {
    outputError('start', 'Missing --order flag. Usage: voice-debug start --order <path-to-order.json> [--port 4100]');
    return;
  }

  // Check if server is already running
  const existing = getServerInfo();
  if (existing) {
    try {
      const res = await fetch(`http://localhost:${existing.port}/api/health`);
      if (res.ok) {
        outputError('start', `Debug server already running on port ${existing.port} (pid ${existing.pid}). Stop it first with: voice-debug stop`);
        return;
      }
    } catch {
      // Server not actually running, stale lockfile — clean it up
      fs.unlinkSync(LOCKFILE_PATH);
    }
  }

  // Spawn the server process
  const serverArgs = [
    '--require', 'ts-node/register',
    path.resolve('./src/debug/server.ts'),
    `--port=${port}`,
  ];

  const child: ChildProcess = spawn('node', serverArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });

  child.unref();

  // Wait for the server to be ready (poll health endpoint)
  const startTime = Date.now();
  const timeout = 15000;
  let ready = false;

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Not ready yet
    }
  }

  if (!ready) {
    // Collect any stderr from the child process
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    await new Promise((r) => setTimeout(r, 500));

    outputError('start', `Server failed to start within ${timeout / 1000}s. ${stderr ? `Stderr: ${stderr}` : 'Check GROQ_API_KEY in .env'}`);
    return;
  }

  // Create session with the order file
  const result = await request('POST', '/api/start', { order_file: orderFile });
  output(result);
}

// ─── Command routing ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];

  if (!command) {
    outputError('help', `Usage: voice-debug <command> [args]

Commands:
  start --order <file> [--port 4100]  Start debug server with an order file
  stop                                 Stop the debug server
  send "<text>"                        Send employee text, get pipeline diagnostic
  ivr                                  Run IVR auto-play sequence (happy path)
  ivr test '<json>'                     Test custom transcripts through IVR state machine
  state                                Get current conversation and order state
  rewind <turns>                       Go back N turns in conversation
  rules list                           List active debug rules
  rules add "<rule>" [--category X]    Add a behavioral rule
  rules remove <id>                    Remove a rule by ID
  replay <call-id>                     Replay a past call with current rules
  prompt view                          View the full system prompt
  prompt edit "<text>"                 Set a session prompt override
  session info                         Get session metadata
  session reset                        Clear history and state`);
    return;
  }

  switch (command) {
    case 'start':
      await handleStart(args.slice(1));
      break;

    case 'stop':
      output(await request('POST', '/api/stop'));
      break;

    case 'send': {
      const text = args.slice(1).join(' ');
      if (!text) {
        outputError('send', 'Missing text. Usage: voice-debug send "What can I get for you?"');
        return;
      }
      output(await request('POST', '/api/send', { text }));
      break;
    }

    case 'ivr':
      if (subcommand === 'test') {
        const jsonArg = args.slice(2).join(' ');
        if (!jsonArg) {
          outputError('ivr.test', 'Usage: voice-debug ivr test \'[{"text":"Hi. Thank you for calling.","is_final":true}]\'');
          return;
        }
        try {
          const transcripts = JSON.parse(jsonArg);
          output(await request('POST', '/api/ivr/test', { transcripts }));
        } catch {
          outputError('ivr.test', 'Invalid JSON. Provide an array of {text, is_final} objects.');
        }
      } else {
        output(await request('POST', '/api/ivr'));
      }
      break;

    case 'state':
      output(await request('GET', '/api/state'));
      break;

    case 'rewind': {
      const turns = parseInt(subcommand, 10);
      if (isNaN(turns) || turns < 1) {
        outputError('rewind', 'Missing turns count. Usage: voice-debug rewind <number>');
        return;
      }
      output(await request('POST', '/api/rewind', { turns }));
      break;
    }

    case 'rules':
      switch (subcommand) {
        case 'list':
          output(await request('GET', '/api/rules'));
          break;
        case 'add': {
          const ruleText = args.slice(2).filter((a) => !a.startsWith('--')).join(' ');
          const categoryArg = args.find((a) => a.startsWith('--category='));
          const category = categoryArg ? categoryArg.split('=')[1] : undefined;
          if (!ruleText) {
            outputError('rules.add', 'Missing rule text. Usage: voice-debug rules add "Never repeat yourself"');
            return;
          }
          output(await request('POST', '/api/rules', { rule: ruleText, category }));
          break;
        }
        case 'remove': {
          const ruleId = args[2];
          if (!ruleId) {
            outputError('rules.remove', 'Missing rule ID. Usage: voice-debug rules remove <rule-id>');
            return;
          }
          output(await request('DELETE', `/api/rules/${ruleId}`));
          break;
        }
        default:
          outputError('rules', 'Unknown rules subcommand. Use: rules list | rules add | rules remove');
      }
      break;

    case 'replay': {
      const callId = subcommand;
      if (!callId) {
        outputError('replay', 'Missing call ID. Usage: voice-debug replay <call-id>');
        return;
      }
      output(await request('POST', '/api/replay', { call_id: callId }));
      break;
    }

    case 'prompt':
      switch (subcommand) {
        case 'view':
          output(await request('GET', '/api/prompt'));
          break;
        case 'edit': {
          const modification = args.slice(2).join(' ');
          if (!modification) {
            outputError('prompt.edit', 'Missing modification text. Usage: voice-debug prompt edit "Always confirm prices"');
            return;
          }
          output(await request('POST', '/api/prompt/edit', { modification }));
          break;
        }
        default:
          outputError('prompt', 'Unknown prompt subcommand. Use: prompt view | prompt edit');
      }
      break;

    case 'session':
      switch (subcommand) {
        case 'info':
          output(await request('GET', '/api/session/info'));
          break;
        case 'reset':
          output(await request('POST', '/api/session/reset'));
          break;
        default:
          outputError('session', 'Unknown session subcommand. Use: session info | session reset');
      }
      break;

    default:
      outputError('unknown', `Unknown command: "${command}". Run voice-debug without arguments for usage.`);
  }
}

main().catch((err) => {
  outputError('fatal', err instanceof Error ? err.message : 'Unknown fatal error');
});
