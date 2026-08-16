import { Buffer } from 'node:buffer';
import type { CodexAppTurnInput } from '../types.js';
import { isCodexAppTurnInput } from '../adapters/cli/codex-app-turn.js';

export const CODEX_APP_INPUT_PREFIX = '::botmux-codex-app:';

export interface CodexAppRunnerInput {
  type: 'message';
  content: string;
  codexAppInput?: CodexAppTurnInput;
  /** Immutable botmux/Lark message id used only for reply routing. */
  replyTurnId?: string;
  /** Explicit positive: this plain-human-interactive turn may `turn/steer` into
   * an already-active Codex App turn. Missing/false ⇒ forced serial (start its
   * own turn only when the runner is idle). */
  codexAppSteerable?: true;
}

export interface CodexAppFinalMarker {
  content: string;
  startedAtMs?: number;
  completedAtMs?: number;
  /** Codex app-server turn id, used for protocol matching and deduplication. */
  appTurnId?: string;
  /** botmux/Lark message id, used to select the Feishu reply destination. */
  replyTurnId?: string;
  /** Pre-steer Codex App and Mira markers used one id for both domains. */
  legacyTurnId?: string;
  /** Per-turn token usage (four mutually-exclusive buckets), when the turn's
   *  thread/tokenUsage/updated notifications yielded a coherent total. Omitted
   *  when no usage was observed / a protocol anomaly was detected. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

interface CodexAppLifecycleBase {
  atMs: number;
  queueLength?: number;
  appTurnId?: string;
  replyTurnId?: string;
}

export type CodexAppLifecycleOperation = 'turn/start' | 'turn/steer' | 'runner';
export type CodexAppLifecycleCategory =
  | 'definite_rejection'
  | 'steer_in_flight'
  | 'transport'
  | 'rpc'
  | 'protocol'
  | 'runtime';

export type CodexAppLifecycleEvent =
  | (CodexAppLifecycleBase & {
    kind: 'input_queued' | 'turn_start_attempt';
    queueLength: number;
  })
  | (CodexAppLifecycleBase & {
    kind: 'turn_started' | 'steer_attempt' | 'steer_accepted';
    appTurnId: string;
  })
  | (CodexAppLifecycleBase & {
    kind: 'steer_rejected_fallback';
    appTurnId: string;
    category: 'definite_rejection';
  })
  | (CodexAppLifecycleBase & {
    kind: 'completion_race';
    appTurnId: string;
    category: 'steer_in_flight';
  })
  | (CodexAppLifecycleBase & {
    kind: 'unknown_outcome';
    operation: 'turn/start' | 'turn/steer';
    category: 'transport' | 'rpc' | 'protocol';
  })
  | (CodexAppLifecycleBase & {
    kind: 'fatal';
    operation: CodexAppLifecycleOperation;
    category: 'transport' | 'rpc' | 'protocol' | 'runtime';
  });

export interface AppRunnerFinalIds {
  lastUuid: string;
  turnId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalLifecycleId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function decodeCodexAppRunnerInput(line: string): CodexAppRunnerInput | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CODEX_APP_INPUT_PREFIX)) return undefined;

  let value: unknown;
  try {
    const encoded = trimmed.slice(CODEX_APP_INPUT_PREFIX.length);
    value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== 'message' || typeof value.content !== 'string') {
    return undefined;
  }
  const allowedKeys = new Set(['type', 'content', 'codexAppInput', 'replyTurnId', 'codexAppSteerable']);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) return undefined;
  if (value.replyTurnId !== undefined && optionalLifecycleId(value.replyTurnId) === undefined) {
    return undefined;
  }
  // Explicit positive only: the wire carries `true` or omits the field. Any
  // other value is a malformed control line and rejects the whole input rather
  // than silently downgrading a steer authorization.
  if (value.codexAppSteerable !== undefined && value.codexAppSteerable !== true) {
    return undefined;
  }
  if (value.codexAppInput !== undefined && !isCodexAppTurnInput(value.codexAppInput)) {
    return undefined;
  }
  const codexAppInput = isCodexAppTurnInput(value.codexAppInput)
    ? value.codexAppInput
    : undefined;
  const replyTurnId = typeof value.replyTurnId === 'string'
    ? value.replyTurnId
    : codexAppInput?.clientUserMessageId;
  return {
    type: 'message',
    content: value.content,
    ...(codexAppInput ? { codexAppInput } : {}),
    ...(replyTurnId ? { replyTurnId } : {}),
    ...(value.codexAppSteerable === true ? { codexAppSteerable: true } : {}),
  };
}

export function normalizeAppRunnerFinalMarker(payload: unknown): CodexAppFinalMarker | undefined {
  if (!isRecord(payload) || typeof payload.content !== 'string') return undefined;
  return {
    content: payload.content,
    startedAtMs: optionalFiniteNumber(payload.startedAtMs),
    completedAtMs: optionalFiniteNumber(payload.completedAtMs),
    appTurnId: optionalNonEmptyString(payload.appTurnId),
    replyTurnId: optionalNonEmptyString(payload.replyTurnId),
    legacyTurnId: optionalNonEmptyString(payload.turnId),
    usage: normalizeFinalUsage(payload.usage),
  };
}

/** Accept the four-bucket usage only when every field is a non-negative integer
 *  (a token count), else drop it (daemon omits usage rather than persisting a
 *  negative/fractional/partial value that a compromised or buggy runner sent). */
export function normalizeFinalUsage(raw: unknown): CodexAppFinalMarker['usage'] | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens'] as const;
  const out = {} as NonNullable<CodexAppFinalMarker['usage']>;
  for (const k of keys) {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined;
    out[k] = v;
  }
  return out;
}

