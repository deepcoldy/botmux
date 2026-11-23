/**
 * Same-bot quota fallback chain: when a session's CLI reports a usage or rate
 * limit, restart that session in place on the next CLI/model of its bot's
 * `quotaFallbackChain` and continue the interrupted request.
 *
 *  - Same CLI, new model: the native conversation is resumed with the new
 *    launch model and receives a continuation of the interrupted request.
 *  - New CLI: the session starts a fresh native conversation whose opening
 *    turn is a handoff (topic history, previous transcript, workspace check)
 *    followed by the interrupted request.
 *
 * A rate limit without a provider reset time is first retried on the same CLI
 * (QUOTA_FALLBACK_SAME_CLI_RETRIES times, growing delay); a quota with a stated
 * reset time switches at once.
 *
 * The continuation runs as the interrupted turn's original caller and lands
 * at its original reply destination, the same way the failure card's retry
 * re-delivers a turn (ordinary-recovery-retry.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { CliId } from '../adapters/cli/types.js';
import type { CliTurnPayload, Session, SessionCliLaunchSnapshotV1, TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { getBot } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import { resolveSessionTranscriptPath } from '../services/transcript-resolver.js';
import { cancelOrdinaryTurnRecoveryForUserInput } from '../services/ordinary-turn-recovery.js';
import type { QuotaFallbackKind } from '../services/quota-fallback.js';
import {
  buildQuotaFallbackPrompt,
  nextQuotaFallbackStep,
  quotaFallbackAgentLabel,
  type QuotaFallbackSessionState,
} from '../services/quota-fallback-chain.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import { cliSelectionSnapshot } from './cli-selection-snapshot.js';
import { failedTurnCaller, recoverFailedTurn } from './failed-turn-recovery.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { sessionPromptInjection, supportsZeroPromptInjectionForBot } from './prompt-injection.js';
import { noteReplyCardTurnStarted } from './reply-card-turn-start.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { isSharedAdoptSession } from './shared-adopt.js';
import { armSilentScheduledTurn, isSilentScheduledTurn } from './silent-schedule-turns.js';
import {
  buildFollowUpCliInput,
  buildNewTopicCliInput,
  persistStreamCardState,
  rememberLastCliInput,
} from './session-manager.js';
import {
  destroyLivePaneBeforeRestart,
  findActiveBySessionId,
  forkWorker,
  isSessionRestartInFlight,
  isSessionTransferring,
  killWorker,
  prepareFailedTurnRecoveryIdentity,
  waitForWorkerExit,
  WORKER_SIGKILL_BACKSTOP_MS,
} from './worker-pool.js';

export const QUOTA_FALLBACK_TURN_PREFIX = 'bmx-quota-fallback-';
/** Same-CLI retries of a transient rate limit before the chain switches. */
export const QUOTA_FALLBACK_SAME_CLI_RETRIES = 5;
const SAME_CLI_RETRY_BASE_DELAY_MS = 30_000;
/** Outlasts killWorker's SIGTERM/SIGKILL backstop, so a hung worker is gone in time. */
const WORKER_EXIT_WAIT_MS = WORKER_SIGKILL_BACKSTOP_MS + 1_000;
const MUTATION_ACQUIRE_TIMEOUT_MS = 5_000;

export interface QuotaFallbackChainTrigger {
  kind: QuotaFallbackKind;
  /** A rate limit without a provider reset time: retried on the same CLI first. */
  transient?: boolean;
  /** Turn the limit interrupted; it must be the session's last CLI input. */
  sourceTurnId: string | undefined;
  /** Worker generation that observed the limit. */
  worker: ChildProcess;
  /** Topic reply routed to the interrupted turn. */
  reply: (text: string) => Promise<unknown>;
  /** The limit's usual handling, run when the switch does not start. */
  fallThrough?: () => void;
}

interface PlannedSwitch {
  next: QuotaFallbackSessionState;
  freshCli: boolean;
  from: string;
  to: string;
  fromCliId: CliId;
  sourceTurnId: string;
  /** The user's turn that the source turn retries or continues. */
  logicalTurnId: string;
  userPrompt: string;
  caller: TrustedCaller;
}

function hasNewerInput(ds: DaemonSession): boolean {
  return Boolean(ds.pendingPrompt || ds.pendingFollowUps?.length || ds.pendingFollowUpTurnIds?.length);
}

