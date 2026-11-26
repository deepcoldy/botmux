import { randomUUID } from 'node:crypto';
import type { FailedTurnRecord, TrustedCaller, CliTurnPayload, Session } from '../types.js';
import type { DaemonSession } from './types.js';
import { activeSessionKey } from './types.js';
import * as store from '../services/session-store.js';
import {
  buildFailedTurnRecord,
  failedTurnDirectFailureProofMatches,
  syncFailedTurnDirectFailureProof,
} from '../services/failed-turn-retry.js';
import { turnAnswersInChat } from './failed-turn-rewind.js';
import { isAutoCompactSafeComposerRefusal } from './auto-compact.js';
import { canTalk } from '../im/lark/event-dispatcher.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { failedTurnCaller, failedTurnCrossChatOrigin } from './failed-turn-caller.js';
import { buildFollowUpCliInput, rememberLastCliInput } from './session-manager.js';
import { prepareHookEnvelopeForReplay } from './prompt-hook-replay.js';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
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

export { failedTurnCaller } from './failed-turn-caller.js';

interface LimitedFailedTurnClearRetryEntry {
  timer: ReturnType<typeof setTimeout>;
  turnId: string;
  failedAt: string;
  worker: DaemonSession['worker'];
  workerGeneration: DaemonSession['workerGeneration'];
  sessionWorkerGeneration: Session['workerGeneration'];
  currentGenerationCompleted: boolean;
}

const limitedFailedTurnClearRetries = new WeakMap<DaemonSession, LimitedFailedTurnClearRetryEntry>();

function cancelLimitedFailedTurnClearRetry(ds: DaemonSession): void {
  const existing = limitedFailedTurnClearRetries.get(ds);
  if (existing) clearTimeout(existing.timer);
  limitedFailedTurnClearRetries.delete(ds);
}

interface LimitedFailedTurnRecordRetryEntry {
  timer: ReturnType<typeof setTimeout>;
  turnId: string;
}

const limitedFailedTurnRecordRetries = new WeakMap<DaemonSession, LimitedFailedTurnRecordRetryEntry>();

function cancelLimitedFailedTurnRecordRetry(ds: DaemonSession): void {
  const existing = limitedFailedTurnRecordRetries.get(ds);
  if (existing) clearTimeout(existing.timer);
  limitedFailedTurnRecordRetries.delete(ds);
}

function retryLimitedFailedTurnRecord(ds: DaemonSession, turnId: string): void {
  cancelLimitedFailedTurnRecordRetry(ds);
  const fence = {
    sessionId: ds.session.sessionId,
    worker: ds.worker,
    workerGeneration: ds.workerGeneration,
    sessionWorkerGeneration: ds.session.workerGeneration,
    turnId,
  };
  let delayMs = 500;
  const schedule = (): void => {
    const timer = setTimeout(() => {
      if (limitedFailedTurnRecordRetries.get(ds)?.timer !== timer) return;
      limitedFailedTurnRecordRetries.delete(ds);
      if (findActiveBySessionId(fence.sessionId) !== ds
        || ds.session.status !== 'active'
        || ds.worker !== fence.worker
        || ds.workerGeneration !== fence.workerGeneration
        || ds.session.workerGeneration !== fence.sessionWorkerGeneration
        || ds.lastCliInputTurnId !== fence.turnId
        || !ds.usageLimit?.limited
        || ds.terminalIdentityTurnIds?.has(fence.turnId)) {
        return;
      }
      try {
        recordLimitedFailedTurn(ds, fence.turnId);
      } catch (err) {
        logger.warn(`[recovery] limited failed-turn record retry deferred: ${err instanceof Error ? err.message : String(err)}`);
        delayMs = Math.min(delayMs * 2, 30_000);
        schedule();
      }
    }, delayMs);
    timer.unref();
    limitedFailedTurnRecordRetries.set(ds, { timer, turnId });
  };
  schedule();
}

