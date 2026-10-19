import { randomUUID } from 'node:crypto';
import type { FailedTurnRecord, TrustedCaller, CliTurnPayload, Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { activeSessionKey } from './types.js';
import * as store from '../services/session-store.js';
import { buildFailedTurnRecord, shouldRecordFailedTurn } from '../services/failed-turn-retry.js';
import { canTalk } from '../im/lark/event-dispatcher.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { buildFollowUpCliInput, rememberLastCliInput } from './session-manager.js';
import { localeForBot } from '../i18n/index.js';
import { inheritSessionLaunchConfiguration } from './session-launch-inheritance.js';
import { armSilentScheduledTurn, disarmSilentScheduledTurn, isSilentScheduledTurn } from './silent-schedule-turns.js';
import {
  findActiveBySessionId, closeSessionForBackgroundCleanup, forkWorker, sendWorkerInput,
  getActiveSessionsRegistry, setActiveSessionIfActive, prepareFailedTurnRecoveryIdentity,
} from './worker-pool.js';

export interface FailedTurnRecoveryRequest {
  turnId: string;
  failedAt: string;
  requestId: string;
  mode: 'retry' | 'fresh';
}

/** The request contains only a failure reference and a lifecycle choice. */
export function parseFailedTurnRecoveryRequest(value: unknown): FailedTurnRecoveryRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['turnId', 'failedAt', 'requestId', 'mode'].includes(key))) return;
  if (typeof body.turnId !== 'string' || !body.turnId || body.turnId.length > 256
      || typeof body.failedAt !== 'string' || !Number.isFinite(Date.parse(body.failedAt))
      || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId)
      || (body.mode !== 'retry' && body.mode !== 'fresh')) return;
  return body as unknown as FailedTurnRecoveryRequest;
}

/** Only incoming, daemon-routed IM can cancel a pending recovery. Entries exist
 * only during the transaction, including while the bot's mutation gate waits. */
const pending = new Map<string, { originalTurnId: string; cancelled: boolean }>();
function routeKey(appId: string, anchor: string): string { return `${appId}:${anchor}`; }
export function noteFailedTurnRecoveryInput(appId: string, anchor: string, messageId: string): void {
  const transaction = pending.get(routeKey(appId, anchor));
  if (transaction && messageId !== transaction.originalTurnId) transaction.cancelled = true;
}

/** Snapshot only daemon-authenticated current-turn facts, never the owner. */
export function failedTurnCaller(ds: DaemonSession, turnId: string): TrustedCaller | undefined {
  const caller = ds.session.failedTurnRecovery?.turnId === turnId ? ds.session.failedTurnRecovery.caller
    : ds.activeInteractiveTurn?.turnId === turnId ? ds.activeInteractiveTurn.caller
      : ds.scheduledTurnCallers?.get(turnId);
  if (caller) {
    if ((caller.senderType === 'user' || caller.source === 'schedule_creator') && caller.requestLarkAppId === ds.larkAppId
        && caller.requestUserOpenId?.startsWith('ou_')) return { ...caller, senderType: 'user' };
    // An explicit foreign/bot caller cannot be replaced by reply metadata.
    return;
  }
  if (ds.session.larkAppId !== ds.larkAppId) return;
  const target = pickTurnReplyTarget(ds.session, turnId);
  const human = target?.participants?.some(person => person.openId === target.senderOpenId && person.isBot === false)
    || ds.session.quoteTargetId === turnId && ds.session.quoteTargetSenderIsBot === false;
  if (!human || !target?.senderOpenId?.startsWith('ou_')) return;
  return { requestUserOpenId: target.senderOpenId, requestLarkAppId: ds.larkAppId, senderType: 'user' };
}

/** Some structured quota failures have no turn_terminal. Record their input
 * once at the native limited edge, while the authenticated turn still exists. */
export function recordLimitedFailedTurn(ds: DaemonSession, turnId: string | undefined): void {
  if (!turnId || !ds.usageLimit?.limited || ds.session.lastFailedTurn?.turnId === turnId
      || !shouldRecordFailedTurn({ turnId, status: 'failed' }, ds.currentReplyTarget?.turnId)) return;
  const caller = failedTurnCaller(ds, turnId);
  if (!caller) return;
  const record = buildFailedTurnRecord({ turnId, status: 'failed', errorCode: `${ds.usageLimit.kind}_limited` }, {
    userPrompt: ds.lastUserPrompt, cliInput: ds.lastCliInput, codexAppInput: ds.lastCodexAppInput,
    trustedCaller: caller, silent: isSilentScheduledTurn(ds, turnId),
    originalTurnId: ds.session.failedTurnRecovery?.turnId === turnId
      ? ds.session.failedTurnRecovery.originalTurnId : turnId,
  });
  if (record) {
    record.limitedSnapshot = true;
    ds.session.lastFailedTurn = record;
    store.updateSession(ds.session);
  }
}