function planSwitch(ds: DaemonSession, trigger: QuotaFallbackChainTrigger): PlannedSwitch | undefined {
  const botCfg = getBot(ds.larkAppId).config;
  const planned = nextQuotaFallbackStep(botCfg.quotaFallbackChain, ds.session.quotaFallback, trigger.kind);
  if (!planned) return undefined;
  const fromCliId = ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? botCfg.cliId;
  // The chain starts from the bot's own CLI. A session moved by `/cli` is not on it.
  if (fromCliId !== (ds.session.quotaFallback?.cliId ?? botCfg.cliId)) return undefined;
  if (!ds.session.quotaFallback && ds.session.cliLaunchSnapshot) return undefined;

  const sourceTurnId = trigger.sourceTurnId;
  const userPrompt = ds.lastUserPrompt?.trim();
  if (!sourceTurnId || ds.lastCliInputTurnId !== sourceTurnId || !userPrompt) return undefined;
  if (ds.session.status !== 'active' || ds.worker !== trigger.worker || trigger.worker.killed) return undefined;
  if (ds.suppressRecoveryCard || ds.session.adoptedFrom || isSharedAdoptSession(ds)
    || isRemoteBackendSession(ds) || isSessionTransferring(ds) || hasProtectedSessionMutationOwnership(ds)
    || ds.session.pendingForkSession || isSessionRestartInFlight(ds)
    || ds.session.dispatchLaunchSpec || ds.session.codexProfile || ds.session.cliInstanceBinding
    || ds.session.principalLane || ds.session.workspaceRetirement || ds.session.vcMeetingReceiver) {
    return undefined;
  }
  // HTTP callers already received this turn's failure; a replay would answer nobody.
  if (hasNewerInput(ds) || ds.pendingWaitPromises?.has(sourceTurnId) || ds.asyncTriggerResults?.has(sourceTurnId)) {
    return undefined;
  }
  // Like the failure card's retry, the continuation runs only as a known original caller.
  const caller = failedTurnCaller(ds, sourceTurnId);
  if (!caller) return undefined;
  const freshCli = planned.state.cliId !== fromCliId;
  if (freshCli && (botCfg.riff !== undefined
    || (sessionPromptInjection(ds) === 'none' && !supportsZeroPromptInjectionForBot(planned.state.cliId, botCfg)))) {
    return undefined;
  }
  return {
    next: planned.state,
    freshCli,
    from: quotaFallbackAgentLabel(fromCliId, ds.session.model),
    to: quotaFallbackAgentLabel(planned.state.cliId, planned.state.model),
    fromCliId,
    sourceTurnId,
    logicalTurnId: ds.session.failedTurnRecovery?.turnId === sourceTurnId
      ? ds.session.failedTurnRecovery.originalTurnId : sourceTurnId,
    userPrompt,
    caller,
  };
}

function previousTranscriptPath(ds: DaemonSession, cliId: CliId): string | undefined {
  try {
    return resolveSessionTranscriptPath({
      cliId,
      sessionId: ds.session.sessionId,
      cliSessionId: ds.session.cliSessionId,
      cwd: ds.workingDir ?? ds.session.workingDir,
      larkAppId: ds.larkAppId,
      fresh: true,
    })?.path;
  } catch {
    return undefined;
  }
}

/** Clear everything that belongs to the previous CLI's native conversation. */
function applyFreshCliLaunch(ds: DaemonSession, snapshot: SessionCliLaunchSnapshotV1): void {
  const s = ds.session;
  s.cliLaunchSnapshot = snapshot;
  s.cliSessionId = undefined;
  s.pendingForkSession = undefined;
  s.cliConfigDir = undefined;
  s.codexModelSelection = undefined;
  s.traexAutoModelRuntime = undefined;
  s.traexNativeContextReceipt = undefined;
  s.terminalEffortPreferenceEdit = undefined;
  s.topicReasoningEffort = undefined;
  s.modelFallback = undefined;
  ds.hasHistory = false;
}

function buildInput(ds: DaemonSession, plan: PlannedSwitch, prompt: string, turnId: string,
  snapshot: SessionCliLaunchSnapshotV1 | undefined, caller: TrustedCaller, locale: Locale): CliTurnPayload {
  if (!snapshot) {
    return buildFollowUpCliInput(prompt, ds.session.sessionId, {
      larkAppId: ds.larkAppId, chatId: ds.chatId, cliId: plan.next.cliId, locale, turnId,
    });
  }
  const bot = getBot(ds.larkAppId);
  return buildNewTopicCliInput(
    prompt, ds.session.sessionId, plan.next.cliId, snapshot.cliPathOverride ?? undefined,
    undefined, undefined, undefined, undefined,
    { name: bot.botName, openId: bot.botOpenId }, locale, undefined,
    {
      larkAppId: ds.larkAppId,
      chatId: ds.session.chatId,
      whiteboardId: ds.session.whiteboardId,
      trustedCaller: caller,
      promptInjection: sessionPromptInjection(ds),
      larkToolResume: false,
      turnId,
    },
  );
}

