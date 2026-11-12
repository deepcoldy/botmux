import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isNativeReasoningEffort, type NativeReasoningObservation } from './native-reasoning-observation.js';

function snapshot(path: string, now: number, notBefore: number): { data: Record<string, any>; mtimeMs: number } | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024 || Math.floor(stat.mtimeMs) > now
      || Math.floor(stat.mtimeMs) < notBefore
      || stat.mtimeMs < now - 10 * 60_000) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data, mtimeMs: stat.mtimeMs };
  } catch { /* missing/stale data means unknown runtime, never a guessed level */ }
}

/** Grok rewrites per-session summary.current_model_id/reasoning_effort and
 * signals.primaryModelId. These small native files do not depend on usageDisplay. */
export function readGrokRuntimeObservation(
  sessionDir: string, nativeSessionId: string, now = Date.now(), notBefore = 0,
): NativeReasoningObservation {
  const unknown: NativeReasoningObservation = { cliId: 'grok', nativeSessionId,
    reasoningEffort: null, source: 'native-summary' };
  if (!nativeSessionId || basename(sessionDir) !== nativeSessionId) return unknown;
  const summary = snapshot(join(sessionDir, 'summary.json'), now, notBefore);
  const signals = snapshot(join(sessionDir, 'signals.json'), now, notBefore);
  if (!summary && !signals) return unknown;
  for (const item of [summary, signals]) {
    const id = item?.data.session_id ?? item?.data.id;
    if (id !== undefined && id !== nativeSessionId) return unknown;
  }
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const summaryModel = text(summary?.data.current_model_id);
  const signalModel = text(signals?.data.primaryModelId);
  const model = signals && (!summary || signals.mtimeMs > summary.mtimeMs)
    ? signalModel ?? summaryModel : summaryModel ?? signalModel;
  const effort = summary?.data.reasoning_effort;
  return { ...unknown, ...(model ? { model } : {}),
    observedAtMs: Math.floor(Math.max(summary?.mtimeMs ?? 0, signals?.mtimeMs ?? 0)),
    reasoningEffort: isNativeReasoningEffort(effort) ? effort : null };
}