/** Invalidate only unclaimed provisional observations. Durable recovery
 * receipts and real failed terminals must survive status/terminal updates. */
export function clearLimitedFailedTurn(ds: DaemonSession, turnId?: string): void {
  const record = ds.session.lastFailedTurn;
  if (!record?.limitedSnapshot || record.recovery || turnId !== undefined && record.turnId !== turnId) return;
  delete ds.session.lastFailedTurn;
  store.updateSession(ds.session);
}

/** Terminal bookkeeping shares the provisional snapshot's lifecycle owner.
 * The caller/silent facts are captured by the daemon before releasing the
 * active turn; a late terminal must not erase an already-claimed receipt. */
export function recordFailedTurnTerminal(
  ds: DaemonSession,
  terminal: { turnId: string; status: string; errorCode?: string },
  context: { workerGeneration: number; caller: TrustedCaller | undefined; silent: boolean },
): void {
  if (terminal.status === 'completed' && ds.session.workerGeneration === context.workerGeneration) {
    clearLimitedFailedTurn(ds, terminal.turnId);
  }
  if (terminal.status !== 'failed' && terminal.status !== 'ambiguous') return;
  if (!shouldRecordFailedTurn(terminal, ds.currentReplyTarget?.turnId)
      || ds.session.lastFailedTurn?.turnId === terminal.turnId && ds.session.lastFailedTurn.recovery) return;
  const record = buildFailedTurnRecord({ ...terminal, status: terminal.status }, {
    userPrompt: ds.lastUserPrompt, cliInput: ds.lastCliInput, codexAppInput: ds.lastCodexAppInput,
    trustedCaller: context.caller, silent: context.silent,
    originalTurnId: ds.session.failedTurnRecovery?.turnId === terminal.turnId
      ? ds.session.failedTurnRecovery.originalTurnId : terminal.turnId,
  });
  if (record) { ds.session.lastFailedTurn = record; store.updateSession(ds.session); }
}

export type FailedTurnRecoveryResult =
  | { ok: false; error: string }
  | { ok: true; state: NonNullable<FailedTurnRecord['recovery']>['state']; sessionId: string; turnId: string; originalTurnId: string };

function receipt(record: FailedTurnRecord): FailedTurnRecoveryResult {
  const value = record.recovery!;
  return { ok: true, state: value.state, sessionId: value.sessionId, turnId: value.turnId,
    originalTurnId: record.originalTurnId ?? record.turnId };
}

function newerInput(ds: DaemonSession, record: FailedTurnRecord): boolean {
  return ['backoff', 'dispatching'].includes(ds.session.ordinaryTurnRecovery?.status ?? '')
    || hasProtectedSessionMutationOwnership(ds)
    || !!ds.pendingPrompt || !!ds.pendingFollowUps?.length || !!ds.pendingFollowUpTurnIds?.length
    || !!ds.activeInteractiveTurn && ds.activeInteractiveTurn.turnId !== record.turnId
    || !!ds.currentReplyTarget?.turnId && ds.currentReplyTarget.turnId !== record.turnId
    || ds.lastMessageAt > Date.parse(record.failedAt)
    || ds.lastScreenStatus === 'working' || ds.lastScreenStatus === 'analyzing';
}

/** Admin-only primitive; polling, error classification and delay policy stay
 * outside Botmux. A durable attempting receipt precedes every side effect.
 * Unknown admission is never replayed, including after daemon restart. */
