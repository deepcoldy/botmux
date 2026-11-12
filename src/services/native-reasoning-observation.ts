import type { CodexReasoningEffort } from './codex-reasoning-effort.js';

export type ObservedReasoningCli = 'codex' | 'traex' | 'grok' | 'antigravity';
export type NativeReasoningSource = 'native-settings' | 'native-footer' | 'native-summary' | 'acp-config';
export interface NativeReasoningObservation {
  cliId: ObservedReasoningCli;
  nativeSessionId: string;
  reasoningEffort: CodexReasoningEffort | null;
  source: NativeReasoningSource;
  /** Time of the native ACK/file write or the start of its viewport capture. */
  observedAtMs?: number;
  cliSpawnGeneration?: number;
  /** Only Grok uses this field; the other CLIs retain their model observer. */
  model?: string;
}

export function isNativeReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra';
}

export interface AppliedReasoningSelection {
  reasoningEffort: CodexReasoningEffort | null;
  atMs: number;
  nativeSessionId?: string;
}

/** A native settings ACK is a selection, not proof that an already-running
 * turn changed effort. Never harvest commands or settings quoted in messages. */
export function appliedReasoningSelectionFromRecord(obj: any): AppliedReasoningSelection | undefined {
  if (obj?.type !== 'event_msg' || obj.payload?.type !== 'thread_settings_applied') return;
  const raw = obj.payload.thread_settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const collaboration = raw.collaboration_mode?.settings;
  const own = Object.hasOwn(raw, 'reasoning_effort');
  const nested = collaboration && typeof collaboration === 'object'
    && Object.hasOwn(collaboration, 'reasoning_effort');
  // /fast's partial ACK must not erase the selected effort.
  if (!own && !nested && !(typeof raw.model === 'string' && raw.model.trim())) return;
  const value = own ? raw.reasoning_effort : nested ? collaboration.reasoning_effort : null;
  if (value !== null && value !== 'default' && !isNativeReasoningEffort(value)) return;
  const atMs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (!Number.isFinite(atMs) || atMs <= 0) return;
  const nativeSessionId = obj.payload.thread_id;
  if (nativeSessionId !== undefined && (typeof nativeSessionId !== 'string' || !nativeSessionId)) return;
  return { reasoningEffort: isNativeReasoningEffort(value) ? value : null, atMs,
    ...(nativeSessionId ? { nativeSessionId } : {}) };
}