export function normalizeCodexAppLifecycleEvent(payload: unknown): CodexAppLifecycleEvent | undefined {
  if (!isRecord(payload) || typeof payload.kind !== 'string') return undefined;

  const allowedKeys = new Set([
    'kind',
    'atMs',
    'queueLength',
    'appTurnId',
    'replyTurnId',
    'operation',
    'category',
  ]);
  if (Object.keys(payload).some(key => !allowedKeys.has(key))) return undefined;
  if (typeof payload.atMs !== 'number' || !Number.isFinite(payload.atMs) || payload.atMs < 0) {
    return undefined;
  }
  if (payload.queueLength !== undefined && !isNonNegativeInteger(payload.queueLength)) {
    return undefined;
  }
  if (payload.appTurnId !== undefined && optionalLifecycleId(payload.appTurnId) === undefined) {
    return undefined;
  }
  if (payload.replyTurnId !== undefined && optionalLifecycleId(payload.replyTurnId) === undefined) {
    return undefined;
  }

  const base = {
    atMs: payload.atMs,
    ...(typeof payload.queueLength === 'number' ? { queueLength: payload.queueLength } : {}),
    ...(typeof payload.appTurnId === 'string' ? { appTurnId: payload.appTurnId } : {}),
    ...(typeof payload.replyTurnId === 'string' ? { replyTurnId: payload.replyTurnId } : {}),
  };
  const appTurnId = optionalLifecycleId(payload.appTurnId);

  switch (payload.kind) {
    case 'input_queued':
    case 'turn_start_attempt':
      if (!isNonNegativeInteger(payload.queueLength)
        || payload.appTurnId !== undefined
        || payload.operation !== undefined
        || payload.category !== undefined) return undefined;
      return { ...base, kind: payload.kind, queueLength: payload.queueLength };
    case 'turn_started':
    case 'steer_attempt':
    case 'steer_accepted':
      if (!appTurnId || payload.operation !== undefined || payload.category !== undefined) {
        return undefined;
      }
      return { ...base, kind: payload.kind, appTurnId };
    case 'steer_rejected_fallback':
      if (!appTurnId || payload.operation !== undefined || payload.category !== 'definite_rejection') {
        return undefined;
      }
      return { ...base, kind: payload.kind, appTurnId, category: 'definite_rejection' };
    case 'completion_race':
      if (!appTurnId || payload.operation !== undefined || payload.category !== 'steer_in_flight') {
        return undefined;
      }
      return { ...base, kind: payload.kind, appTurnId, category: 'steer_in_flight' };
    case 'unknown_outcome':
      if (
        (payload.operation !== 'turn/start' && payload.operation !== 'turn/steer')
        || (payload.category !== 'transport'
          && payload.category !== 'rpc'
          && payload.category !== 'protocol')
      ) return undefined;
      return {
        ...base,
        kind: payload.kind,
        operation: payload.operation,
        category: payload.category,
      };
    case 'fatal':
      if (
        (payload.operation !== 'turn/start'
          && payload.operation !== 'turn/steer'
          && payload.operation !== 'runner')
        || (payload.category !== 'transport'
          && payload.category !== 'rpc'
          && payload.category !== 'protocol'
          && payload.category !== 'runtime')
      ) return undefined;
      return {
        ...base,
        kind: payload.kind,
        operation: payload.operation,
        category: payload.category,
      };
    default:
      return undefined;
  }
}

export function projectAppRunnerFinalIds(
  marker: CodexAppFinalMarker,
  fallbackTurnId: string | undefined,
  generatedFallbackId: string,
): AppRunnerFinalIds {
  if (marker.appTurnId) {
    return {
      lastUuid: marker.appTurnId,
      turnId: marker.replyTurnId ?? fallbackTurnId ?? marker.appTurnId,
    };
  }
  const legacyId = marker.legacyTurnId ?? fallbackTurnId ?? generatedFallbackId;
  return { lastUuid: legacyId, turnId: legacyId };
}
