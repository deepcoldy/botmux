/** Strict JSON schemas for the four authenticated Workflow daemon mutations. */

import type { WorkflowDaemonMutation } from './daemon-ipc-client.js';
import { V3_DAG_SEGMENT_RE } from './dag.js';

const CANCEL_REASON_MAX = 500;

export type WorkflowDaemonMutationBody =
  | { mutation: 'start'; value: Record<string, never> }
  | { mutation: 'cancel'; value: { reason?: string } }
  | { mutation: 'retry'; value: { nodeId?: string } }
  | { mutation: 'grant'; value: { loopId?: string } };

export type WorkflowDaemonMutationBodyResult =
  | { ok: true; body: WorkflowDaemonMutationBody }
  | {
      ok: false;
      error: 'bad_json' | 'bad_body' | 'bad_reason' | 'bad_node_id' | 'bad_loop_id';
    };

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
    if (!exactKeys(parsed, ['nodeId'])) return { ok: false, error: 'bad_body' };
    if (parsed.nodeId === undefined) return { ok: true, body: { mutation, value: {} } };
    if (typeof parsed.nodeId !== 'string' || !V3_DAG_SEGMENT_RE.test(parsed.nodeId)) {
      return { ok: false, error: 'bad_node_id' };
    }
    return { ok: true, body: { mutation, value: { nodeId: parsed.nodeId } } };
  }

  if (!exactKeys(parsed, ['loopId'])) return { ok: false, error: 'bad_body' };
  if (parsed.loopId === undefined) return { ok: true, body: { mutation, value: {} } };
  if (typeof parsed.loopId !== 'string' || !V3_DAG_SEGMENT_RE.test(parsed.loopId)) {
    return { ok: false, error: 'bad_loop_id' };
  }
  return { ok: true, body: { mutation, value: { loopId: parsed.loopId } } };
}
