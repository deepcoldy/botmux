export const TRAEX_MODEL_ACCESS_ERROR_CODE = 'traex_model_access_restricted';

/** Inspect only a failed native terminal's error, never user/tool/screen text.
 * Generic 502s and account authentication failures retain their own policy. */
export function isTraexModelAccessError(error: unknown): boolean {
  let value = error;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof value === 'string') {
      if (value.length > 8_192) return false;
      const message = value;
      try { value = JSON.parse(message); } catch {
        return /^(?:(?:stream disconnected before completion|unexpected status 502(?: Bad Gateway)?|TRAE returned HTTP 502):\s*)?Model access temporarily restricted\.(?:,\s*url:\s*https?:\/\/\S+)?$/i.test(message.trim());
      }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.error !== undefined) value = record.error;
    else if (typeof record.message === 'string') value = record.message;
    else return false;
  }
  return false;
}
