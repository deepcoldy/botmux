import { createHash } from 'node:crypto';
import { normalizeRemoteRunnerBackendState } from '../adapters/backend/remote-runner-protocol.js';
import type { DaemonSession } from '../core/types.js';
import { sessionKey } from '../core/types.js';
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
  /** Import a canonical closed snapshot into this replica's local runtime store. */
  materializeClosedSession(session: Session): Session;
  canOperate(chatId: string, operatorOpenId: string): boolean;
  closeSession(sessionId: string): Promise<CloseResult>;
  resumeSession(sessionId: string): Promise<ResumeResult>;
  buildClosedCard(session: DaemonSession | Session): string;
  buildActiveCard(session: DaemonSession): string;
  resumeRefusedText(error: string, activeSessionId?: string): string;
  now?: () => number;
}

export interface DurableLarkSessionControlRuntime {
  ownedPartitionKeys(): string[];
  authorizeBeforeAck(data: unknown): Promise<boolean>;
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

  const authorizeBeforeAck = async (raw: unknown): Promise<boolean> => {
    const data = record(raw);
    const action = record(data?.action);
    const value = record(action?.value);
    const operator = record(data?.operator);
    const context = record(data?.context);
    const actionType = value?.action;
    const sessionId = value?.session_id;
    const rootId = value?.root_id;
    const operatorOpenId = operator?.open_id;
    const cardMessageId = context?.open_message_id ?? data?.open_message_id;
    if ((actionType !== 'close' && actionType !== 'resume')
        || typeof sessionId !== 'string'
        || typeof rootId !== 'string'
        || typeof operatorOpenId !== 'string'
        || typeof cardMessageId !== 'string'
        || options.privateCard
        || value?.visibility === 'private') return false;
    const canonical = await options.store.readSession(sessionKey(rootId, options.larkAppId));
    if (!canonical) return false;
    const session = parseDurablePrimarySessionRecord(canonical).session;
    if (!session || session.larkAppId !== options.larkAppId
        || session.sessionId !== sessionId
        || session.streamCardId !== cardMessageId
        || (actionType === 'close' && session.status !== 'active')
        || (actionType === 'resume' && session.status !== 'closed')) return false;
    return options.canOperate(session.chatId, operatorOpenId);
  };