function retryLimitedFailedTurnClear(
  ds: DaemonSession,
  record: FailedTurnRecord,
  authorization?: { currentGenerationCompleted?: boolean },
): void {
  cancelLimitedFailedTurnClearRetry(ds);
  const fence = {
    sessionId: ds.session.sessionId,
    worker: ds.worker,
    workerGeneration: ds.workerGeneration,
    sessionWorkerGeneration: ds.session.workerGeneration,
    lastCliInputTurnId: ds.lastCliInputTurnId,
    turnId: record.turnId,
    failedAt: record.failedAt,
    currentGenerationCompleted: authorization?.currentGenerationCompleted === true,
  };
  let delayMs = 500;
  const schedule = (): void => {
    const timer = setTimeout(() => {
      if (limitedFailedTurnClearRetries.get(ds)?.timer !== timer) return;
      limitedFailedTurnClearRetries.delete(ds);
      // Six-way fence: active session ownership, worker generation, current
      // input turn, active usageLimit (exempted ONLY for current-generation
      // completed terminal), and exact unclaimed provisional snapshot identity.
      if (findActiveBySessionId(fence.sessionId) !== ds
        || ds.session.status !== 'active'
        || ds.worker !== fence.worker
        || ds.workerGeneration !== fence.workerGeneration
        || ds.session.workerGeneration !== fence.sessionWorkerGeneration
        || ds.lastCliInputTurnId !== fence.lastCliInputTurnId) {
        return;
      }
      if (ds.usageLimit?.limited && !fence.currentGenerationCompleted) {
        return;
      }
      const current = ds.session.lastFailedTurn;
      if (!current?.limitedSnapshot
        || current.recovery
        || current.turnId !== fence.turnId
        || current.failedAt !== fence.failedAt) {
        return;
      }
      delete ds.session.lastFailedTurn;
      try {
        store.updateSession(ds.session);
      } catch (err) {
        ds.session.lastFailedTurn = current;
        logger.warn(`[recovery] limited failed-turn cleanup retry deferred: ${err instanceof Error ? err.message : String(err)}`);
        delayMs = Math.min(delayMs * 2, 30_000);
        schedule();
      }
    }, delayMs);
    timer.unref();
    limitedFailedTurnClearRetries.set(ds, {
      timer,
      turnId: record.turnId,
      failedAt: record.failedAt,
      worker: fence.worker,
      workerGeneration: fence.workerGeneration,
      sessionWorkerGeneration: fence.sessionWorkerGeneration,
      currentGenerationCompleted: fence.currentGenerationCompleted,
    });
  };
  schedule();
}

/** Some structured quota failures have no turn_terminal. Record their input
 * once at the native limited edge, while the authenticated turn still exists.
 * Unclaimed provisional snapshots also track live `directFailure` proof updates
 * and revocations without ever mutating real terminals or claimed recoveries. */
export function recordLimitedFailedTurn(ds: DaemonSession, turnId: string | undefined): void {
  if (!turnId || ds.lastCliInputTurnId !== turnId || !ds.usageLimit?.limited) return;
  // This snapshot exists for limits that never reach turn_terminal. Once the
  // turn has an observed terminal, recordFailedTurnTerminal owns its outcome; a
  // later `limited` frame is the sticky ds.usageLimit carried past the turn, not
  // a new failure. A recovery turn keeps its caller in failedTurnRecovery after
  // the terminal, so without this an answered recovery is recorded as
  // rate_limited and offered for replay.
  if (ds.terminalIdentityTurnIds?.has(turnId)) return;

  const previous = ds.session.lastFailedTurn;
  if (previous?.turnId === turnId) {
    if (!previous.limitedSnapshot || previous.recovery) return;
    if (failedTurnDirectFailureProofMatches(previous, ds.usageLimit)) {
      cancelLimitedFailedTurnRecordRetry(ds);
      return;
    }
    const updated = syncFailedTurnDirectFailureProof(previous, ds.usageLimit);
    ds.session.lastFailedTurn = updated;
    try {
      store.updateSession(ds.session);
      cancelLimitedFailedTurnRecordRetry(ds);
    } catch (err) {
      ds.session.lastFailedTurn = previous;
      retryLimitedFailedTurnRecord(ds, turnId);
      throw err;
    }
    return;
  }

  const caller = failedTurnCaller(ds, turnId);
  if (!caller) return;
  const record = buildFailedTurnRecord({
    turnId,
    status: 'failed',
    errorCode: `${ds.usageLimit.kind}_limited`,
  }, {
    userPrompt: ds.lastUserPrompt, cliInput: ds.lastCliInput,
    hookEnvelope: ds.lastHookEnvelope ?? ds.session.lastHookEnvelope,
    codexAppInput: ds.lastCodexAppInput,
    attachments: ds.session.lastAttachments, trustedCaller: caller, silent: isSilentScheduledTurn(ds, turnId),
    originalTurnId: ds.session.failedTurnRecovery?.turnId === turnId
      ? ds.session.failedTurnRecovery.originalTurnId : turnId,
  });
  if (record) {
    record.limitedSnapshot = true;
    ds.session.lastFailedTurn = syncFailedTurnDirectFailureProof(record, ds.usageLimit);
    try {
      store.updateSession(ds.session);
      cancelLimitedFailedTurnRecordRetry(ds);
    } catch (err) {
      ds.session.lastFailedTurn = previous;
      retryLimitedFailedTurnRecord(ds, turnId);
      throw err;
    }
  }
}