export async function recoverFailedTurn(sessionId: string, request: FailedTurnRecoveryRequest): Promise<FailedTurnRecoveryResult> {
  const initial = findActiveBySessionId(sessionId);
  const row = initial?.session ?? store.getOwnedSession(sessionId);
  const old = row?.lastFailedTurn;
  if (!row || !old || old.turnId !== request.turnId || old.failedAt !== request.failedAt) {
    return { ok: false, error: 'failure_changed' };
  }
  if (old.recovery) {
    return old.recovery.requestId === request.requestId && old.recovery.mode === request.mode
      ? receipt(old) : { ok: false, error: 'failure_already_claimed' };
  }
  if (!initial || initial.session.status !== 'active') return { ok: false, error: 'session_not_active' };
  const key = routeKey(initial.larkAppId, initial.runtimeRoutingAnchor
    ?? (initial.scope === 'chat' ? initial.chatId : initial.session.rootMessageId));
  if (pending.has(key)) return { ok: false, error: 'recovery_in_progress' };
  const transaction = { originalTurnId: old.originalTurnId ?? old.turnId, cancelled: false };
  pending.set(key, transaction);
  try {
    return await withBotTurnMutation(initial.larkAppId, async () => {
      const ds = findActiveBySessionId(sessionId);
      const record = ds?.session.lastFailedTurn;
      if (!ds || ds !== initial || record !== old || record.turnId !== request.turnId
          || record.failedAt !== request.failedAt) return { ok: false, error: 'failure_changed' };
      // Harvested-answer self-heal may never emit another screen frame. Do not
      // replay a provisional quota observation after native recovery succeeds.
      if (record.limitedSnapshot && (!ds.usageLimit?.limited || ds.lastScreenStatus !== 'limited')) {
        return { ok: false, error: 'failure_changed' };
      }
      const caller = record.trustedCaller;
      if (!caller || caller.senderType !== 'user' || caller.requestLarkAppId !== ds.larkAppId
          || !caller.requestUserOpenId?.startsWith('ou_')) return { ok: false, error: 'original_actor_unavailable' };
      if (!canTalk(ds.larkAppId, ds.chatId, caller.requestUserOpenId, undefined,
        caller.requestUserUnionId, ds.chatType)) return { ok: false, error: 'original_actor_no_longer_allowed' };
      if (transaction.cancelled || newerInput(ds, record)) return { ok: false, error: 'newer_input' };
      if (ds.adoptedFrom || ds.initConfig?.adoptMode || isRemoteBackendSession(ds)
          || ds.session.principalLane || ds.session.workspaceRetirement) {
        return { ok: false, error: 'recovery_unsupported' };
      }
      const turnId = caller.source === 'schedule_creator' && caller.taskId
        ? `schedule:${caller.taskId}:${randomUUID()}` : `bmx-recovery-${randomUUID()}`;
      record.recovery = { requestId: request.requestId, mode: request.mode,
        turnId, sessionId, state: 'attempting' };
      const persistRecord = () => {
        // Session Store refreshes nested objects from SQLite on every write.
        // Reattach the transaction's receipt before each source-row persist.
        ds.session.lastFailedTurn = record;
        store.updateSession(ds.session);
      };
      // Throws before close/IPC when persistence is unavailable.
      persistRecord();
      const setState = (state: NonNullable<FailedTurnRecord['recovery']>['state']) => {
        record.recovery!.state = state;
        persistRecord();
        return receipt(record);
      };
      let target = ds;
      let ipcAttempted = false;
      const previousActive = ds.activeInteractiveTurn;
      const previousReply = ds.currentReplyTarget;
      const previousRecovery = ds.session.failedTurnRecovery;
      const abandonUndispatched = () => {
        disarmSilentScheduledTurn(target, turnId);
        if (target !== ds) {
          store.closeSession(target.session.sessionId);
          const registry = getActiveSessionsRegistry();
          if (registry?.get(activeSessionKey(target)) === target) registry.delete(activeSessionKey(target));
        } else {
          target.activeInteractiveTurn = previousActive;
          target.currentReplyTarget = previousReply;
          target.session.currentReplyTarget = previousReply ? { ...previousReply } : undefined;
          target.session.failedTurnRecovery = previousRecovery;
          store.updateSession(target.session);
        }
      };
      try {
        if (request.mode === 'fresh') {
          const closed = await closeSessionForBackgroundCleanup(sessionId, 'failed-turn recovery');
          if (!closed.ok || closed.outcome !== 'closed') return setState('dispatch_unknown');
          if (transaction.cancelled) return setState('cancelled');
          const created = store.createSession(ds.chatId, ds.session.rootMessageId, ds.session.title,
            ds.chatType, ds.scope, { source: 'other', inherit: ds.session });
          created.larkAppId = ds.larkAppId;
          inheritSessionLaunchConfiguration(ds.session, created);
          for (const name of ['ownerOpenId', 'ownerUnionId', 'creatorOpenId', 'lastCallerOpenId',
            'larkThreadId', 'whiteboardId', 'quoteTargetId',
            'quoteTargetSenderOpenId', 'quoteTargetSenderIsBot'] as const) {
            if (name in ds.session) (created as unknown as Record<string, unknown>)[name] = structuredClone(ds.session[name as keyof Session]);
          }
          created.workingDir = ds.workingDir ?? ds.session.workingDir;
          target = { session: created, worker: null, workerPort: null, workerToken: null,
            larkAppId: ds.larkAppId, chatId: ds.chatId, chatType: ds.chatType, scope: ds.scope,
            workingDir: created.workingDir, spawnedAt: Date.now(), cliVersion: ds.cliVersion,
            ownerOpenId: created.ownerOpenId, lastMessageAt: Date.now(), hasHistory: false } as DaemonSession;
          record.recovery!.sessionId = created.sessionId;
          const registry = getActiveSessionsRegistry();
          if (!registry || !setActiveSessionIfActive(registry, activeSessionKey(target), target)) {
            store.closeSession(created.sessionId);
            return setState('dispatch_unknown');
          }
        }
        const recoveredCaller: TrustedCaller = { ...caller,
          source: caller.source === 'schedule_creator' ? caller.source : 'failed_turn_recovery' };
        target.session.failedTurnRecovery = { originalTurnId: transaction.originalTurnId, turnId, caller: { ...caller } };
        const priorReply = pickTurnReplyTarget(ds.session, record.turnId);
        target.session.replyTargets = { ...target.session.replyTargets,
          [turnId]: { ...priorReply, rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId,
            senderOpenId: caller.requestUserOpenId, participants: priorReply?.participants ?? [{ openId: caller.requestUserOpenId, isBot: false }], updatedAt: new Date().toISOString() } };
        target.activeInteractiveTurn = { turnId, caller: recoveredCaller, userPrompt: record.userPrompt };
        target.currentReplyTarget = { rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId,
          turnId, updatedAt: new Date().toISOString() };
        target.session.currentReplyTarget = { ...target.currentReplyTarget };
        const codexAppInput = record.codexAppInput
          ? (({ clientUserMessageId: _oldId, ...input }) => input)(record.codexAppInput) : undefined;
        const input: CliTurnPayload = request.mode === 'fresh'
          ? buildFollowUpCliInput(record.userPrompt, target.session.sessionId, {
            larkAppId: target.larkAppId, chatId: target.chatId, cliId: target.session.cliId,
            locale: localeForBot(target.larkAppId), turnId, codexAppText: codexAppInput?.text,
          })
          : { content: record.cliInput, ...(codexAppInput ? { codexAppInput } : {}) };
        if (request.mode === 'fresh' && codexAppInput) {
          input.codexAppInput = { ...(input.codexAppInput ?? { text: codexAppInput.text }),
            ...(codexAppInput.localImages ? { localImages: structuredClone(codexAppInput.localImages) } : {}) };
        }
        store.updateSession(target.session);
        persistRecord();
        await prepareFailedTurnRecoveryIdentity(target, turnId);
        if (record.silent) armSilentScheduledTurn(target, turnId);
        // Synchronous final check + worker admission is the linearization edge.
        if (transaction.cancelled) { abandonUndispatched(); return setState('cancelled'); }
        let rejected = false;
        ipcAttempted = true;
        const accepted = target.worker && !target.worker.killed
          ? sendWorkerInput(target, input, turnId, { trustedCaller: recoveredCaller, atMostOnce: true })
          : forkWorker(target, input, { resume: request.mode === 'retry' && target.hasHistory,
            turnId, trustedCaller: recoveredCaller, atMostOnce: true }, {
            onAdmission: admission => { rejected = admission === 'rejected'; },
          });
        if (!accepted || rejected) return setState('dispatch_unknown');
        rememberLastCliInput(target, record.userPrompt, input);
        store.updateSession(target.session);
        return setState('accepted');
      } catch {
        if (!ipcAttempted) abandonUndispatched();
        // The stored attempting fence survives even if this write also fails.
        return setState('dispatch_unknown');
      }
    });
  } finally {
    if (pending.get(key) === transaction) pending.delete(key);
  }
}
