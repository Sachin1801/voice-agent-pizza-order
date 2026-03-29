/**
 * Minimal config for debug mode.
 *
 * Only validates what the debug tool actually needs (GROQ_API_KEY + GROQ_MODEL).
 * Unlike the production config.ts, this does NOT require Twilio, Deepgram,
 * or Cartesia credentials — those services are bypassed in debug mode.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const debugConfigSchema = z.object({
  groqApiKey: z.string().min(1, 'GROQ_API_KEY is required'),
  groqModel: z.string().default('llama-3.3-70b-versatile'),
  debugPort: z.coerce.number().int().positive().default(4100),
  artifactsDir: z.string().default('./data/runs'),
  rulesFile: z.string().default('./data/debug-rules.json'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type DebugConfig = z.infer<typeof debugConfigSchema>;

let _config: DebugConfig | null = null;

export function loadDebugConfig(overrides?: Partial<DebugConfig>): DebugConfig {
  const raw = {
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL,
    debugPort: overrides?.debugPort ?? process.env.DEBUG_PORT,
    artifactsDir: process.env.ARTIFACTS_DIR,
    rulesFile: process.env.DEBUG_RULES_FILE,
    logLevel: process.env.LOG_LEVEL,
    ...overrides,
  };

  const result = debugConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Debug config validation failed:\n${issues}`);
  }

  _config = result.data;
  return _config;
}

export function getDebugConfig(): DebugConfig {
  if (!_config) {
    throw new Error('Debug config not loaded. Call loadDebugConfig() first.');
  }
  return _config;
}