/** Invalidate only unclaimed provisional observations. Durable recovery
 * receipts and real failed terminals must survive status/terminal updates.
 * Validates provisional status and `turnId` BEFORE cancelling any pending retry
 * so an unrelated turn cannot cancel another turn's sole cleanup timer, and
 * preserves any `currentGenerationCompleted` authorization across follow-up calls. */
export function clearLimitedFailedTurn(
  ds: DaemonSession,
  turnId?: string,
  authorization?: { currentGenerationCompleted?: boolean },
): void {
  const record = ds.session.lastFailedTurn;
  if (!record?.limitedSnapshot || record.recovery || (turnId !== undefined && record.turnId !== turnId)) return;
  cancelLimitedFailedTurnRecordRetry(ds);
  const existing = limitedFailedTurnClearRetries.get(ds);
  const preservedCompletedAuth = Boolean(
    existing?.currentGenerationCompleted
    && existing.turnId === record.turnId
    && existing.failedAt === record.failedAt
    && existing.worker === ds.worker
    && existing.workerGeneration === ds.workerGeneration
    && existing.sessionWorkerGeneration === ds.session.workerGeneration,
  );
  const effectiveAuthorization = authorization?.currentGenerationCompleted || preservedCompletedAuth
    ? { currentGenerationCompleted: true }
    : authorization;
  cancelLimitedFailedTurnClearRetry(ds);
  delete ds.session.lastFailedTurn;
  try {
    store.updateSession(ds.session);
  } catch (err) {
    ds.session.lastFailedTurn = record;
    logger.warn(`[recovery] limited failed-turn cleanup failed; scheduling retry: ${err instanceof Error ? err.message : String(err)}`);
    retryLimitedFailedTurnClear(ds, record, effectiveAuthorization);
  }
}

/** Terminal bookkeeping shares the provisional snapshot's lifecycle owner.
 * The caller/silent facts are captured by the daemon before releasing the
 * active turn; a late terminal must not erase an already-claimed receipt. */
