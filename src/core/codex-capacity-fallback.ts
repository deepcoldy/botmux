/**
 * User-confirmed Codex model-capacity downgrade and lossless resume.
 *
 * When a local owned Codex CLI enters `codex_core::responses_retry` backoff on
 * `Selected model is at capacity` (observed from `<CODEX_HOME>/logs_<N>.sqlite`
 * before the 25-30 minute retry window ends), this module:
 *   1. Selects the next eligible downgrade model from the session's live/static
 *      catalogue, skipping the overloaded model and any model already overloaded
 *      earlier in the same logical turn.
 *   2. Posts a host-managed quick-choice confirmation card in Lark via
 *      `registerHostAsk` so the user explicitly decides whether to:
 *        - temporarily downgrade for this run (`spawnModelOverride`),
 *        - pin the fallback model for this topic (`session.modelPin`), or
 *        - keep waiting for Codex's built-in retries.
 *   3. On confirmation, atomically retires the stalled worker, applies the
 *      chosen model override/pin, and forks `codex resume` with the full native
 *      conversation preserved and a concise continuation prompt.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { BotConfig } from '../bot-registry.js';
import { getBot } from '../bot-registry.js';
import type { CliTurnPayload, LarkAttachment, Session, TrustedCaller } from '../types.js';
import type { DaemonSession } from './types.js';
import { advancePendingStreamingCardTurn } from './streaming-card-post-slot.js';
import * as sessionStore from '../services/session-store.js';
import { cancelOrdinaryTurnRecoveryForUserInput } from '../services/ordinary-turn-recovery.js';
import { resetCodexModelSelection } from '../services/codex-model-selection.js';
import { cliModelMayKeepReasoningEffort } from '../services/codex-reasoning-effort.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import { invalidateHostAsk, registerHostAsk } from './ask-broker.js';
import type { AskResult, CreateAskInput } from './ask-types.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import { dashboardEventBus } from './dashboard-events.js';
import { failedTurnCaller } from './failed-turn-recovery.js';
import { cliMatchesBot, retainPinEffort, validateModelPin, type ModelPin } from './model-pin.js';
import { MODEL_SLUG_PATTERN } from './model-value-pattern.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { noteReplyCardTurnStarted } from './reply-card-turn-start.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { resolveSessionLaunchModel, resolveSessionModelPinView } from './session-model.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { isSharedAdoptSession } from './shared-adopt.js';
import { armSilentScheduledTurn, isSilentScheduledTurn } from './silent-schedule-turns.js';
import {
  buildFollowUpCliInput,
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
import { canOperate } from '../im/lark/event-dispatcher.js';
import { sessionModelChoices } from '../im/lark/session-model-picker.js';

export const CODEX_CAPACITY_FALLBACK_ASK_ORIGIN = 'host_codex_capacity_fallback';
export const CODEX_CAPACITY_FALLBACK_TURN_PREFIX = 'bmx-codex-capacity-';
export const CODEX_CAPACITY_CONFIRM_TIMEOUT_MS = 5 * 60 * 1_000;
export const MAX_CODEX_CAPACITY_HOPS = 4;
const WORKER_EXIT_WAIT_MS = WORKER_SIGKILL_BACKSTOP_MS + 1_000;
const MUTATION_ACQUIRE_TIMEOUT_MS = 5_000;

export interface CodexCapacityFallbackPendingAsk {
  larkAppId: string;
  sessionId: string;
  originKind: string;
  requestId: string;
}

export interface CodexCapacityFallbackState {
  sourceTurnId: string;
  logicalTurnId: string;
  worker: ChildProcess;
  overloadedModels: string[];
  resolving?: boolean;
  pendingAsk?: CodexCapacityFallbackPendingAsk;
  declinedForTurn?: boolean;
  switching?: boolean;
  /** The source turn completed naturally while a confirmed switch was in flight. */
  terminalSettled?: boolean;
}

export interface CodexCapacityFallbackTrigger {
  turnId: string;
  nativeSessionId: string;
  model?: string;
  codexTurnId?: string;
  retryAttempt?: number;
  maxRetries?: number;
  retryDelaySec?: number;
  observedAtMs: number;
  worker: ChildProcess;
  reply: (text: string) => Promise<unknown>;
}

