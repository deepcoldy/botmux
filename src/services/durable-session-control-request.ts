import type { DurableCoordinationStore } from './durable-coordination.js';
import { storedSessionAnchorId } from '../core/types.js';
import { durableDirectSessionControlEvent } from './durable-lark-session-control.js';
import { parseDurablePrimarySessionRecord } from './durable-session-primary.js';

export interface DurableSessionControlRequest {
  larkAppId: string;
  sessionKey?: string;
  sessionId: string;
  action: 'close' | 'resume';
}

export type DurableSessionControlRequestResult =
  | { ok: true; outcome: 'closed' | 'active'; alreadyClosed?: boolean }
  | {
      ok: true;
      outcome: 'closed_with_residual';
      residual: { reason?: string; taskId?: string };
      alreadyClosed?: boolean;
    }
  | { ok: false; error: string };

function resultObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function closeResidual(value: unknown): { reason?: string; taskId?: string } | undefined {
  const raw = resultObject(value);
  if (!raw) return undefined;
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
  const taskId = typeof raw.taskId === 'string' ? raw.taskId : undefined;
  return reason || taskId ? { ...(reason ? { reason } : {}), ...(taskId ? { taskId } : {}) } : undefined;
}

/**
 * 排入一个已鉴权的非卡片生命周期动作，并等待结果进入 canonical Session 快照。
 * operation id 绑定读到的 revision：不确定 HTTP 请求的重试复用同一副作用，
 * 后续 resume/close 产生新 revision 后则会获得新的 id。
 */
export async function requestDurableSessionControl(input: {
  store: DurableCoordinationStore;
  request: DurableSessionControlRequest;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<DurableSessionControlRequestResult> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeoutMs = input.timeoutMs ?? 45_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  let canonicalKey = input.request.sessionKey;
  let initial = canonicalKey
    ? await input.store.readSession(canonicalKey)
    : undefined;
  if (!initial && input.store.listSessions) {
    let afterSessionKey: string | undefined;
    for (let page = 0; page < 40; page += 1) {
      const listed = await input.store.listSessions({
        ...(afterSessionKey ? { afterSessionKey } : {}),
        limit: 256,
      });
      initial = listed.records.find(candidate => {
        try {
          const parsed = parseDurablePrimarySessionRecord(candidate);
          return parsed.session.sessionId === input.request.sessionId
            && parsed.session.larkAppId === input.request.larkAppId;
        } catch {
          return false;
        }
      });
      if (initial || !listed.nextSessionKey) break;
      afterSessionKey = listed.nextSessionKey;
    }
    canonicalKey = initial?.sessionKey;
  }
  if (!initial) return { ok: false, error: 'durable_session_not_found' };
  canonicalKey ??= initial.sessionKey;
  const canonical = parseDurablePrimarySessionRecord(initial);
  if (canonical.session.sessionId !== input.request.sessionId
      || canonical.session.larkAppId !== input.request.larkAppId) {
    return { ok: false, error: 'durable_session_identity_changed' };
  }
  const targetStatus = input.request.action === 'close' ? 'closed' : 'active';
  if (canonical.session.status === targetStatus) {
    const residual = input.request.action === 'close'
      ? closeResidual(resultObject(canonical.controls.at(-1)?.result)?.residual)
      : undefined;
    return input.request.action === 'close'
      ? residual
        ? { ok: true, outcome: 'closed_with_residual', residual, alreadyClosed: true }
        : { ok: true, outcome: 'closed', alreadyClosed: true }
      : { ok: true, outcome: 'active' };
  }
  const operationId = [
    'trusted-host.session-control',
    input.request.larkAppId,
    input.request.sessionId,
    String(initial.revision),
    input.request.action,
  ].join(':');
  const event = durableDirectSessionControlEvent({
    source: 'trusted-host',
    larkAppId: input.request.larkAppId,
    operationId,
    action: input.request.action,
    sessionId: input.request.sessionId,
    rootId: storedSessionAnchorId(canonical.session),
    cardMessageId: canonical.session.streamCardId,
    now: now(),
  });
  const inserted = await input.store.enqueueInbox(event);
  if (inserted.kind === 'conflict') {
    return { ok: false, error: 'durable_control_conflict' };
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const currentRecord = await input.store.readSession(canonicalKey);
    if (!currentRecord) return { ok: false, error: 'durable_session_disappeared' };
    const current = parseDurablePrimarySessionRecord(currentRecord);
    if (current.session.sessionId !== input.request.sessionId) {
      return { ok: false, error: 'durable_session_identity_changed' };
    }
    const committed = current.controls.find(item => item.operationId === operationId);
    if (committed) {
      const result = resultObject(committed.result);
      if (current.session.status === targetStatus) {
        const residual = input.request.action === 'close'
          ? closeResidual(result?.residual)
          : undefined;
        return input.request.action === 'close'
          ? residual
            ? {
                ok: true,
                outcome: 'closed_with_residual',
                residual,
                ...(result?.alreadyClosed === true ? { alreadyClosed: true } : {}),
              }
            : {
                ok: true,
                outcome: 'closed',
                ...(result?.alreadyClosed === true ? { alreadyClosed: true } : {}),
              }
          : { ok: true, outcome: 'active' };
      }
      return {
        ok: false,
        error: typeof result?.error === 'string'
          ? result.error
          : 'durable_control_not_applied',
      };
    }
    await wait(pollIntervalMs);
  }
  return { ok: false, error: 'durable_control_timeout' };
}
