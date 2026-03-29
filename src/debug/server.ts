/**
 * Debug Server.
 *
 * Lightweight Express HTTP server for the voice-debug CLI.
 * Holds one DebugSession in memory and exposes routes for
 * all debug commands (send, rewind, state, rules, replay, etc.).
 *
 * Started by the CLI's `start` command and stopped by `stop`.
 */

import express, { Request, Response, NextFunction } from 'express';
import { DebugSession } from './session/debug-session';
import { loadDebugConfig, DebugConfig } from './config/debug-config';
import { OrderRequest, OrderRequestSchema } from '../types';
import { DebugResponse } from './types';
import { createSessionRoutes } from './routes/session';
import { createConversationRoutes } from './routes/conversation';
import { createStateRoutes } from './routes/state';
import { createRulesRoutes } from './routes/rules';
import { createPromptRoutes } from './routes/prompt';
import { createIVRRoutes } from './routes/ivr';
import { createReplayRoutes } from './routes/replay';
import fs from 'fs';
import path from 'path';

// ─── Global session state ──────────────────────────────────────────────────

let session: DebugSession | null = null;

export function getSession(): DebugSession | null {
  return session;
}

export function setSession(s: DebugSession | null): void {
  session = s;
}

// ─── Response helpers ──────────────────────────────────────────────────────

export function respond<T>(res: Response, command: string, data: T): void {
  const response: DebugResponse<T> = {
    success: true,
    command,
    timestamp: new Date().toISOString(),
    data,
  };
  res.json(response);
}

export function respondError(res: Response, command: string, error: string, status = 400): void {
  const response: DebugResponse = {
    success: false,
    command,
    timestamp: new Date().toISOString(),
    error,
  };
  res.status(status).json(response);
}

// ─── Session guard middleware ──────────────────────────────────────────────

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!session) {
    respondError(res, req.path, "No active session. Run 'voice-debug start --order <file>' first.", 400);
    return;
  }
  next();
}

// ─── Server setup ──────────────────────────────────────────────────────────

export function createDebugServer(config: DebugConfig): express.Express {
  const app = express();
  app.use(express.json());

  // Health check (no session required)
  app.get('/api/health', (_req, res) => {
    respond(res, 'health', {
      status: 'ok',
      session_active: session !== null,
      session_id: session?.sessionId ?? null,
    });
  });

  // Register route modules
  createSessionRoutes(app, config);
  createConversationRoutes(app);
  createStateRoutes(app);
  createRulesRoutes(app);
  createPromptRoutes(app);
  createIVRRoutes(app);
  createReplayRoutes(app, config);

  // 404 handler
  app.use((_req, res) => {
    respondError(res, 'unknown', 'Unknown endpoint. Use GET /api/health to check server status.', 404);
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    respondError(res, 'error', err.message, 500);
  });

  return app;
}

// ─── Start server (called directly or by CLI) ─────────────────────────────

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const portOverride = portArg ? parseInt(portArg.split('=')[1], 10) : undefined;

  const config = loadDebugConfig({ debugPort: portOverride });
  const app = createDebugServer(config);

  const server = app.listen(config.debugPort, () => {
    const info = {
      status: 'running',
      port: config.debugPort,
      pid: process.pid,
      model: config.groqModel,
    };
    // Write lockfile for CLI discovery
    const lockfilePath = path.resolve('./data/.debug-server.json');
    fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
    fs.writeFileSync(lockfilePath, JSON.stringify(info, null, 2));

    console.log(JSON.stringify({
      success: true,
      command: 'server.started',
      timestamp: new Date().toISOString(),
      data: info,
    }));
  });

  // Cleanup on exit
  const cleanup = () => {
    const lockfilePath = path.resolve('./data/.debug-server.json');
    try { fs.unlinkSync(lockfilePath); } catch { /* ignore */ }
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