  const resolve: DurableSessionControlDispatchOptions['resolve'] = async (control, context) => {
    if (control.larkAppId !== options.larkAppId) {
      return { kind: 'ignored', reason: 'control belongs to another Lark application' };
    }
    const value = record(record(control.data)?.action)?.value;
    if (options.privateCard || record(value)?.visibility === 'private') {
      return { kind: 'ignored', reason: 'private lifecycle cards are not durable yet' };
    }
    const canonicalKey = sessionKey(control.rootId, options.larkAppId);
    const canonical = await options.store.readSession(canonicalKey);
    const canonicalSession = canonical
      ? parseDurablePrimarySessionRecord(canonical).session
      : undefined;
    if (!canonicalSession
        || canonicalSession.larkAppId !== options.larkAppId
        || canonicalSession.sessionId !== control.sessionId) {
      throw new Error('durable lifecycle control canonical Session is unavailable');
    }
    if (control.action === 'resume' && canonicalSession.status !== 'closed') {
      return { kind: 'ignored', reason: 'canonical Session is no longer closed' };
    }
    if (control.action === 'close' && canonicalSession.status !== 'active'
        && canonicalSession.status !== 'closed') {
      return { kind: 'ignored', reason: 'canonical Session cannot be closed' };
    }
    if (canonicalSession.streamCardId !== control.cardMessageId) {
      return {
        kind: 'ignored',
        reason: `${control.action} card no longer owns the canonical Session lifecycle`,
      };
    }
    if (!options.canOperate(canonicalSession.chatId, control.operatorOpenId)) {
      return { kind: 'ignored', reason: 'operator is not allowed to control this Session' };
    }
    if (canonicalSession.title?.startsWith('Adopt:') || canonicalSession.adoptedFrom) {
      return { kind: 'ignored', reason: 'adopted Sessions do not support durable lifecycle control' };
    }

    const live = options.findActiveSession(control.sessionId);
    let persisted = options.getPersistedSession(control.sessionId);
    if (control.action === 'resume' && !persisted) {
      persisted = options.materializeClosedSession(structuredClone(canonicalSession));
    }
    const session = live?.session ?? persisted ?? canonicalSession;
    if (control.action === 'close' && canonicalSession.status === 'active') {
      if (!live) {
        // Prefix fallback may discover an active Session owned by another Pod.
        // Keep the Inbox row retryable; completing it as ignored would lose the
        // user's close request before the exact runtime owner can claim it.
        throw new Error('active control target is not local to this replica');
      }
      if (live.streamCardId !== control.cardMessageId) {
        return { kind: 'ignored', reason: 'close card no longer owns the active Session lifecycle' };
      }
    }
    if (control.action === 'resume' && !live && persisted?.status !== 'closed') {
      throw new Error('canonical closed Session could not be materialized locally');
    }
    const resumeBaselineState = control.action === 'resume'
      ? normalizeRemoteRunnerBackendState(canonicalSession.remoteBackendState)
      : undefined;
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
    // A Remote Runner resume may briefly reactivate its local Session while the
    // replacement provider generation is still starting. If startup later
    // rolls back, worker readiness may already have repainted the clicked card
    // as active. Keep an exact closed projection ready so reconciliation can
    // restore the Resume button together with the canonical closed commit.
    const resumeRollbackCard = control.action === 'resume'
      ? options.buildClosedCard(session)
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

    const observed = (
      reconcileResume = false,
    ): { result: DurableJson; evidence: DurableJson } | undefined => {
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
      if (control.action === 'resume' && reconcileResume && current.status === 'closed') {
        return {
          result: result('closed', resumeRollbackCard, {
            applied: false,
            error: 'resume_start_failed',
            noticeText: options.resumeRefusedText('resume_start_failed'),
          }),
          evidence: {
            source: 'session-store',
            status: 'closed',
            recovery: 'rolled-back',
            ...(current.closedAt ? { closedAt: current.closedAt } : {}),
          },
        };
      }
      if (control.action === 'resume' && current.status === 'active') {
        const active = options.findActiveSession(control.sessionId);
        if (resumeBaselineState) {
          const recoveredState = normalizeRemoteRunnerBackendState(
            active?.session.remoteBackendState,
          );
          if (!active
              || !recoveredState
              || recoveredState.provider !== resumeBaselineState.provider
              || recoveredState.generation <= resumeBaselineState.generation
              || !recoveredState.remoteSessionId) return undefined;
        }
        return {
          result: result('active', active ? options.buildActiveCard(active) : undefined),
          evidence: {
            source: 'session-store',
            status: 'active',
            ...(resumeBaselineState
              ? {
                  recovery: 'ready',
                  generation: active?.session.remoteBackendState?.generation,
                }
              : {}),
          },
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
            if (resumed.recoveryPending === true) {
              const recovered = observed(true);
              if (recovered) return { kind: 'completed', result: recovered.result };
              return {
                kind: 'ambiguous',
                error: 'remote resume recovery is pending durable readiness',
              };
            }
            return {
              kind: 'completed',
              result: result(
                'active',
                options.buildActiveCard(resumed.ds),
                { recoveryPending: resumed.recoveryPending === true },
              ),
            };
          }
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
              result: result('closed', resumeRollbackCard, {
                applied: false,
                error: resumed.error,
                noticeText: options.resumeRefusedText(resumed.error, resumed.activeSessionId),
              }),
            };
          }
          const after = observed(true);
          if (after) return { kind: 'completed', result: after.result };
          return {
            kind: 'ambiguous',
            error: `resume result requires reconciliation: ${resumed.error}`,
          };
        },
        reconcile: async () => {
          const reconciled = observed(true);
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
          if (control.action === 'resume' && status === 'active') {
            const active = options.findActiveSession(control.sessionId);
            if (active?.session.sessionId === control.sessionId) {
              // Remote resume keeps automatic worker cards silent until the
              // canonical active commit. Release that presentation gate only
              // after RDS is authoritative; the outbox update below then owns
              // the first active projection.
              active.suppressRecoveryCard = undefined;
            }
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