type SwitchOutcome = 'switched' | 'declined' | 'gone' | 'failed';

/** Launch decisions and native ids the switch rewrites; restored if the new CLI never starts. */
const SWITCHED_SESSION_FIELDS = [
  'cliId', 'cliRuntime', 'cliPathOverride', 'cliConfigDir', 'wrapperCli', 'cliLaunchMode', 'agentFrozen',
  'cliLaunchSnapshot', 'model', 'modelBackendVariant', 'reasoningEffort', 'serviceTier', 'quotaFallback', 'cliSessionId',
  'pendingForkSession', 'codexModelSelection', 'traexAutoModelRuntime', 'traexNativeContextReceipt',
  'terminalEffortPreferenceEdit', 'topicReasoningEffort', 'modelFallback', 'lastFailedTurn',
] as const satisfies readonly (keyof Session)[];

async function runSwitch(ds: DaemonSession, trigger: QuotaFallbackChainTrigger, plan: PlannedSwitch, locale: Locale): Promise<SwitchOutcome> {
  const gate = await tryWithBotTurnMutation(ds.larkAppId, MUTATION_ACQUIRE_TIMEOUT_MS, async (): Promise<SwitchOutcome> => {
    const registered = (): boolean => findActiveBySessionId(ds.session.sessionId) === ds && ds.session.status === 'active';
    const owned = (): boolean => registered() && ds.worker === trigger.worker
      && ds.lastCliInputTurnId === plan.sourceTurnId && !hasNewerInput(ds);
    if (!owned()) return 'declined';

    const { sourceTurnId, userPrompt, caller } = plan;
    const snapshot = plan.freshCli
      ? { ...cliSelectionSnapshot(plan.next.cliId), model: plan.next.model ?? null }
      : undefined;
    const prompt = buildQuotaFallbackPrompt({
      freshCli: plan.freshCli,
      from: plan.from,
      to: plan.to,
      userPrompt,
      transcriptPath: plan.freshCli ? previousTranscriptPath(ds, plan.fromCliId) : undefined,
      locale,
    });
    const turnId = caller.source === 'schedule_creator' && caller.taskId
      ? `schedule:${caller.taskId}:${randomUUID()}` : `${QUOTA_FALLBACK_TURN_PREFIX}${randomUUID()}`;
    const recoveredCaller: TrustedCaller = {
      ...caller, source: caller.source === 'schedule_creator' ? caller.source : 'failed_turn_recovery',
    };

    const previous = {
      active: ds.activeInteractiveTurn,
      reply: ds.currentReplyTarget,
      failedTurnRecovery: ds.session.failedTurnRecovery,
      replyTargets: ds.session.replyTargets,
      turnReplyContexts: ds.session.turnReplyContexts,
      spawnModelOverride: ds.spawnModelOverride,
      launch: structuredClone(Object.fromEntries(SWITCHED_SESSION_FIELDS.map(key => [key, ds.session[key]]))),
    };
    const restoreRouting = (): void => {
      ds.activeInteractiveTurn = previous.active;
      ds.currentReplyTarget = previous.reply;
      ds.session.currentReplyTarget = previous.reply ? { ...previous.reply } : undefined;
      ds.session.failedTurnRecovery = previous.failedTurnRecovery;
      ds.session.replyTargets = previous.replyTargets;
      ds.session.turnReplyContexts = previous.turnReplyContexts;
    };
    const restoreLaunch = (): void => {
      const session = ds.session as unknown as Record<string, unknown>;
      for (const key of SWITCHED_SESSION_FIELDS) {
        if (previous.launch[key] === undefined) delete session[key];
        else session[key] = previous.launch[key];
      }
      // The interrupted turn reached the previous CLI, whose pane is gone now: resume it.
      ds.hasHistory = true;
      ds.spawnModelOverride = previous.spawnModelOverride;
    };
    const persistBestEffort = (): void => {
      try { sessionStore.updateSession(ds.session); } catch { /* the next session write carries it */ }
    };

    try {
      // Same destination and sender as the interrupted turn.
      const updatedAt = new Date().toISOString();
      const priorReply = pickTurnReplyTarget(ds.session, sourceTurnId);
      const context = ds.session.turnReplyContexts?.[sourceTurnId];
      if (context !== undefined) {
        ds.session.turnReplyContexts = { ...(ds.session.turnReplyContexts ?? {}), [turnId]: structuredClone(context) };
      }
      const target = ds.session.replyTargets?.[sourceTurnId];
      ds.session.replyTargets = {
        ...(ds.session.replyTargets ?? {}),
        [turnId]: {
          ...(target ? structuredClone(target) : {}),
          senderOpenId: caller.requestUserOpenId,
          participants: target?.participants ?? (caller.requestUserOpenId
            ? [{ openId: caller.requestUserOpenId, isBot: false }] : []),
          updatedAt,
        },
      };
      ds.session.failedTurnRecovery = { originalTurnId: plan.logicalTurnId, turnId, caller: { ...caller } };
      ds.activeInteractiveTurn = { turnId, caller: recoveredCaller, userPrompt };
      if (ds.scope === 'chat') {
        ds.currentReplyTarget = { rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId, turnId, updatedAt };
        ds.session.currentReplyTarget = { ...ds.currentReplyTarget };
      }
      if (isSilentScheduledTurn(ds, sourceTurnId)) armSilentScheduledTurn(ds, turnId);
      sessionStore.updateSession(ds.session);
      await prepareFailedTurnRecoveryIdentity(ds, turnId);
    } catch (error) {
      restoreRouting();
      persistBestEffort();
      logger.warn(`[quota-chain] ${ds.session.sessionId}: continuation not prepared: ${error instanceof Error ? error.message : String(error)}`);
      return 'declined';
    }
    if (!owned()) { restoreRouting(); persistBestEffort(); return 'declined'; }

    // Point of no return: the exhausted CLI is retired.
    const retiring = trigger.worker;
    killWorker(ds);
    if (!await waitForWorkerExit(retiring, WORKER_EXIT_WAIT_MS)) {
      logger.warn(`[quota-chain] ${ds.session.sessionId}: previous worker still running after ${WORKER_EXIT_WAIT_MS}ms`);
    }
    if (!registered()) return 'gone';
    let input: CliTurnPayload | undefined;
    try {
      destroyLivePaneBeforeRestart(ds);
      ds.session.quotaFallback = plan.next;
      if (snapshot) applyFreshCliLaunch(ds, snapshot);
      // The interrupted turn reached this CLI, so its native conversation exists.
      else ds.hasHistory = true;
      ds.spawnModelOverride = undefined;
      if (ds.session.ordinaryTurnRecovery) cancelOrdinaryTurnRecoveryForUserInput(ds.session, turnId);
      const lastFailed = ds.session.lastFailedTurn;
      if (lastFailed?.limitedSnapshot && !lastFailed.recovery && lastFailed.turnId === sourceTurnId) {
        delete ds.session.lastFailedTurn;
      }
      sessionStore.updateSession(ds.session);
      const built = buildInput(ds, plan, prompt, turnId, snapshot, recoveredCaller, locale);
      let rejected = false;
      const accepted = forkWorker(ds, built, {
        resume: !plan.freshCli,
        turnId,
        trustedCaller: recoveredCaller,
        atMostOnce: true,
      }, {
        deferDuringDeviceIsolation: false,
        onAdmission: admission => { rejected = admission === 'rejected'; },
      });
      if (accepted && !rejected) input = built;
    } catch (error) {
      logger.warn(`[quota-chain] ${ds.session.sessionId}: new CLI not started: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!input) {
      // The next message resumes the previous CLI, and its next limit retries this step.
      restoreRouting();
      restoreLaunch();
      persistBestEffort();
      return 'failed';
    }
    // The new CLI already accepted the turn; bookkeeping errors must not undo it.
    try {
      rememberLastCliInput(ds, userPrompt, input, turnId);
      noteReplyCardTurnStarted(ds, turnId);
      ds.streamCardPending = true;
      persistStreamCardState(ds);
      sessionStore.updateSession(ds.session);
    } catch (error) {
      logger.warn(`[quota-chain] ${ds.session.sessionId}: post-switch bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'switched';
  });
  return gate.acquired ? gate.value : 'declined';
}

/** Re-send the rate-limited turn on the same CLI after a growing delay. A retry
 * that is not sent hands the limit back to its usual handling. */
function scheduleSameCliRetry(ds: DaemonSession, trigger: QuotaFallbackChainTrigger, plan: PlannedSwitch,
  attempt: number, tagged: string): void {
  const delayMs = SAME_CLI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  logger.info(`${tagged}: transient rate limit, same-CLI retry ${attempt}/${QUOTA_FALLBACK_SAME_CLI_RETRIES} in ${delayMs}ms`);
  const timer = setTimeout(() => {
    if (ds.quotaFallbackChainRetries?.timer === timer) ds.quotaFallbackChainRetries.timer = undefined;
    const record = ds.session.lastFailedTurn;
    const sent = record?.turnId === plan.sourceTurnId
      ? recoverFailedTurn(ds.session.sessionId, {
        turnId: record.turnId, failedAt: record.failedAt, requestId: randomUUID(), mode: 'retry',
      })
      : Promise.resolve({ ok: false as const, error: 'failure_changed' });
    void sent.then(result => {
      if (result.ok && result.state === 'accepted') {
        logger.info(`${tagged}: same-CLI retry ${attempt} sent as ${result.turnId}`);
        return;
      }
      logger.info(`${tagged}: same-CLI retry ${attempt} not sent: ${result.ok ? result.state : result.error}`);
      trigger.fallThrough?.();
    }, error => {
      logger.warn(`${tagged}: same-CLI retry ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      trigger.fallThrough?.();
    });
  }, delayMs);
  timer.unref?.();
  ds.quotaFallbackChainRetries = { logicalTurnId: plan.logicalTurnId, attempts: attempt, timer };
}

/**
 * Synchronous gate for a limit edge. Returns true when the chain owns this
 * limit, so the caller must not post the pause notice or hand the topic to a
 * backup bot itself. A switch that does not start before the exhausted CLI is
 * retired hands the limit back through `fallThrough`.
 */
export function startQuotaFallbackChainSwitch(ds: DaemonSession, trigger: QuotaFallbackChainTrigger): boolean {
  if (ds.quotaFallbackChainSwitching) return true;
  const plan = planSwitch(ds, trigger);
  if (!plan) return false;
  const locale = localeForBot(ds.larkAppId);
  const tagged = `[quota-chain] ${ds.session.sessionId}`;
  const reply = (text: string): void => {
    trigger.reply(text).catch(error => {
      logger.debug(`${tagged}: notice failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const previous = ds.quotaFallbackChainRetries;
  // A limited frame while a retry is still waiting belongs to the same attempt.
  if (previous?.timer && previous.logicalTurnId === plan.logicalTurnId) return true;
  if (previous?.timer) clearTimeout(previous.timer);
  if (trigger.transient) {
    const spent = previous?.logicalTurnId === plan.logicalTurnId ? previous.attempts : 0;
    if (spent < QUOTA_FALLBACK_SAME_CLI_RETRIES) {
      const attempt = spent + 1;
      if (attempt === 1) {
        reply(t('worker.quota_chain.retrying', { from: plan.from, to: plan.to, max: QUOTA_FALLBACK_SAME_CLI_RETRIES }, locale));
      }
      scheduleSameCliRetry(ds, trigger, plan, attempt, tagged);
      return true;
    }
  }
  ds.quotaFallbackChainRetries = undefined;
  ds.quotaFallbackChainSwitching = true;
  logger.info(`${tagged}: ${plan.from} -> ${plan.to} (step ${plan.next.step}, kind=${trigger.kind}, freshCli=${plan.freshCli})`);
  const settle = (outcome: SwitchOutcome): void => {
    logger.info(`${tagged}: switch to ${plan.to} ${outcome}`);
    if (outcome === 'switched') {
      reply(t('worker.quota_chain.switched', { from: plan.from, to: plan.to }, locale));
    } else if (outcome === 'declined') {
      trigger.fallThrough?.();
    } else if (outcome === 'failed') {
      const body = t('worker.quota_chain.switch_failed', { from: plan.from, to: plan.to }, locale);
      const owner = ds.session.ownerOpenId;
      reply(owner ? `<at id=${owner}></at> ${body}` : body);
    }
  };
  void runSwitch(ds, trigger, plan, locale)
    .then(settle, error => {
      logger.error(`${tagged}: switch to ${plan.to} threw: ${error instanceof Error ? error.message : String(error)}`);
      settle('declined');
    })
    .finally(() => { ds.quotaFallbackChainSwitching = false; });
  return true;
}
