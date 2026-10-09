import { createHash } from 'node:crypto';
import type { DaemonSession } from '../core/types.js';
import { sessionKey, storedSessionAnchorId } from '../core/types.js';
import type { Session } from '../types.js';
import type { DurableCoordinationStore, DurableJson } from './durable-coordination.js';
import { durableLarkOutboxMessage } from './durable-lark-outbox.js';
import { durableLarkSessionControlPartition } from './durable-lark-session-control.js';
import type { DurableSessionControlDispatchOptions } from './durable-session-control-dispatch.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import {
  commitDurableLarkSessionControl,
  parseDurablePrimarySessionRecord,
} from './durable-session-primary.js';

interface CloseResult {
  ok: boolean;
  outcome?: 'closed' | 'closed_with_residual';
  alreadyClosed?: boolean;
  residual?: unknown;
  error?: string;
}

type ResumeResult =
  | { ok: true; ds: DaemonSession; recoveryPending?: true }
  | { ok: false; error: string; activeSessionId?: string };

export interface DurableLarkSessionControlRuntimeOptions {
  larkAppId: string;
  privateCard: boolean;
  store: DurableCoordinationStore;
  facade(): DurableSessionFacade;
  listActiveSessions(): Iterable<DaemonSession>;
  findActiveSession(sessionId: string): DaemonSession | undefined;
  listPersistedSessions(): Session[];
  getPersistedSession(sessionId: string): Session | undefined;
  canOperate(chatId: string, operatorOpenId: string): boolean;
  closeSession(sessionId: string): Promise<CloseResult>;
  resumeSession(sessionId: string): Promise<ResumeResult>;
  buildClosedCard(session: DaemonSession): string;
  buildActiveCard(session: DaemonSession): string;
  resumeRefusedText(error: string, activeSessionId?: string): string;
  now?: () => number;
}