export interface CodexCapacityFallbackDeps {
  getBotConfig?: (appId: string) => BotConfig;
  getLocale?: (appId: string) => Locale;
  modelChoices?: (ds: DaemonSession) => Promise<readonly string[]>;
  registerAsk?: (input: CreateAskInput) => Promise<AskResult>;
  invalidateAsk?: typeof invalidateHostAsk;
  canOperate?: (appId: string, chatId: string, openId: string) => boolean;
  findActive?: (sessionId: string) => DaemonSession | undefined;
  withBotTurnMutation?: typeof tryWithBotTurnMutation;
  killWorker?: typeof killWorker;
  waitForWorkerExit?: typeof waitForWorkerExit;
  destroyLivePaneBeforeRestart?: typeof destroyLivePaneBeforeRestart;
  forkWorker?: typeof forkWorker;
  prepareRecoveryIdentity?: typeof prepareFailedTurnRecoveryIdentity;
  updateSession?: typeof sessionStore.updateSession;
  buildFollowUpInput?: typeof buildFollowUpCliInput;
  rememberLastInput?: typeof rememberLastCliInput;
  noteTurnStarted?: typeof noteReplyCardTurnStarted;
  persistStreamCard?: typeof persistStreamCardState;
  publishSessionUpdate?: (sessionId: string, patch: Record<string, unknown>) => void;
  isTransferring?: (ds: DaemonSession) => boolean;
  isRestartInFlight?: (ds: DaemonSession) => boolean;
  hasProtectedOwnership?: (ds: DaemonSession) => boolean;
  resolveCaller?: typeof failedTurnCaller;
}

/**
 * Pick the next eligible Codex downgrade model from a priority-ordered catalogue.
 *
 * Precedence:
 *   1. `preferredModel` (typically live `botCfg.model` when an older session is
 *      still stuck on a previously overloaded model), if present in the session
 *      catalogue and not excluded.
 *   2. The first valid, non-excluded model appearing AFTER `currentModel` in
 *      `availableModels` (strict downgrade along Codex's priority ladder).
 *   3. Otherwise, the first valid, non-excluded model in `availableModels`.
 */
export function selectCodexCapacityFallbackModel(options: {
  currentModel?: string;
  availableModels: readonly string[];
  preferredModel?: string;
  excludedModels?: ReadonlySet<string>;
}): string | undefined {
  const excluded = new Set<string>();
  if (options.currentModel?.trim()) excluded.add(options.currentModel.trim().toLowerCase());
  if (options.excludedModels) {
    for (const model of options.excludedModels) {
      const normalized = model.trim().toLowerCase();
      if (normalized) excluded.add(normalized);
    }
  }

  const validModels: string[] = [];
  const seen = new Set<string>();
  for (const raw of options.availableModels) {
    const slug = raw.trim();
    const key = slug.toLowerCase();
    if (!slug || !MODEL_SLUG_PATTERN.test(slug) || seen.has(key)) continue;
    seen.add(key);
    validModels.push(slug);
  }
  if (validModels.length === 0) return undefined;

  const preferred = options.preferredModel?.trim();
  if (preferred && MODEL_SLUG_PATTERN.test(preferred)) {
    const preferredKey = preferred.toLowerCase();
    if (!excluded.has(preferredKey)) {
      const catalogMatch = validModels.find(model => model.toLowerCase() === preferredKey);
      if (catalogMatch) return catalogMatch;
    }
  }

  const currentKey = options.currentModel?.trim().toLowerCase();
  const currentIdx = currentKey
    ? validModels.findIndex(model => model.toLowerCase() === currentKey)
    : -1;
  if (currentIdx >= 0) {
    for (let i = currentIdx + 1; i < validModels.length; i++) {
      const candidate = validModels[i]!;
      if (!excluded.has(candidate.toLowerCase())) return candidate;
    }
  }

  return validModels.find(model => !excluded.has(model.toLowerCase()));
}

/** Continuation prompt delivered to the resumed native Codex conversation. */
export function buildCodexCapacityFallbackPrompt(input: {
  fromModel: string;
  toModel: string;
  userPrompt: string;
  locale: Locale;
}): string {
  const header = t('worker.codex_capacity_fallback.continue_prompt', {
    fromModel: input.fromModel,
    toModel: input.toModel,
  }, input.locale);
  const label = t('worker.codex_capacity_fallback.request_label', undefined, input.locale);
  return `${header}\n\n${label}\n${input.userPrompt}`;
}

function hasNewerInput(ds: DaemonSession): boolean {
  return Boolean(ds.pendingPrompt || ds.pendingFollowUps?.length || ds.pendingFollowUpTurnIds?.length);
}

function sessionEffectiveCliId(ds: DaemonSession, botCfg: BotConfig): string {
  return ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? botCfg.cliId;
}

