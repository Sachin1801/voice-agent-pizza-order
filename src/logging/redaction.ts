/**
 * Redaction utilities for privacy-safe logging.
 *
 * Raw artifacts stay private under data/runs/{call_id}/.
 * Redacted versions mask secrets, names, phones, and addresses
 * for sharing with external agents or broader review.
 */

// ─── Patterns to detect sensitive data ──────────────────────────────────────

const PHONE_PATTERN = /\b(\+?1?\d{10,11})\b/g;
const EMAIL_PATTERN = /\b[\w.-]+@[\w.-]+\.\w+\b/g;
const ZIP_PATTERN = /\b\d{5}(-\d{4})?\b/g;

// Keys whose values should always be masked in redacted output
const SENSITIVE_KEYS = new Set([
  'twilioAuthToken',
  'deepgramApiKey',
  'groqApiKey',
  'cartesiaApiKey',
  'phone_number',
  'callback_number',
  'delivery_address',
  'customer_name',
]);

// ─── Redaction functions ────────────────────────────────────────────────────

/** Mask a string, preserving first N and last M characters */
export function maskString(value: string, keepFirst = 2, keepLast = 2): string {
  if (value.length <= keepFirst + keepLast + 2) {
    return '****';
  }
  return value.slice(0, keepFirst) + '****' + value.slice(-keepLast);
}

/** Mask a phone number: +1512****47 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return phone.slice(0, 4) + '****' + phone.slice(-2);
}

/** Redact sensitive values from a string */
export function redactString(text: string): string {
  return text
    .replace(PHONE_PATTERN, (match) => maskPhone(match))
    .replace(EMAIL_PATTERN, '****@****.***');
}

/** Deep-redact an object, masking known sensitive keys and patterns in string values */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactString(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key) && typeof value === 'string') {
        result[key] = maskString(value);
      } else {
        result[key] = redactObject(value);
      }
    }
    return result as T;
  }

  return obj;
}

/** Check if a key is sensitive */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}
