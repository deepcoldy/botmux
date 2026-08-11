/** `session_meta.source` is the protocol-level origin. Internal/subagent
 * sessions are runtime helpers rather than the user's visible top-level task. */
export function isInternalCodexSessionMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const payload = meta as Record<string, unknown>;
  if (typeof payload.thread_source === 'string' && payload.thread_source !== 'user') return true;
  const source = payload.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  return sourceRecord.internal !== undefined || sourceRecord.subagent !== undefined;
}