function isSameHumanOpenId(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('ou_');
}

function choiceFromAskResult(result: AskResult): 'temporary' | 'pin' | 'wait' | undefined {
  if (result.kind !== 'answered') return undefined;
  const raw = result.answers[0]?.[0];
  return raw === 'temporary' || raw === 'pin' || raw === 'wait' ? raw : undefined;
}

/** Launch fields that a downgrade rewrites; restored atomically if `forkWorker` fails. */
const SWITCHED_SESSION_FIELDS = [
  'model', 'modelPin', 'codexModelSelection', 'quotaFallback', 'lastFailedTurn',
] as const satisfies readonly (keyof Session)[];

/** Invalidate any open capacity-downgrade confirmation card and clear stale state. */
export function settleCodexCapacityFallback(
  ds: DaemonSession,
  reason: string,
  turnId?: string,
  deps: Pick<CodexCapacityFallbackDeps, 'invalidateAsk'> = {},
): void {
  const state = ds.codexCapacityFallback;
  if (!state) return;
  if (turnId && state.sourceTurnId !== turnId && state.logicalTurnId !== turnId) return;
  const invalidate = deps.invalidateAsk ?? invalidateHostAsk;
  if (state.pendingAsk) {
    const ask = state.pendingAsk;
    state.pendingAsk = undefined;
    try { invalidate(ask, reason); } catch { /* best effort */ }
  }
  if (state.switching) {
    // A natural answer is an external cancellation, unlike the kill/new-generation
    // notifications produced by this switch itself. Keep the state as the switch's
    // ownership token, but make every subsequent checkpoint refuse the resume.
    if (reason === 'final_output' || reason.startsWith('turn_terminal:')) {
      state.terminalSettled = true;
    }
    return;
  }
  ds.codexCapacityFallback = undefined;
}

interface SwitchPlan {
  fromModel: string;
  toModel: string;
  mode: 'temporary' | 'pin';
  actorOpenId: string | null;
  sourceTurnId: string;
  logicalTurnId: string;
  userPrompt: string;
  attachments?: LarkAttachment[];
  caller: TrustedCaller;
  overloadedModels: string[];
}

type DowngradeOutcome = 'switched' | 'declined' | 'gone' | 'failed' | 'rollback_failed';