export function recordFailedTurnTerminal(
  ds: DaemonSession,
  terminal: { turnId: string; status: string; errorCode?: string; retryable?: boolean; directFailure?: true },
  context: { workerGeneration: number; caller: TrustedCaller | undefined; silent: boolean },
): void {
  const pendingRecordRetry = limitedFailedTurnRecordRetries.get(ds);
  if (pendingRecordRetry?.turnId === terminal.turnId) {
    cancelLimitedFailedTurnRecordRetry(ds);
  }
  if (terminal.status === 'completed' && ds.session.workerGeneration === context.workerGeneration) {
    clearLimitedFailedTurn(ds, terminal.turnId, { currentGenerationCompleted: true });
  }
  if (terminal.status !== 'failed' && terminal.status !== 'ambiguous') return;
  // A fail-closed refusal of synthetic maintenance is expected operational
  // state, not a failed human turn. Recording it would reuse ds.lastCliInput
  // from the previous human turn and make /retry replay already-completed work.
  if (isAutoCompactSafeComposerRefusal(terminal)) return;
  if (ds.lastCliInputTurnId !== terminal.turnId
      || ds.session.lastFailedTurn?.turnId === terminal.turnId && ds.session.lastFailedTurn.recovery) return;
  const originalTurnId = ds.session.failedTurnRecovery?.turnId === terminal.turnId
    ? ds.session.failedTurnRecovery.originalTurnId : terminal.turnId;
  const crossChatOrigin = failedTurnCrossChatOrigin(ds.session, terminal.turnId)
    ?? (originalTurnId ? failedTurnCrossChatOrigin(ds.session, originalTurnId) : undefined);
  const record = buildFailedTurnRecord({ ...terminal, status: terminal.status }, {
    userPrompt: ds.lastUserPrompt, cliInput: ds.lastCliInput,
    hookEnvelope: ds.lastHookEnvelope ?? ds.session.lastHookEnvelope,
    codexAppInput: ds.lastCodexAppInput,
    attachments: ds.session.lastAttachments, trustedCaller: context.caller, silent: context.silent,
    originalTurnId,
  });
  // Where its answer was to go is known only now (HTTP and suppression state
  // is dropped once the terminal settles): freeze it for the rewind decision.
  if (record?.directFailure && !context.silent && turnAnswersInChat(ds, terminal.turnId)) record.answersInChat = true;
  if (record && crossChatOrigin) record.crossChatOrigin = crossChatOrigin;
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

function newerInput(ds: DaemonSession, record: FailedTurnRecord, allowRecoveryTurnId?: string): boolean {
  const activeTurnId = ds.activeInteractiveTurn?.turnId;
  const activeIsForeign = Boolean(
    activeTurnId && activeTurnId !== record.turnId && activeTurnId !== allowRecoveryTurnId,
  );
  const lastInputIsForeign = Boolean(
    ds.lastCliInputTurnId
    && ds.lastCliInputTurnId !== record.turnId
    && ds.lastCliInputTurnId !== allowRecoveryTurnId,
  );
  const failedAtMs = Date.parse(record.failedAt);
  const directTerminalAfterFailure = ds.lastDirectTerminalInputAt !== undefined
    && ds.lastDirectTerminalInputAt > failedAtMs;
  return ['backoff', 'dispatching'].includes(ds.session.ordinaryTurnRecovery?.status ?? '')
    || hasProtectedSessionMutationOwnership(ds)
    || !!ds.pendingPrompt || !!ds.pendingFollowUps?.length || !!ds.pendingFollowUpTurnIds?.length
    || activeIsForeign
    || lastInputIsForeign
    || directTerminalAfterFailure
    || ds.lastMessageAt > failedAtMs
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
  if (old.crossChatOrigin
      || failedTurnCrossChatOrigin(row, old.turnId)
      || failedTurnCrossChatOrigin(row, old.originalTurnId ?? old.turnId)) {
    return { ok: false, error: 'original_actor_unavailable' };
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
      if (record.crossChatOrigin
          || failedTurnCrossChatOrigin(ds.session, record.turnId)
          || failedTurnCrossChatOrigin(ds.session, record.originalTurnId ?? record.turnId)) {
        return { ok: false, error: 'original_actor_unavailable' };
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
          if (transaction.cancelled || newerInput(ds, record, turnId)) return setState('cancelled');
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
          store.updateSession(created, { modelPinWrite: true });
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
        // The mutable reply cursor belongs only to chat-scope routing. Thread
        // ingress updates replyTargets but never advances this cursor; recovery
        // must not manufacture chat routing state for a thread session.
        target.currentReplyTarget = target.scope === 'chat'
          ? { rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId,
            turnId, updatedAt: new Date().toISOString() }
          : undefined;
        target.session.currentReplyTarget = target.currentReplyTarget
          ? { ...target.currentReplyTarget } : undefined;
        const codexAppInput = record.codexAppInput
          ? (({ clientUserMessageId: _oldId, ...input }) => input)(record.codexAppInput) : undefined;
        const input: CliTurnPayload = request.mode === 'fresh'
          ? buildFollowUpCliInput(record.userPrompt, target.session.sessionId, {
            larkAppId: target.larkAppId, chatId: target.chatId, cliId: target.session.cliId,
            locale: localeForBot(target.larkAppId), turnId, codexAppText: codexAppInput?.text,
            attachments: record.attachments,
          })
          : {
            content: record.cliInput,
            ...(codexAppInput ? { codexAppInput } : {}),
            ...(record.attachments?.length ? { attachments: structuredClone(record.attachments) } : {}),
          };
        if (request.mode === 'fresh' && codexAppInput) {
          input.codexAppInput = { ...(input.codexAppInput ?? { text: codexAppInput.text }),
            ...(codexAppInput.localImages ? { localImages: structuredClone(codexAppInput.localImages) } : {}) };
        }
        store.updateSession(target.session);
        persistRecord();
        await prepareFailedTurnRecoveryIdentity(target, turnId);
        if (record.silent) armSilentScheduledTurn(target, turnId);
        // Synchronous final check + worker admission is the linearization edge.
        if (transaction.cancelled || newerInput(ds, record, turnId) || (target !== ds && target.lastDirectTerminalInputAt !== undefined)) {
          abandonUndispatched();
          return setState('cancelled');
        }
        const willUseLiveWorker = !!(target.worker && !target.worker.killed);
        const replayed = request.mode === 'retry'
          ? prepareHookEnvelopeForReplay({
            ds: target,
            content: input.content,
            turnId,
            hookEnvelope: record.hookEnvelope,
            willUseLiveWorker,
          })
          : undefined;
        const dispatchInput: CliTurnPayload = replayed
          ? { ...input, content: replayed.content, ...(replayed.hookEnvelope ? { hookEnvelope: replayed.hookEnvelope } : {}) }
          : input;
        let rejected = false;
        ipcAttempted = true;
        const accepted = willUseLiveWorker
          ? sendWorkerInput(target, dispatchInput, turnId, { trustedCaller: recoveredCaller, atMostOnce: true })
          : forkWorker(target, dispatchInput, { resume: request.mode === 'retry' && target.hasHistory,
            turnId, trustedCaller: recoveredCaller, atMostOnce: true }, {
            onAdmission: admission => { rejected = admission === 'rejected'; },
          });
        if (!accepted || rejected) return setState('dispatch_unknown');
        rememberLastCliInput(target, record.userPrompt, dispatchInput, turnId);
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