export interface DurableLarkSessionControlRuntime {
  ownedPartitionKeys(): string[];
  authorizeBeforeAck(data: unknown): boolean;
  resolve: DurableSessionControlDispatchOptions['resolve'];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Daemon-facing lifecycle adapter; keeps the daemon itself as thin wiring. */
export function createDurableLarkSessionControlRuntime(
  options: DurableLarkSessionControlRuntimeOptions,
): DurableLarkSessionControlRuntime {
  const now = options.now ?? Date.now;

  const ownedPartitionKeys = (): string[] => {
    const sessionIds = new Set<string>();
    for (const ds of options.listActiveSessions()) {
      if (ds.larkAppId === options.larkAppId && ds.session.status === 'active') {
        sessionIds.add(ds.session.sessionId);
      }
    }
    for (const session of options.listPersistedSessions()) {
      if (session.larkAppId === options.larkAppId && session.status === 'closed') {
        sessionIds.add(session.sessionId);
      }
    }
    return [...sessionIds].map(sessionId =>
      durableLarkSessionControlPartition(options.larkAppId, sessionId));
  };

  const authorizeBeforeAck = (raw: unknown): boolean => {
    const data = record(raw);
    const action = record(data?.action);
    const value = record(action?.value);
    const operator = record(data?.operator);
    const context = record(data?.context);
    const actionType = value?.action;
    const sessionId = value?.session_id;
    const operatorOpenId = operator?.open_id;
    const cardMessageId = context?.open_message_id ?? data?.open_message_id;
    if ((actionType !== 'close' && actionType !== 'resume')
        || typeof sessionId !== 'string'
        || typeof operatorOpenId !== 'string'
        || typeof cardMessageId !== 'string'
        || options.privateCard
        || value?.visibility === 'private') return false;
    const session = options.getPersistedSession(sessionId);
    if (!session || session.larkAppId !== options.larkAppId
        || session.streamCardId !== cardMessageId
        || (actionType === 'close' && session.status !== 'active')
        || (actionType === 'resume' && session.status !== 'closed')) return false;
    return options.canOperate(session.chatId, operatorOpenId);
  };

  const resolve: DurableSessionControlDispatchOptions['resolve'] = async (control, context) => {
    if (control.larkAppId !== options.larkAppId) {
      return { kind: 'ignored', reason: 'control belongs to another Lark application' };
    }
    const live = options.findActiveSession(control.sessionId);
    const persisted = options.getPersistedSession(control.sessionId);
    const session = live?.session ?? persisted;
    if (!session || session.larkAppId !== options.larkAppId) {
      return { kind: 'ignored', reason: 'control target is not owned by this bot' };
    }
    if (!options.canOperate(session.chatId, control.operatorOpenId)) {
      return { kind: 'ignored', reason: 'operator is not allowed to control this Session' };
    }
    const value = record(record(control.data)?.action)?.value;
    if (options.privateCard || record(value)?.visibility === 'private') {
      return { kind: 'ignored', reason: 'private lifecycle cards are not durable yet' };
    }
    if (session.title?.startsWith('Adopt:') || session.adoptedFrom) {
      return { kind: 'ignored', reason: 'adopted Sessions do not support durable lifecycle control' };
    }
    if (control.action === 'close') {
      if (!live && session.status !== 'closed') {
        return { kind: 'ignored', reason: 'active control target is not local to this replica' };
      }
      if (live?.streamCardId !== control.cardMessageId) {
        return { kind: 'ignored', reason: 'close card no longer owns the active Session lifecycle' };
      }
    } else if (session.streamCardId !== control.cardMessageId) {
      return { kind: 'ignored', reason: 'resume card no longer owns the closed Session lifecycle' };
    }

    const canonicalKey = sessionKey(storedSessionAnchorId(session), options.larkAppId);
    const canonical = await options.store.readSession(canonicalKey);
    if (!canonical || parseDurablePrimarySessionRecord(canonical).session.sessionId !== control.sessionId) {
      throw new Error('durable lifecycle control canonical Session is unavailable');
    }
    const operationPayload = {
      version: 1,
      type: 'botmux.lark.session-control-operation',
      larkAppId: control.larkAppId,
      action: control.action,
      sessionId: control.sessionId,
      rootId: control.rootId,
      operatorOpenId: control.operatorOpenId,
      cardMessageId: control.cardMessageId,
    } as unknown as DurableJson;
    const closeCard = control.action === 'close' && live
      ? options.buildClosedCard(live)
      : undefined;

    const result = (
      status: 'closed' | 'active',
      cardJson?: string,
      extra: Record<string, unknown> = {},
    ): DurableJson => ({
      version: 1,
      type: 'botmux.lark.session-control-result',
      action: control.action,
      sessionId: control.sessionId,
      status,
      ...(cardJson ? { cardJson } : {}),
      ...extra,
    }) as unknown as DurableJson;

    const observed = (): { result: DurableJson; evidence: DurableJson } | undefined => {
      const current = options.getPersistedSession(control.sessionId);
      if (!current) return undefined;
      if (control.action === 'close' && current.status === 'closed') {
        return {
          result: result('closed', closeCard),
          evidence: {
            source: 'session-store',
            status: 'closed',
            ...(current.closedAt ? { closedAt: current.closedAt } : {}),
          },
        };
      }
      if (control.action === 'resume' && current.status === 'active') {
        const active = options.findActiveSession(control.sessionId);
        return {
          result: result('active', active ? options.buildActiveCard(active) : undefined),
          evidence: { source: 'session-store', status: 'active' },
        };
      }
      return undefined;
    };

    return {
      kind: 'target',
      target: {
        sessionKey: canonicalKey,
        operationPayload,
        execute: async signal => {
          if (signal.aborted) {
            return { kind: 'not_applied', error: 'control claim aborted before effect' };
          }
          const already = observed();
          if (already) return { kind: 'completed', result: already.result };
          if (control.action === 'close') {
            const closed = await options.closeSession(control.sessionId);
            if (closed.ok) {
              return {
                kind: 'completed',
                result: result(
                  'closed',
                  closed.outcome === 'closed' ? closeCard : undefined,
                  {
                    alreadyClosed: closed.alreadyClosed === true,
                    ...(closed.outcome === 'closed_with_residual'
                      ? { residual: closed.residual as DurableJson }
                      : {}),
                  },
                ),
              };
            }
            const after = observed();
            if (after) return { kind: 'completed', result: after.result };
            return {
              kind: 'ambiguous',
              error: `close result requires reconciliation: ${closed.error ?? 'unknown'}`,
            };
          }
          const resumed = await options.resumeSession(control.sessionId);
          if (resumed.ok) {
            return {
              kind: 'completed',
              result: result(
                'active',
                options.buildActiveCard(resumed.ds),
                { recoveryPending: resumed.recoveryPending === true },
              ),
            };
          }
          const after = observed();
          if (after) return { kind: 'completed', result: after.result };
          if (resumed.error === 'anchor_occupied' || resumed.error === 'resume_start_failed') {
            const closed = options.getPersistedSession(control.sessionId);
            if (!closed || closed.status !== 'closed') {
              return {
                kind: 'ambiguous',
                error: `resume refusal left an unproven Session state: ${resumed.error}`,
              };
            }
            return {
              kind: 'completed',
              result: result('closed', undefined, {
                applied: false,
                error: resumed.error,
                noticeText: options.resumeRefusedText(resumed.error, resumed.activeSessionId),
              }),
            };
          }
          return {
            kind: 'ambiguous',
            error: `resume result requires reconciliation: ${resumed.error}`,
          };
        },
        reconcile: async () => {
          const reconciled = observed();
          return reconciled
            ? { kind: 'completed', ...reconciled }
            : { kind: 'unknown', error: 'backend cannot yet prove the lifecycle outcome' };
        },
        commit: async (rawResult, signal) => {
          if (signal.aborted) throw signal.reason;
          const parsed = record(rawResult);
          const status = parsed?.status;
          if (parsed?.version !== 1
              || parsed.type !== 'botmux.lark.session-control-result'
              || parsed.action !== control.action
              || parsed.sessionId !== control.sessionId
              || (status !== 'closed' && status !== 'active')
              || (control.action === 'close' && status !== 'closed')
              || (control.action === 'resume'
                && status !== 'active'
                && !(status === 'closed' && parsed.applied === false))
              || (parsed.cardJson !== undefined && typeof parsed.cardJson !== 'string')
              || (parsed.noticeText !== undefined && typeof parsed.noticeText !== 'string')) {
            throw new Error('durable lifecycle control result is invalid');
          }
          const current = options.getPersistedSession(control.sessionId);
          if (!current || current.status !== status) {
            throw new Error('local Session state does not match the completed control result');
          }
          const committed = await commitDurableLarkSessionControl({
            facade: options.facade(),
            control,
            session: current,
            result: rawResult,
          });
          if (committed.kind !== 'committed') {
            throw new Error(`canonical control commit failed: ${committed.kind}`);
          }
          const digest = createHash('sha256').update(control.operationId, 'utf8').digest('hex');
          const enqueue = async (message: ReturnType<typeof durableLarkOutboxMessage>, label: string) => {
            const enqueued = await options.store.enqueueOutbox({ lease: committed.lease, message });
            if (enqueued.kind === 'conflict' || enqueued.kind === 'stale_lease') {
              throw new Error(`durable control ${label} output failed: ${enqueued.kind}`);
            }
          };
          if (typeof parsed.cardJson === 'string' && parsed.cardJson) {
            await enqueue(durableLarkOutboxMessage({
              messageId: `control_update_${digest}`,
              sessionKey: canonicalKey,
              larkAppId: options.larkAppId,
              target: { kind: 'update', messageId: control.cardMessageId },
              content: parsed.cardJson,
              msgType: 'interactive',
              providerUuid: `bct_${digest.slice(0, 40)}`,
              createdAt: context.claim.event.createdAt,
              visibleAt: now(),
            }), 'card');
          }
          if (typeof parsed.noticeText === 'string' && parsed.noticeText) {
            await enqueue(durableLarkOutboxMessage({
              messageId: `control_notice_${digest}`,
              sessionKey: canonicalKey,
              larkAppId: options.larkAppId,
              target: control.rootId.startsWith('om_')
                ? { kind: 'reply', messageId: control.rootId, replyInThread: true }
                : { kind: 'send', chatId: current.chatId },
              content: parsed.noticeText,
              msgType: 'text',
              providerUuid: `bcn_${digest.slice(0, 40)}`,
              createdAt: context.claim.event.createdAt,
              visibleAt: now(),
            }), 'notice');
          }
        },
      },
    };
  };

  return { ownedPartitionKeys, authorizeBeforeAck, resolve };
}