async function runDowngrade(
  ds: DaemonSession,
  trigger: CodexCapacityFallbackTrigger,
  plan: SwitchPlan,
  state: CodexCapacityFallbackState,
  locale: Locale,
  deps: CodexCapacityFallbackDeps,
): Promise<DowngradeOutcome> {
  const withMutation = deps.withBotTurnMutation ?? tryWithBotTurnMutation;
  const findActive = deps.findActive ?? findActiveBySessionId;
  const retireWorker = deps.killWorker ?? killWorker;
  const waitExit = deps.waitForWorkerExit ?? waitForWorkerExit;
  const destroyPane = deps.destroyLivePaneBeforeRestart ?? destroyLivePaneBeforeRestart;
  const startWorker = deps.forkWorker ?? forkWorker;
  const prepareIdentity = deps.prepareRecoveryIdentity ?? prepareFailedTurnRecoveryIdentity;
  const updateSession = deps.updateSession ?? sessionStore.updateSession;
  const buildFollowUp = deps.buildFollowUpInput ?? buildFollowUpCliInput;
  const rememberInput = deps.rememberLastInput ?? rememberLastCliInput;
  const noteStarted = deps.noteTurnStarted ?? noteReplyCardTurnStarted;
  const persistCard = deps.persistStreamCard ?? persistStreamCardState;
  const getBotConfig = deps.getBotConfig ?? (appId => getBot(appId).config);
  const publishUpdate = deps.publishSessionUpdate ?? ((sessionId, patch) => {
    dashboardEventBus.publish({ type: 'session.update', body: { sessionId, patch } });
  });

  const switchCancelled = (): boolean => state.terminalSettled === true || ds.codexCapacityFallback !== state;
  const cancelledOutcome = (): DowngradeOutcome => switchCancelled() ? 'gone' : 'declined';

  const gate = await withMutation(ds.larkAppId, MUTATION_ACQUIRE_TIMEOUT_MS, async (): Promise<DowngradeOutcome> => {
    const registered = (): boolean => findActive(ds.session.sessionId) === ds && ds.session.status === 'active';
    const owned = (): boolean => !switchCancelled() && registered() && ds.worker === trigger.worker && !trigger.worker.killed
      && ds.lastCliInputTurnId === plan.sourceTurnId && !hasNewerInput(ds)
      && Boolean(ds.session.cliSessionId);
    if (!owned()) return cancelledOutcome();

    const botCfg = getBotConfig(ds.larkAppId);
    const cliId = 'codex' as const;
    let nextPin: ModelPin | undefined;
    if (plan.mode === 'pin') {
      if (!plan.actorOpenId) return 'declined';
      const candidatePin = retainPinEffort(
        {
          model: plan.toModel,
          source: 'card',
          setBy: plan.actorOpenId,
          setAt: new Date().toISOString(),
        },
        ds.session.modelPin,
        cliId,
      );
      if (candidatePin.effort && !cliModelMayKeepReasoningEffort(cliId, candidatePin.model, candidatePin.effort)) {
        delete candidatePin.effort;
      }
      const pinError = validateModelPin(candidatePin, {
        cliId,
        backendType: ds.initConfig?.backendType ?? ds.session.backendType ?? botCfg.backendType,
      });
      if (pinError) return 'declined';
      nextPin = candidatePin;
    }

    const turnId = plan.caller.source === 'schedule_creator' && plan.caller.taskId
      ? `schedule:${plan.caller.taskId}:${randomUUID()}`
      : `${CODEX_CAPACITY_FALLBACK_TURN_PREFIX}${randomUUID()}`;
    const recoveredCaller: TrustedCaller = {
      ...plan.caller,
      source: plan.caller.source === 'schedule_creator' ? plan.caller.source : 'failed_turn_recovery',
    };
    const prompt = buildCodexCapacityFallbackPrompt({
      fromModel: plan.fromModel,
      toModel: plan.toModel,
      userPrompt: plan.userPrompt,
      locale,
    });

    const previous = {
      active: ds.activeInteractiveTurn,
      reply: ds.currentReplyTarget,
      failedTurnRecovery: ds.session.failedTurnRecovery,
      spawnModelOverride: ds.spawnModelOverride,
      modelPinCleared: ds.modelPinCleared,
      launch: structuredClone(Object.fromEntries(SWITCHED_SESSION_FIELDS.map(key => [key, ds.session[key]]))),
    };
    const restoreRouting = (naturalTerminal = false): void => {
      // Undo only routing still owned by THIS continuation. Whole-object snapshot
      // restoration can overwrite terminal/new-input work that ran while we awaited.
      if (ds.activeInteractiveTurn?.turnId === turnId) {
        ds.activeInteractiveTurn = naturalTerminal ? undefined : previous.active;
      }
      if (ds.currentReplyTarget?.turnId === turnId) {
        ds.currentReplyTarget = naturalTerminal ? undefined : previous.reply;
      }
      if (ds.session.currentReplyTarget?.turnId === turnId) {
        ds.session.currentReplyTarget = naturalTerminal ? undefined : previous.reply ? { ...previous.reply } : undefined;
      }
      if (ds.session.failedTurnRecovery?.turnId === turnId) {
        ds.session.failedTurnRecovery = previous.failedTurnRecovery;
      }
      if (ds.session.replyTargets?.[turnId]) {
        const next = { ...ds.session.replyTargets };
        delete next[turnId];
        ds.session.replyTargets = Object.keys(next).length > 0 ? next : undefined;
      }
      if (ds.session.turnReplyContexts?.[turnId]) {
        const next = { ...ds.session.turnReplyContexts };
        delete next[turnId];
        ds.session.turnReplyContexts = Object.keys(next).length > 0 ? next : undefined;
      }
    };
    const restoreLaunch = (): void => {
      const session = ds.session as unknown as Record<string, unknown>;
      for (const key of SWITCHED_SESSION_FIELDS) {
        if (previous.launch[key] === undefined) delete session[key];
        else session[key] = previous.launch[key];
      }
      ds.hasHistory = true;
      ds.spawnModelOverride = previous.spawnModelOverride;
      ds.modelPinCleared = previous.modelPinCleared;
    };
    const persistBestEffort = (): void => {
      try { updateSession(ds.session); } catch { /* best effort routing rollback */ }
    };
    const restoreLaunchAndPersist = (): boolean => {
      restoreLaunch();
      // A pin rollback is an explicit intent write. An ordinary metadata write
      // would retain the durable NEW pin and undo the in-memory restoration.
      try {
        updateSession(ds.session, plan.mode === 'pin' ? { modelPinWrite: true } : undefined);
        return true;
      } catch (error) {
        logger.warn(`[codex-capacity] ${ds.session.sessionId}: launch rollback could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };

    try {
      const updatedAt = new Date().toISOString();
      const priorReply = pickTurnReplyTarget(ds.session, plan.sourceTurnId);
      const context = ds.session.turnReplyContexts?.[plan.sourceTurnId];
      if (context !== undefined) {
        ds.session.turnReplyContexts = { ...(ds.session.turnReplyContexts ?? {}), [turnId]: structuredClone(context) };
      }
      const target = ds.session.replyTargets?.[plan.sourceTurnId];
      ds.session.replyTargets = {
        ...(ds.session.replyTargets ?? {}),
        [turnId]: {
          ...(target ? structuredClone(target) : {}),
          senderOpenId: plan.caller.requestUserOpenId,
          participants: target?.participants ?? (plan.caller.requestUserOpenId
            ? [{ openId: plan.caller.requestUserOpenId, isBot: false }] : []),
          updatedAt,
        },
      };
      ds.session.failedTurnRecovery = { originalTurnId: plan.logicalTurnId, turnId, caller: { ...plan.caller } };
      ds.activeInteractiveTurn = { turnId, caller: recoveredCaller, userPrompt: plan.userPrompt };
      if (ds.scope === 'chat') {
        ds.currentReplyTarget = { rootMessageId: priorReply?.rootMessageId ?? ds.session.rootMessageId, turnId, updatedAt };
        ds.session.currentReplyTarget = { ...ds.currentReplyTarget };
      }
      if (isSilentScheduledTurn(ds, plan.sourceTurnId)) armSilentScheduledTurn(ds, turnId);
      updateSession(ds.session);
      await prepareIdentity(ds, turnId);
    } catch (error) {
      restoreRouting(state.terminalSettled === true);
      persistBestEffort();
      logger.warn(`[codex-capacity] ${ds.session.sessionId}: continuation not prepared: ${error instanceof Error ? error.message : String(error)}`);
      return cancelledOutcome();
    }
    if (!owned()) {
      restoreRouting(state.terminalSettled === true);
      persistBestEffort();
      return cancelledOutcome();
    }

    // Retire the stalled Codex process holding the 300s backoff sleep.
    const retiring = trigger.worker;
    const retiringGeneration = ds.workerGeneration ?? ds.session.workerGeneration;
    try {
      retireWorker(ds);
      if (!await waitExit(retiring, WORKER_EXIT_WAIT_MS)) {
        logger.warn(`[codex-capacity] ${ds.session.sessionId}: previous worker still running after ${WORKER_EXIT_WAIT_MS}ms`);
      }
    } catch (error) {
      logger.warn(`[codex-capacity] ${ds.session.sessionId}: worker retirement failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!registered()) return 'gone';
      restoreRouting(state.terminalSettled === true);
      if (!restoreLaunchAndPersist()) return 'rollback_failed';
      if (switchCancelled()) return 'gone';
      const oldWorkerIntact = ds.worker === retiring && !retiring.killed;
      return oldWorkerIntact ? 'declined' : 'failed';
    }

    const retirementOwned = !switchCancelled() && registered()
      && ds.worker === null
      && (ds.workerGeneration ?? ds.session.workerGeneration) === retiringGeneration
      && ds.lastCliInputTurnId === plan.sourceTurnId
      && !hasNewerInput(ds);
    if (!retirementOwned) return 'gone';

    let input: CliTurnPayload | undefined;
    try {
      destroyPane(ds);
      if (plan.mode === 'pin' && nextPin) {
        resetCodexModelSelection(ds.session);
        ds.session.modelPin = nextPin;
        ds.spawnModelOverride = undefined;
        delete ds.modelPinCleared;
        if (ds.session.quotaFallback?.cliId === cliId) {
          ds.session.quotaFallback = { ...ds.session.quotaFallback, model: plan.toModel };
        }
      } else {
        ds.spawnModelOverride = plan.toModel;
      }
      ds.hasHistory = true;
      if (ds.session.ordinaryTurnRecovery) cancelOrdinaryTurnRecoveryForUserInput(ds.session, turnId);
      updateSession(ds.session, plan.mode === 'pin' ? { modelPinWrite: true } : undefined);

      const followUp = buildFollowUp(prompt, ds.session.sessionId, {
        larkAppId: ds.larkAppId,
        chatId: ds.chatId,
        cliId,
        locale,
        turnId,
      });
      const built: CliTurnPayload = plan.attachments?.length
        ? { ...followUp, attachments: structuredClone(plan.attachments) }
        : followUp;
      let rejected = false;
      const accepted = startWorker(ds, built, {
        resume: true,
        turnId,
        trustedCaller: recoveredCaller,
        atMostOnce: true,
      }, {
        deferDuringDeviceIsolation: false,
        onAdmission: admission => { rejected = admission === 'rejected'; },
      });
      if (accepted && !rejected) input = built;
    } catch (error) {
      logger.warn(`[codex-capacity] ${ds.session.sessionId}: downgraded Codex worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!input) {
      restoreRouting(state.terminalSettled === true);
      if (!restoreLaunchAndPersist()) return 'rollback_failed';
      return 'failed';
    }

    try {
      if (ds.worker) {
        ds.codexCapacityFallback = {
          sourceTurnId: turnId,
          logicalTurnId: plan.logicalTurnId,
          worker: ds.worker,
          overloadedModels: [...plan.overloadedModels],
        };
      }
      // Rotate the streaming-card turn BEFORE the fallible bookkeeping below:
      // a capacity hop starts a fresh turn, so bump the generation and clear
      // prior-turn slots first (a commit-unknown uuid from the overloaded turn
      // must never be reused). Retain the existing pendingTurnId so the
      // starting-card health watchdog, whose arm gate keys off currentTurnId,
      // keeps matching while currentTurnId still holds the pre-hop turn.
      advancePendingStreamingCardTurn(ds, ds.streamCardPendingTurnId);
      rememberInput(ds, plan.userPrompt, input, turnId);
      noteStarted(ds, turnId);
      persistCard(ds);
      updateSession(ds.session);
      if (plan.mode === 'pin') {
        publishUpdate(ds.session.sessionId, {
          modelPin: resolveSessionModelPinView(ds, getBotConfig(ds.larkAppId)) ?? null,
        });
      }
    } catch (error) {
      logger.warn(`[codex-capacity] ${ds.session.sessionId}: post-switch bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'switched';
  });
  return gate.acquired ? gate.value : cancelledOutcome();
}

/**
 * Entry point called by worker-pool when a live Codex worker observes a
 * `codex_core::responses_retry` capacity backoff in `logs_<N>.sqlite`.
 *
 * Returns `true` when this handler accepted the event and started the
 * user-confirmation flow (asynchronously); `false` when ineligible or ignored.
 */
export function handleCodexCapacityRetry(
  ds: DaemonSession,
  trigger: CodexCapacityFallbackTrigger,
  deps: CodexCapacityFallbackDeps = {},
): boolean {
  const getBotConfig = deps.getBotConfig ?? (appId => getBot(appId).config);
  const getLocale = deps.getLocale ?? localeForBot;
  const resolveModels = deps.modelChoices ?? sessionModelChoices;
  const askHost = deps.registerAsk ?? registerHostAsk;
  const checkOperate = deps.canOperate ?? canOperate;
  const findActive = deps.findActive ?? findActiveBySessionId;
  const isTransferring = deps.isTransferring ?? isSessionTransferring;
  const isRestarting = deps.isRestartInFlight ?? isSessionRestartInFlight;
  const isProtected = deps.hasProtectedOwnership ?? hasProtectedSessionMutationOwnership;
  const resolveCaller = deps.resolveCaller ?? failedTurnCaller;

  let botCfg: BotConfig;
  try {
    botCfg = getBotConfig(ds.larkAppId);
  } catch {
    return false;
  }
  if (sessionEffectiveCliId(ds, botCfg) !== 'codex') return false;

  const sourceTurnId = trigger.turnId;
  const userPrompt = ds.lastUserPrompt?.trim();
  if (!sourceTurnId || ds.lastCliInputTurnId !== sourceTurnId || !userPrompt) return false;
  if (ds.session.status !== 'active' || ds.worker !== trigger.worker || trigger.worker.killed) return false;
  if (!ds.session.cliSessionId) return false;
  if (ds.suppressRecoveryCard || ds.adoptedFrom || ds.session.adoptedFrom || isSharedAdoptSession(ds)
    || isRemoteBackendSession(ds) || isTransferring(ds) || isProtected(ds) || isRestarting(ds)
    || ds.session.pendingForkSession || ds.session.dispatchLaunchSpec
    || ds.session.principalLane || ds.session.workspaceRetirement || ds.session.vcMeetingReceiver) {
    return false;
  }
  if (hasNewerInput(ds) || ds.pendingWaitPromises?.has(sourceTurnId) || ds.asyncTriggerResults?.has(sourceTurnId)) {
    return false;
  }
  const caller = resolveCaller(ds, sourceTurnId, { includeRecordedCaller: true });
  if (!caller) return false;

  const existing = ds.codexCapacityFallback;
  if (existing) {
    if (existing.switching) return false;
    if (existing.sourceTurnId === sourceTurnId && existing.worker === trigger.worker) {
      if (existing.resolving || existing.pendingAsk || existing.declinedForTurn) return false;
    }
  }

  const logicalTurnId = existing && existing.sourceTurnId === sourceTurnId
    ? existing.logicalTurnId
    : (ds.session.failedTurnRecovery?.turnId === sourceTurnId
        ? ds.session.failedTurnRecovery.originalTurnId
        : sourceTurnId);
  const priorOverloaded = existing && existing.logicalTurnId === logicalTurnId
    ? existing.overloadedModels
    : [];
  if (priorOverloaded.length >= MAX_CODEX_CAPACITY_HOPS) return false;

  const fromModel = trigger.model?.trim()
    || ds.activeModel?.trim()
    || resolveSessionLaunchModel(ds, botCfg)?.trim()
    || ds.session.model?.trim();
  if (!fromModel || !MODEL_SLUG_PATTERN.test(fromModel)) return false;

  const overloadedModels = [...new Set([...priorOverloaded, fromModel])];
  const state: CodexCapacityFallbackState = {
    sourceTurnId,
    logicalTurnId,
    worker: trigger.worker,
    overloadedModels,
    resolving: true,
  };
  ds.codexCapacityFallback = state;

  const locale = getLocale(ds.larkAppId);
  const tagged = `[codex-capacity] ${ds.session.sessionId}`;
  const reply = (text: string): void => {
    trigger.reply(text).catch(error => {
      logger.debug(`${tagged}: notice failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const stillOwnsTurn = (): boolean => (
    findActive(ds.session.sessionId) === ds
    && ds.session.status === 'active'
    && ds.worker === trigger.worker
    && !trigger.worker.killed
    && ds.lastCliInputTurnId === sourceTurnId
    && !hasNewerInput(ds)
    && ds.codexCapacityFallback === state
  );

  void (async () => {
    let availableModels: readonly string[];
    try {
      availableModels = await resolveModels(ds);
    } catch (error) {
      state.resolving = false;
      logger.debug(`${tagged}: model catalogue lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      if (ds.codexCapacityFallback === state) ds.codexCapacityFallback = undefined;
      return;
    }
    state.resolving = false;
    if (!stillOwnsTurn()) return;

    const currentBotCfg = getBotConfig(ds.larkAppId);
    const preferredModel = cliMatchesBot(ds.session, currentBotCfg) ? currentBotCfg.model : undefined;
    const toModel = selectCodexCapacityFallbackModel({
      currentModel: fromModel,
      availableModels,
      preferredModel,
      excludedModels: new Set(overloadedModels),
    });
    if (!toModel) {
      logger.info(`${tagged}: no alternative Codex fallback model available for ${fromModel}`);
      if (ds.codexCapacityFallback === state) ds.codexCapacityFallback = undefined;
      return;
    }

    const canOfferTemporary = !(ds.session.quotaFallback && ds.session.quotaFallback.cliId === 'codex');
    const retryDetail = trigger.retryAttempt !== undefined && trigger.maxRetries !== undefined && trigger.retryDelaySec !== undefined
      ? t('worker.codex_capacity_fallback.retry_detail', {
          attempt: trigger.retryAttempt,
          max: trigger.maxRetries,
          wait: trigger.retryDelaySec,
        }, locale)
      : t('worker.codex_capacity_fallback.retry_detail_generic', undefined, locale);

    const requestId = `${sourceTurnId}:${fromModel}:${toModel}`;
    const askTarget: CodexCapacityFallbackPendingAsk = {
      larkAppId: ds.larkAppId,
      sessionId: ds.session.sessionId,
      originKind: CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
      requestId,
    };
    state.pendingAsk = askTarget;

    const answererOpenId = caller.senderType === 'user'
      && caller.requestLarkAppId === ds.larkAppId
      && isSameHumanOpenId(caller.requestUserOpenId)
      ? caller.requestUserOpenId
      : isSameHumanOpenId(ds.session.ownerOpenId)
        ? ds.session.ownerOpenId
        : undefined;

    const options = [
      ...(canOfferTemporary ? [{
        key: 'temporary',
        label: t('worker.codex_capacity_fallback.option_temporary', { toModel }, locale),
        description: t('worker.codex_capacity_fallback.option_temporary_desc', { toModel }, locale),
      }] : []),
      {
        key: 'pin',
        label: t('worker.codex_capacity_fallback.option_pin', { toModel }, locale),
        description: t('worker.codex_capacity_fallback.option_pin_desc', { toModel }, locale),
      },
      {
        key: 'wait',
        label: t('worker.codex_capacity_fallback.option_wait', { fromModel }, locale),
        description: t('worker.codex_capacity_fallback.option_wait_desc', { fromModel }, locale),
      },
    ];

    logger.info(`${tagged}: prompting downgrade ${fromModel} -> ${toModel} (attempt=${trigger.retryAttempt ?? '?'}/${trigger.maxRetries ?? '?'}, wait=${trigger.retryDelaySec ?? '?'}s)`);

    let result: AskResult;
    try {
      result = await askHost({
        larkAppId: ds.larkAppId,
        chatId: ds.chatId,
        rootMessageId: ds.scope === 'thread' ? ds.session.rootMessageId : null,
        ...(ds.scope === 'chat' && ds.currentReplyTarget?.rootMessageId
          ? { cardRootMessageId: ds.currentReplyTarget.rootMessageId } : {}),
        sessionId: ds.session.sessionId,
        originKind: CODEX_CAPACITY_FALLBACK_ASK_ORIGIN,
        requestId,
        chatType: ds.chatType,
        ...(answererOpenId ? { answererOpenId, mentionedOpenId: answererOpenId } : {}),
        timeoutMs: CODEX_CAPACITY_CONFIRM_TIMEOUT_MS,
        questions: [{
          prompt: t('worker.codex_capacity_fallback.prompt', { fromModel, toModel, retryDetail }, locale),
          multiSelect: false,
          options,
        }],
      });
    } catch (error) {
      logger.warn(`${tagged}: confirmation card failed: ${error instanceof Error ? error.message : String(error)}`);
      if (state.pendingAsk === askTarget) state.pendingAsk = undefined;
      return;
    }

    if (state.pendingAsk === askTarget) state.pendingAsk = undefined;
    if (!stillOwnsTurn()) return;

    const choice = choiceFromAskResult(result);
    if (!choice) {
      logger.info(`${tagged}: confirmation ended without choice (kind=${result.kind})`);
      return;
    }
    if (choice === 'wait') {
      state.declinedForTurn = true;
      reply(t('worker.codex_capacity_fallback.waiting', { fromModel }, locale));
      return;
    }

    const actorOpenId = result.kind === 'answered' ? result.by : null;
    if (choice === 'pin' && (!actorOpenId || !checkOperate(ds.larkAppId, ds.chatId, actorOpenId))) {
      state.declinedForTurn = true;
      reply(t('worker.codex_capacity_fallback.pin_forbidden', undefined, locale));
      return;
    }

    state.switching = true;
    const plan: SwitchPlan = {
      fromModel,
      toModel,
      mode: choice,
      actorOpenId,
      sourceTurnId,
      logicalTurnId,
      userPrompt,
      attachments: ds.session.lastAttachments,
      caller,
      overloadedModels,
    };
    let outcome: DowngradeOutcome;
    try {
      outcome = await runDowngrade(ds, trigger, plan, state, locale, deps);
    } catch (error) {
      logger.error(`${tagged}: downgrade to ${toModel} threw: ${error instanceof Error ? error.message : String(error)}`);
      outcome = 'failed';
    } finally {
      state.switching = false;
    }

    logger.info(`${tagged}: downgrade ${fromModel} -> ${toModel} (${choice}) outcome=${outcome}`);
    if (outcome === 'switched') {
      reply(t(
        choice === 'pin'
          ? 'worker.codex_capacity_fallback.switched_pin'
          : 'worker.codex_capacity_fallback.switched_temporary',
        { fromModel, toModel },
        locale,
      ));
    } else if (outcome === 'failed' || outcome === 'rollback_failed') {
      state.declinedForTurn = true;
      reply(t(
        outcome === 'rollback_failed'
          ? 'worker.codex_capacity_fallback.switch_rollback_failed'
          : 'worker.codex_capacity_fallback.switch_failed',
        { fromModel, toModel },
        locale,
      ));
    } else if (outcome === 'gone' && ds.codexCapacityFallback === state) {
      ds.codexCapacityFallback = undefined;
    }
  })();

  return true;
}
