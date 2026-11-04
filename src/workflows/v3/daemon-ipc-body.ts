/** Strict JSON schemas for the authenticated Workflow daemon mutations. */

import type { WorkflowDaemonMutation } from './daemon-ipc-client.js';
import { V3_DAG_SEGMENT_RE } from './dag.js';
import { V3_ACTION_REASON_MAX, type V3ActionCaller } from './action-provenance.js';

const CANCEL_REASON_MAX = 500;

export type WorkflowDaemonMutationBody =
  | { mutation: 'start'; value: Record<string, never> }
  | { mutation: 'cancel'; value: { reason?: string } }
  | { mutation: 'retry'; value: WorkflowRetryMutationBody }
  | { mutation: 'grant'; value: { loopId?: string } }
  | { mutation: 'edit'; value: WorkflowEditMutationBody }
  | { mutation: 'ask-human'; value: WorkflowAskHumanMutationBody };

/** `botmux workflow retry`. `reason` / `caller` are absent from older CLIs
 *  and card-free callers: the retry is then recorded exactly as before. */
export interface WorkflowRetryMutationBody {
  nodeId?: string;
  reason?: string;
  caller?: V3ActionCaller;
}

/** `botmux workflow edit`: the patch is validated by the engine planner; the
 *  caller is the turn identity the CLI authenticated (main-session check). */
export interface WorkflowEditMutationBody {
  patch: unknown;
  base: number;
  caller: { openId: string; origin: 'human' | 'runEvent'; wakeTurn?: boolean };
  reason?: string;
}

/** `botmux workflow ask-human` (design §13.6). */
export interface WorkflowAskHumanMutationBody {
  nodeId: string;
  reason: string;
  caller: V3ActionCaller;
}

export type WorkflowDaemonMutationBodyResult =
  | { ok: true; body: WorkflowDaemonMutationBody }
  | {
      ok: false;
      error: 'bad_json' | 'bad_body' | 'bad_reason' | 'bad_node_id' | 'bad_loop_id' | 'bad_edit' | 'bad_caller';
    };

/** A free-text reason: absent, or a bounded non-empty single string. */
function parseReason(value: unknown): { ok: true; reason?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || !value.trim() || value.trim().length > V3_ACTION_REASON_MAX || /\0/.test(value)) {
    return { ok: false };
  }
  return { ok: true, reason: value.trim() };
}

const TURN_ID_MAX = 256;

/** The authenticated turn a retry / ask-human came from (strict shape). */
function parseActionCaller(value: unknown): { ok: true; caller?: V3ActionCaller } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!plainJsonObject(value) || !exactKeys(value, ['origin', 'openId', 'wakeTurn', 'turnId'])) return { ok: false };
  if (value.origin !== 'human' && value.origin !== 'runEvent') return { ok: false };
  if (value.openId !== undefined && (typeof value.openId !== 'string' || !value.openId.trim())) return { ok: false };
  if (value.wakeTurn !== undefined && value.wakeTurn !== true) return { ok: false };
  if (value.turnId !== undefined && (typeof value.turnId !== 'string' || !value.turnId || value.turnId.length > TURN_ID_MAX)) {
    return { ok: false };
  }
  return {
    ok: true,
    caller: {
      origin: value.origin,
      ...(value.openId !== undefined ? { openId: value.openId as string } : {}),
      ...(value.wakeTurn === true ? { wakeTurn: true } : {}),
      ...(value.turnId !== undefined ? { turnId: value.turnId as string } : {}),
    },
  };
}

function plainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseWorkflowDaemonMutationBody(
  mutation: WorkflowDaemonMutation,
  bodyRaw: string,
): WorkflowDaemonMutationBodyResult {
  let parsed: unknown;
  if (bodyRaw === '') return { ok: false, error: 'bad_json' };
  try {
    parsed = JSON.parse(bodyRaw) as unknown;
  } catch {
    return { ok: false, error: 'bad_json' };
  }
  // Clients sign one canonical JSON serialization. Requiring that same form
  // rejects duplicate keys (JSON.parse would otherwise silently keep the last
  // one), whitespace variants, and parse→re-stringify ambiguity.
  if (JSON.stringify(parsed) !== bodyRaw) return { ok: false, error: 'bad_json' };
  if (!plainJsonObject(parsed)) return { ok: false, error: 'bad_body' };

  if (mutation === 'start') {
    if (!exactKeys(parsed, [])) return { ok: false, error: 'bad_body' };
    return { ok: true, body: { mutation, value: {} } };
  }

  if (mutation === 'cancel') {
    if (!exactKeys(parsed, ['reason'])) return { ok: false, error: 'bad_body' };
    if (parsed.reason === undefined) return { ok: true, body: { mutation, value: {} } };
    if (
      typeof parsed.reason !== 'string' ||
      !parsed.reason.trim() ||
      parsed.reason.trim().length > CANCEL_REASON_MAX ||
      /\0/.test(parsed.reason)
    ) {
      return { ok: false, error: 'bad_reason' };
    }
    return { ok: true, body: { mutation, value: { reason: parsed.reason.trim() } } };
  }

  if (mutation === 'retry') {
    if (!exactKeys(parsed, ['nodeId', 'reason', 'caller'])) return { ok: false, error: 'bad_body' };
    if (parsed.nodeId !== undefined && (typeof parsed.nodeId !== 'string' || !V3_DAG_SEGMENT_RE.test(parsed.nodeId))) {
      return { ok: false, error: 'bad_node_id' };
    }
    const reason = parseReason(parsed.reason);
    if (!reason.ok) return { ok: false, error: 'bad_reason' };
    const caller = parseActionCaller(parsed.caller);
    if (!caller.ok) return { ok: false, error: 'bad_caller' };
    return {
      ok: true,
      body: {
        mutation,
        value: {
          ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId as string } : {}),
          ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
          ...(caller.caller ? { caller: caller.caller } : {}),
        },
      },
    };
  }

  if (mutation === 'ask-human') {
    if (!exactKeys(parsed, ['nodeId', 'reason', 'caller'])) return { ok: false, error: 'bad_body' };
    if (typeof parsed.nodeId !== 'string' || !V3_DAG_SEGMENT_RE.test(parsed.nodeId)) {
      return { ok: false, error: 'bad_node_id' };
    }
    const reason = parseReason(parsed.reason);
    if (!reason.ok || reason.reason === undefined) return { ok: false, error: 'bad_reason' };
    const caller = parseActionCaller(parsed.caller);
    if (!caller.ok || !caller.caller) return { ok: false, error: 'bad_caller' };
    return { ok: true, body: { mutation, value: { nodeId: parsed.nodeId, reason: reason.reason, caller: caller.caller } } };
  }

  if (mutation === 'edit') {
    if (!exactKeys(parsed, ['patch', 'base', 'caller', 'reason'])) return { ok: false, error: 'bad_body' };
    const caller = parsed.caller;
    if (
      (!plainJsonObject(parsed.patch) && !Array.isArray(parsed.patch)) ||
      typeof parsed.base !== 'number' || !Number.isSafeInteger(parsed.base) || parsed.base < 1 ||
      !plainJsonObject(caller) || !exactKeys(caller, ['openId', 'origin', 'wakeTurn']) ||
      typeof caller.openId !== 'string' || !caller.openId.trim() ||
      (caller.origin !== 'human' && caller.origin !== 'runEvent') ||
      (caller.wakeTurn !== undefined && caller.wakeTurn !== true)
    ) {
      return { ok: false, error: 'bad_edit' };
    }
    const reason = parseReason(parsed.reason);
    if (!reason.ok) return { ok: false, error: 'bad_reason' };
    return {
      ok: true,
      body: {
        mutation,
        value: {
          patch: parsed.patch,
          base: parsed.base,
          caller: { openId: caller.openId, origin: caller.origin, ...(caller.wakeTurn === true ? { wakeTurn: true } : {}) },
          ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
        },
      },
    };
  }

  if (!exactKeys(parsed, ['loopId'])) return { ok: false, error: 'bad_body' };
  if (parsed.loopId === undefined) return { ok: true, body: { mutation, value: {} } };
  if (typeof parsed.loopId !== 'string' || !V3_DAG_SEGMENT_RE.test(parsed.loopId)) {
    return { ok: false, error: 'bad_loop_id' };
  }
  return { ok: true, body: { mutation, value: { loopId: parsed.loopId } } };
}
