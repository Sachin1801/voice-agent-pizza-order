import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const configSchema = z.object({
  // Server
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().int().positive().default(3000),
  publicBaseUrl: z.string().url(),
  publicWsBaseUrl: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Twilio
  twilioAccountSid: z.string().startsWith('AC'),
  twilioAuthToken: z.string().min(1),
  twilioPhoneNumber: z.string().startsWith('+'),
  defaultTargetNumber: z.string().startsWith('+').optional(),

  // Providers
  deepgramApiKey: z.string().min(1),
  groqApiKey: z.string().min(1),
  groqModel: z.string().default('llama-3.3-70b-versatile'),
  cartesiaApiKey: z.string().min(1),
  cartesiaModelId: z.string().default('sonic-3'),
  cartesiaVoiceId: z.string().min(1),

  // Artifacts
  enableAudioRecording: z.coerce.boolean().default(false),
  artifactsDir: z.string().default('./data/runs'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const raw = {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    publicWsBaseUrl: process.env.PUBLIC_WS_BASE_URL,
    logLevel: process.env.LOG_LEVEL,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
    defaultTargetNumber: process.env.DEFAULT_TARGET_NUMBER,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    groqModel: process.env.GROQ_MODEL,
    cartesiaApiKey: process.env.CARTESIA_API_KEY,
    cartesiaModelId: process.env.CARTESIA_MODEL_ID,
    cartesiaVoiceId: process.env.CARTESIA_VOICE_ID,
    enableAudioRecording: process.env.ENABLE_AUDIO_RECORDING,
    artifactsDir: process.env.ARTIFACTS_DIR,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const missing = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.message}`
    );
    console.error('[config] ✗ Environment validation failed:');
    missing.forEach((m) => console.error(m));
    console.error(
      '\n[config] Copy .env.example to .env and fill in the required values.'
    );
    process.exit(1);
  }

  // Log config loaded successfully (redacted)
  const redactedKeys = [
    'twilioAuthToken',
    'deepgramApiKey',
    'groqApiKey',
    'cartesiaApiKey',
  ];
  const redacted = Object.fromEntries(
    Object.entries(result.data).map(([k, v]) => [
      k,
      redactedKeys.includes(k)
        ? `${String(v).slice(0, 4)}****`
        : v,
    ])
  );

  console.log('[config] ✓ Environment validated successfully');
  console.log('[config]   Loaded:', JSON.stringify(redacted, null, 2));

  return result.data;
}

export const config = loadConfig();
