import type { TrustedCaller } from '../types.js';
import { PROVIDER_RETRY_HINT_MAX_AHEAD_MS } from './provider-retry-hint.js';

export const ORDINARY_TURN_RECOVERY_PROMPT = [
  '[BOTMUX_RECOVERY]',
  '上一执行因暂态 provider 故障中止。请读取当前会话和工作区状态，从最后一个可验证 checkpoint 继续原任务；',
  '不要重复已经完成的外部副作用。完成后按原任务的交付协议回复；若无法安全判断 checkpoint，请停止并明确请求人工决策。',
].join('\n');

/** Error code for a delivered continuation whose own terminal never arrived
 *  while the CLI sat idle: its outcome cannot be verified, so the recovery
 *  settles as failed instead of waiting forever (10-31: the continuation's
 *  terminal was attributed to a synthesised local turn and silenced, and the
 *  state stayed `running` for days). */
export const RECOVERY_OUTCOME_UNVERIFIED = 'recovery_outcome_unverified';

/** The original input of one tracked logical turn, frozen at admission so a
 *  terminal recovery failure can offer an exact re-delivery. The session's
 *  `lastCliInput` / `lastFailedTurn` cannot serve: a type-ahead successor
 *  overwrites both before the earlier turn's failure is known. */
export interface OrdinaryTurnRetryInput {
  cliInput: string;
  /** Hook-stripped per-turn envelope paired with `cliInput`, for lossless recovery re-delivery. */
  hookEnvelope?: string;
  /** Daemon-authenticated caller of the original turn, when admission had one. */
  trustedCaller?: TrustedCaller;
}

/** Remembered retry inputs beyond the owner, counted from the queue head
 *  (the successors that run — and may fail — next). */
const MAX_QUEUED_RETRY_INPUTS = 8;

/** Error code of a type-ahead successor that failed while the owner's own
 *  recovery was in flight: the single recovery slot could not continue it, so
 *  it gets a failure notice instead of being forgotten. */
export const RECOVERY_QUEUED_UNRECOVERED = 'recovery_queued_unrecovered';

/** Error code of a failed turn whose continuation wait was taken over by a
 *  scheduled fire (one slot per session): it is not continued, and gets its
 *  failure card. A human message taking over stays silent, as before. */
export const RECOVERY_SUPERSEDED_BY_SCHEDULE = 'recovery_superseded_by_schedule';

/** Error code of a retryable failure that was not continued because automatic
 *  continuation is switched off (`continuationsEnabled`): it settles at once
 *  and raises the failure notice. */
export const RECOVERY_OFF = 'recovery_off';

/** Why a window-paced recovery stopped continuing (status `exhausted`). */
export type OrdinaryTurnRecoveryStopReason =
  /** Retried until the window closed; the provider never came back. */
  | 'window_closed'
  /** The provider's own "available at" lies beyond the window: waiting for it
   *  would continue on an expired prompt cache, so no continuation is made. */
  | 'provider_eta_beyond_window'
  /** Runaway guard: this many continuations without finishing the turn. */
  | 'max_continuations';

/**
 * Pacing of a window-paced recovery (2026-11-13: a gateway answered 503 "the
 * earliest account is expected to be available at 11:10:16Z"; the fixed 2s/8s
 * ladder spent both continuations before that time and gave up at 11:09).
 *
 * - A continuation is scheduled at the provider's own retry time when its
 *   error names one (plus a little jitter so a fleet does not stampede it),
 *   otherwise on the backoff ladder.
 * - Continuations stop once the window closes. It is measured from the last
 *   request the provider answered — while its (1 h) prompt cache is still warm
 *   a continuation picks up cheaply; later it rewrites the whole context.
 */
export interface OrdinaryTurnRecoveryPacing {
  /** Delays without a provider hint; the last entry repeats. Restarts after a
   *  continuation that made progress (got a reply before failing again). */
  backoffMs: readonly number[];
  /** Window length from the last answered request. */
  windowMs: number;
  /** Floor from the first failure, for a turn whose last answered request is
   *  already older than the window (cache gone anyway): still retry a while. */
  minWindowMs: number;
  /** Runaway guard over all continuations of one logical turn. */
  maxContinuations: number;
  /** A continuation scheduled at least this far out gets one "waiting for the
   *  provider" notice per logical turn, so nobody mistakes it for a hang. */
  waitNoticeMinDelayMs: number;
  /** The window length is the prompt cache's (a 1-hour cache): user-facing
   *  text may then explain the bound by the cache. */
  followsPromptCache?: boolean;
}

export const DEFAULT_ORDINARY_TURN_RECOVERY_PACING: OrdinaryTurnRecoveryPacing = {
  backoffMs: [2_000, 8_000, 30_000, 60_000, 120_000, 300_000],
  windowMs: 55 * 60_000,
  minWindowMs: 10 * 60_000,
  maxContinuations: 20,
  waitNoticeMinDelayMs: 60_000,
};

/** A provider hint this close to now (or past) is stale: use the ladder. */
const PROVIDER_HINT_FRESH_MS = 1_000;
/** Margin after the provider's time, for clock skew between it and us. */
const PROVIDER_HINT_GRACE_MS = 1_000;
const PROVIDER_HINT_JITTER_MIN_MS = 2_000;
const PROVIDER_HINT_JITTER_MAX_MS = 15_000;
/** Ladder steps this long and longer get jitter; the short ones are already
 *  spread by when each session's own failure landed. */
const BACKOFF_JITTER_MIN_STEP_MS = 30_000;
const BACKOFF_JITTER_MAX_MS = 15_000;
/** While the CLI is busy (a human typing in the web terminal, a background
 *  wake) a due continuation waits and looks again this often. Once it has
 *  seen the CLI busy, it also waits one more look after it went quiet, so the
 *  result of that work (a human's terminal turn cancels the wait) lands first. */
export const ORDINARY_RECOVERY_BUSY_RECHECK_MS = 15_000;
/** A window-paced continuation whose timer fires later than this past the
 *  window's end (the daemon was down, a closed session woke up) is not sent:
 *  the recovery settles as `window_closed` instead. Covers timer lag only. */
export const ORDINARY_RECOVERY_EXPIRED_GRACE_MS = 60_000;

export type OrdinaryTurnRecoveryPlan =
  | {
    kind: 'retry';
    nextAttemptAt: number;
    windowEndsAt: number;
    /** Set when the attempt follows the provider's own retry time. */
    providerRetryAt?: number;
  }
  | {
    kind: 'stop';
    stopReason: OrdinaryTurnRecoveryStopReason;
    windowEndsAt: number;
    providerRetryAt?: number;
  };

/** Pure scheduling decision for the next continuation of a window-paced
 *  recovery; see {@link OrdinaryTurnRecoveryPacing}. */
export function planOrdinaryTurnRecoveryContinuation(input: {
  now: number;
  pacing: OrdinaryTurnRecoveryPacing;
  random: () => number;
  /** Continuations already dispatched for this logical turn. */
  continuationsStarted: number;
  /** Ladder restart point (continuationsStarted at the last progress). */
  ladderBase: number;
  firstFailureAt: number;
  providerLastSuccessAt?: number;
  providerRetryAt?: number;
}): OrdinaryTurnRecoveryPlan {
  const { now, pacing } = input;
  const unit = (): number => {
    const r = input.random();
    return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  };
  const windowEndsAt = Math.max(
    (input.providerLastSuccessAt ?? input.firstFailureAt) + pacing.windowMs,
    input.firstFailureAt + pacing.minWindowMs,
  );
  if (input.continuationsStarted >= pacing.maxContinuations) {
    return { kind: 'stop', stopReason: 'max_continuations', windowEndsAt };
  }
  const hint = input.providerRetryAt !== undefined && input.providerRetryAt > now + PROVIDER_HINT_FRESH_MS
    ? input.providerRetryAt : undefined;
  if (hint !== undefined) {
    if (hint + PROVIDER_HINT_GRACE_MS > windowEndsAt) {
      return { kind: 'stop', stopReason: 'provider_eta_beyond_window', windowEndsAt, providerRetryAt: hint };
    }
    const span = Math.min(PROVIDER_HINT_JITTER_MAX_MS, Math.max(PROVIDER_HINT_JITTER_MIN_MS, (hint - now) * 0.1));
    const at = hint + PROVIDER_HINT_GRACE_MS + Math.floor(unit() * span);
    return { kind: 'retry', nextAttemptAt: Math.min(at, windowEndsAt), windowEndsAt, providerRetryAt: hint };
  }
  const ladder = pacing.backoffMs;
  const index = Math.min(Math.max(0, input.continuationsStarted - input.ladderBase), Math.max(0, ladder.length - 1));
  const step = Math.max(0, ladder[index] ?? 0);
  const jitter = step >= BACKOFF_JITTER_MIN_STEP_MS
    ? Math.floor(unit() * Math.min(BACKOFF_JITTER_MAX_MS, step * 0.1)) : 0;
  const at = now + step + jitter;
  if (at <= windowEndsAt) return { kind: 'retry', nextAttemptAt: at, windowEndsAt };
  // One last attempt right at the window's end, while the cache may be warm.
  if (windowEndsAt > now) return { kind: 'retry', nextAttemptAt: windowEndsAt, windowEndsAt };
  return { kind: 'stop', stopReason: 'window_closed', windowEndsAt };
}

export type OrdinaryTurnRecoveryStatus =
  | 'running'
  | 'backoff'
  | 'dispatching'
  | 'completed'
  | 'cancelled'
  | 'exhausted'
  | 'attention_required';

export interface OrdinaryTurnRecoveryState {
  logicalTurnId: string;
  currentTurnId: string;
  continuationsStarted: number;
  status: OrdinaryTurnRecoveryStatus;
  nextAttemptAt?: number;
  lastErrorCode?: string;
  alertSentAt?: number;
  /** True once the one user-visible warning has been scheduled. */
  warningDispatched?: boolean;
  cancelledByTurnId?: string;
  /** Type-ahead successors admitted while the owner was still running, in
   *  admission order. Claude runs them after the owner, so ownership moves to
   *  the head of this list when the owner completes; a terminal for one of them
   *  while the owner is still `running` means the owner's terminal was lost and
   *  the successor is adopted on the spot. Absent when empty. */
  queuedLogicalTurnIds?: string[];
  /** Logical turns (owner or queued successor) whose fire was a silent
   *  scheduled run. Frozen at admission from the daemon's runtime silent
   *  registry and persisted here, because that registry does not survive a
   *  daemon restart while a backoff timer or a delivered continuation does:
   *  every continuation of such a turn must stay silent, and restore re-arms
   *  the registry from this list before re-arming the timer. Pruned to the live
   *  owner + queue on every commit; absent when empty (pre-upgrade archives have
   *  no field and are read as loud, the pre-existing semantics). */
  silentLogicalTurnIds?: string[];
  /** Signed App terminal saved atomically with its final ACK high-water. The
   * worker may disappear before sending the redundant terminal IPC. */
  pendingTerminal?: OrdinaryTurnRecoveryTerminal;
  /** Original inputs of the tracked turns (owner + queued successors), keyed
   *  by logical turn id. Pruned with the tracked set on every commit and
   *  dropped once the slot settles completed/cancelled. Absent on pre-upgrade
   *  archives, which simply cannot offer a re-delivery. */
  retryInputs?: Record<string, OrdinaryTurnRetryInput>;
  /** Epoch ms at which the current continuation was dispatched. Absent on
   *  pre-upgrade archives (lets a failure notice tell a fresh failure from a
   *  state that has been stuck since before the upgrade). */
  dispatchedAt?: number;
  /** The provider failure that started (or last fed) this recovery. Kept when
   *  a later `recovery_*` code overwrites `lastErrorCode`, so a failure notice
   *  can still name the real cause (e.g. a DNS outage). */
  causeErrorCode?: string;
  /** Set (by this version) in the same write as `warningDispatched`: the
   *  failure notice for this logical turn is owed. A restart that finds it
   *  without a notice record re-creates the record — closes the window where
   *  the process dies between the state write and the notice write. Absent on
   *  pre-upgrade states, whose notice the old code already sent. */
  failureNoticeOwed?: true;
  /** Window-paced recovery only (see {@link OrdinaryTurnRecoveryPacing}).
   *  Epoch ms of the first failure of this logical turn's recovery. */
  firstFailureAt?: number;
  /** Window-paced: the last request the provider answered (newest seen on
   *  any of this turn's failures) — the window's anchor. */
  providerLastSuccessAt?: number;
  /** Window-paced: no continuation is scheduled after this instant. */
  windowEndsAt?: number;
  /** Window-paced: the provider's own retry time behind the pending attempt,
   *  or the one beyond the window that stopped the recovery. */
  providerRetryAt?: number;
  /** Window-paced: continuationsStarted at the last continuation that made
   *  progress; the backoff ladder restarts from there. */
  ladderBase?: number;
  /** Window-paced: why the recovery stopped (status `exhausted`). */
  stopReason?: OrdinaryTurnRecoveryStopReason;
  /** Window-paced: when the one "waiting for the provider" notice of this
   *  logical turn was raised. */
  waitNoticeSentAt?: number;
  /** Window-paced: the window length in effect when last scheduled, and
   *  whether it was the prompt cache's — for the user-facing explanation. */
  windowMinutes?: number;
  windowFollowsCache?: true;
}

/** A continuation has been delivered and is still awaiting its own terminal. */
export function ordinaryTurnRecoveryAwaitsContinuationTerminal(
  state: OrdinaryTurnRecoveryState | undefined,
): boolean {
  return !!state && state.status === 'running' && state.currentTurnId !== state.logicalTurnId;
}


/** The slot is held by the original logical turn itself, still running — no
 *  continuation has been dispatched for it. Only then may a queued successor's
 *  terminal mean "the owner's terminal was lost" and be adopted. */
function ownerAwaitingOwnTerminal(state: OrdinaryTurnRecoveryState): boolean {
  return state.status === 'running' && state.currentTurnId === state.logicalTurnId;
}

/** Bound on remembered type-ahead successors; older ones are forgotten first. */
const MAX_QUEUED_LOGICAL_TURNS = 32;

function withQueuedLogicalTurnIds(
  state: OrdinaryTurnRecoveryState,
  queued: readonly string[],
): OrdinaryTurnRecoveryState {
  const { queuedLogicalTurnIds: _dropped, ...rest } = state;
  return queued.length > 0 ? { ...rest, queuedLogicalTurnIds: [...queued] } : rest;
}

export interface OrdinaryTurnRecoveryTerminal {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  errorCode?: string;
  retryable?: boolean;
  /** Worker-reported provider retry time (turn_terminal field of the same
   *  name); re-validated before use. */
  providerRetryAtMs?: number;
  /** Worker-reported last answered request (turn_terminal field). */
  providerLastSuccessAtMs?: number;
}

export interface OrdinaryTurnRecoveryDispatch {
  logicalTurnId: string;
  turnId: string;
  prompt: string;
  continuation: number;
  /** The logical turn was a silent scheduled fire: the continuation must be
   *  armed silent too. Read from the persisted state, never from runtime. */
  silent: boolean;
}

export interface OrdinaryTurnBeginOptions {
  /** Freeze "this fire is silent" onto the logical turn at admission. */
  silent?: boolean;
  /** Freeze the turn's original input for a later failure-card re-delivery. */
  input?: OrdinaryTurnRetryInput;
}

function isSilentLogicalTurn(state: OrdinaryTurnRecoveryState, logicalTurnId: string): boolean {
  return (state.silentLogicalTurnIds ?? []).includes(logicalTurnId);
}

/** Keep silent marks only for turns the state still tracks (owner + queue).
 *  Applied at commit time, i.e. after a promotion/adoption has already chosen
 *  the new owner, so the promoted turn's own mark is never dropped early. */
function pruneSilentLogicalTurnIds(state: OrdinaryTurnRecoveryState): OrdinaryTurnRecoveryState {
  const { silentLogicalTurnIds, ...rest } = state;
  if (!silentLogicalTurnIds) return rest;
  const live = new Set([state.logicalTurnId, ...(state.queuedLogicalTurnIds ?? [])]);
  const kept = silentLogicalTurnIds.filter((id, index, all) => live.has(id) && all.indexOf(id) === index);
  return kept.length > 0 ? { ...rest, silentLogicalTurnIds: kept } : rest;
}

/** Same lifetime rule for frozen retry inputs: only the owner and the newest
 *  queued successors keep theirs, and a slot that settled completed/cancelled
 *  keeps none (nothing left to re-deliver). A failed owner keeps its input so
 *  the failure notice can offer the retry. */
function pruneRetryInputs(state: OrdinaryTurnRecoveryState): OrdinaryTurnRecoveryState {
  const { retryInputs, ...rest } = state;
  if (!retryInputs || state.status === 'completed' || state.status === 'cancelled') return rest;
  const live = [state.logicalTurnId, ...(state.queuedLogicalTurnIds ?? []).slice(0, MAX_QUEUED_RETRY_INPUTS)];
  const kept: Record<string, OrdinaryTurnRetryInput> = {};
  for (const id of live) {
    const input = retryInputs[id];
    if (input) kept[id] = input;
  }
  return Object.keys(kept).length > 0 ? { ...rest, retryInputs: kept } : rest;
}

function withRetryInput(
  state: OrdinaryTurnRecoveryState,
  logicalTurnId: string,
  input: OrdinaryTurnRetryInput | undefined,
): OrdinaryTurnRecoveryState {
  if (!input) return state;
  return { ...state, retryInputs: { ...(state.retryInputs ?? {}), [logicalTurnId]: { ...input } } };
}

/** The provider code worth naming to a human: a `recovery_*` code describes
 *  what the recovery machinery did, not why the turn failed. */
export function ordinaryTurnRecoveryCauseCode(state: OrdinaryTurnRecoveryState): string | undefined {
  if (state.causeErrorCode) return state.causeErrorCode;
  const code = state.lastErrorCode;
  return code && !code.startsWith('recovery_') ? code : undefined;
}

/** Turn ids a daemon restore must re-arm in its runtime silent registry before
 *  re-arming the recovery timer: every silent logical turn still tracked, plus
 *  the delivered continuation of a silent owner (its id differs from the
 *  logical id). Settled states are included on purpose: the registry keeps a
 *  mark past turn_terminal so late idle/final events stay hushed, and a restart
 *  right after a silent continuation settled must not turn those late events
 *  loud. Marks are turn-exact and TTL/size bounded, so re-arming a finished id
 *  can never hush another turn. */
export function ordinaryTurnRecoverySilentTurnIds(
  state: OrdinaryTurnRecoveryState | undefined,
): string[] {
  if (!state) return [];
  const ids = [...(state.silentLogicalTurnIds ?? [])];
  if (isSilentLogicalTurn(state, state.logicalTurnId) && state.currentTurnId !== state.logicalTurnId) {
    ids.push(state.currentTurnId);
  }
  return ids;
}

export interface OrdinaryTurnRecoveryDeps<TTimer = unknown> {
  schedule: (delayMs: number, run: () => void) => TTimer;
  cancel: (timer: TTimer) => void;
  persist: (state: OrdinaryTurnRecoveryState) => void;
  /** Keep a fail-closed process-local fence when an admitted user action could
   * not be saved. Persistence must not resurrect the superseded recovery. */
  retain?: (state: OrdinaryTurnRecoveryState) => void;
  /** Complete asynchronous, turn-bound setup before the continuation can be
   * enqueued. The coordinator re-checks ownership after this await. */
  prepare?: (dispatch: OrdinaryTurnRecoveryDispatch) => void | Promise<void>;
  enqueue: (dispatch: OrdinaryTurnRecoveryDispatch) => boolean;
  warn: (state: OrdinaryTurnRecoveryState) => void;
  /** Async dispatch failures do not pass through the host's timer try/catch.
   * Report them while retaining the persisted handoff fence (never replay). */
  onError?: (error: unknown) => void;
  /** Identity for the next continuation of `logicalTurnId`. Return undefined
   *  to keep the default `bmx-recovery-<random>` id. The daemon uses this to
   *  keep a scheduled turn's `schedule:<taskId>:<uuid>` provenance on its
   *  continuation, so the continuation authenticates exactly like the fire. */
  mintContinuationTurnId?: (logicalTurnId: string, continuation: number) => string | undefined;
  now?: () => number;
  randomId?: () => string;
  /** Uniform [0, 1) source for scheduling jitter (window-paced only). */
  random?: () => number;
  /** Fixed ladder: one continuation per entry, then `exhausted`. Ignored when
   *  `pacing` is set. */
  backoffMs?: readonly number[];
  /** Window-paced recovery (see {@link OrdinaryTurnRecoveryPacing}). A
   *  function is read at every scheduling decision, so a configuration change
   *  applies to the next failure without re-attaching. */
  pacing?: OrdinaryTurnRecoveryPacing | (() => OrdinaryTurnRecoveryPacing);
  /** Whether a failure may be continued at all, read at every decision. False:
   *  a retryable failure settles at once as {@link RECOVERY_OFF} with the
   *  failure notice, and a pending wait is dropped when it comes due (settled
   *  `recovery_disabled`, also with the notice). Turn bookkeeping is unaffected.
   *  Absent = always enabled. */
  continuationsEnabled?: () => boolean;
  /** Window-paced: called once per logical turn, after the state is saved,
   *  when a continuation is scheduled at least `waitNoticeMinDelayMs` out.
   *  Never for a silent scheduled turn. Must not throw into the caller. */
  notifyWaiting?: (state: OrdinaryTurnRecoveryState) => void;
  /** A narrow CLI may continue only these explicit failure codes. Other
   * terminals settle bookkeeping silently and keep their normal UI path. */
  recoverableErrorCodes?: readonly string[];
  /** Codex newer input supersedes the old recovery even during execution. */
  supersedeOnUserInput?: boolean;
  /** A newer user action may have failed to persist before the old process
   * exited. Without durable proof of ownership, do not rearm its backoff. */
  resumeRecoveryOnRestore?: boolean;
  /** How long the CLI must sit idle, with a delivered continuation still
   *  lacking its terminal, before that continuation's outcome is declared
   *  unverifiable and the recovery settles as failed. Undefined disables the
   *  check (CLIs whose newer input already supersedes a running recovery). */
  lostContinuationGraceMs?: number;
  /** Fresh busy probe read when the idle grace elapses: a CLI that went back
   *  to work (e.g. it picked up the queued continuation) is left alone, and
   *  its next idle edge re-arms the check. */
  isCliBusy?: () => boolean;
  /** Window-paced: the CLI is running something right now (a human typing in
   *  the web terminal, a background wake). A due continuation waits for it
   *  instead of queueing behind it. A usage limit is not "running": the
   *  continuation goes ahead and meets the existing rate-limit handling. */
  isCliOccupied?: () => boolean;
  /** Whether a type-ahead successor's non-completed terminal, arriving while
   *  the owner's recovery is in flight, deserves a failure notice (the daemon's
   *  shouldNotifyTurnFailure). When true, the coordinator claims that terminal
   *  and raises the notice through `warn` instead of forgetting the turn. */
  ownsQueuedFailure?: (terminal: OrdinaryTurnRecoveryTerminal) => boolean;
}

export interface OrdinaryTurnRecoverySession {
  sessionId: string;
  ordinaryTurnRecovery?: OrdinaryTurnRecoveryState;
  turnReplyContexts?: Record<string, unknown>;
  replyTargets?: Record<string, unknown>;
}

type AttachedRecovery = {
  session: OrdinaryTurnRecoverySession;
  coordinator: OrdinaryTurnRecoveryCoordinator<any>;
  cancelActive: boolean;
  dispose: () => void;
  persist: (state: OrdinaryTurnRecoveryState) => void;
};

const attachedRecoveries = new Map<string, AttachedRecovery>();

/** Purely orchestrates one ordinary logical turn. Session eligibility and
 * durable state ownership remain with the daemon/worker-pool integration. */
export class OrdinaryTurnRecoveryCoordinator<TTimer = unknown> {
  private state: OrdinaryTurnRecoveryState | undefined;
  private timer: TTimer | undefined;
  private idleTimer: TTimer | undefined;
  private restoredRunningWithoutRecoveryAuthority = false;
  /** Window-paced: the due continuation saw the CLI busy and owes one more
   *  look once it is quiet (process-local; a restart starts afresh). */
  private settleAfterBusy = false;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly random: () => number;
  private readonly backoffMs: readonly number[];
  private readonly pacing: OrdinaryTurnRecoveryPacing | (() => OrdinaryTurnRecoveryPacing) | undefined;

  constructor(private readonly deps: OrdinaryTurnRecoveryDeps<TTimer>) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => Math.random().toString(36).slice(2));
    this.random = deps.random ?? Math.random;
    this.backoffMs = deps.backoffMs ?? [2_000, 8_000];
    this.pacing = deps.pacing;
  }

  restore(state: OrdinaryTurnRecoveryState): void {
    this.cancelTimer();
    this.settleAfterBusy = false;
    this.state = { ...state };
    // Observe an already admitted execution, including its successful result,
    // but the old durable row cannot authorise another continuation after
    // cancellation/new-input persistence may have failed in the old process.
    this.restoredRunningWithoutRecoveryAuthority = state.status === 'running'
      && this.deps.resumeRecoveryOnRestore === false;
    if (this.state.status === 'backoff') this.armBackoff();
  }

  begin(logicalTurnId: string, opts: OrdinaryTurnBeginOptions = {}): OrdinaryTurnRecoveryState {
    // Claude can accept type-ahead while the preceding turn is still running.
    // A session-level slot must keep owning that earlier terminal instead of
    // being overwritten by the queued successor; otherwise the earlier failed
    // terminal has no recovery consumer. Once the current turn has actually
    // entered backoff (or reached a terminal state), a fresh admitted user turn
    // may replace it as before.
    if (!this.deps.supersedeOnUserInput
      && (this.state?.status === 'running' || this.state?.status === 'dispatching')) {
      // Remember the successor without disturbing the live owner. A persist
      // failure here degrades to the old behaviour (successor not tracked).
      const live = this.state;
      const queued = live.queuedLogicalTurnIds ?? [];
      if (logicalTurnId === live.currentTurnId || logicalTurnId === live.logicalTurnId
        || queued.includes(logicalTurnId)) return live;
      try {
        const withQueue = withRetryInput(withQueuedLogicalTurnIds(
          live,
          [...queued, logicalTurnId].slice(-MAX_QUEUED_LOGICAL_TURNS),
        ), logicalTurnId, opts.input);
        return this.commit(opts.silent
          ? { ...withQueue, silentLogicalTurnIds: [...(withQueue.silentLogicalTurnIds ?? []), logicalTurnId] }
          : withQueue);
      } catch {
        return live;
      }
    }
    const wasBackoff = this.state?.status === 'backoff';
    this.cancelTimer();
    try {
      const begun = this.commit({
        logicalTurnId,
        currentTurnId: logicalTurnId,
        continuationsStarted: 0,
        status: 'running',
        ...(opts.silent ? { silentLogicalTurnIds: [logicalTurnId] } : {}),
        ...(opts.input ? { retryInputs: { [logicalTurnId]: { ...opts.input } } } : {}),
      });
      this.restoredRunningWithoutRecoveryAuthority = false;
      return begun;
    } catch (err) {
      if (this.deps.supersedeOnUserInput) {
        this.retain({
          logicalTurnId, currentTurnId: logicalTurnId, continuationsStarted: 0,
          status: 'cancelled', cancelledByTurnId: logicalTurnId,
          lastErrorCode: 'recovery_persist_failed',
        });
        throw err;
      }
      if (wasBackoff) this.armBackoff();
      throw err;
    }
  }

  onTerminal(
    current: OrdinaryTurnRecoveryState,
    terminal: OrdinaryTurnRecoveryTerminal,
  ): OrdinaryTurnRecoveryState {
    if (terminal.turnId !== current.currentTurnId) {
      const queued = current.queuedLogicalTurnIds ?? [];
      if (!queued.includes(terminal.turnId)) return current;
      const remaining = withQueuedLogicalTurnIds(current, queued.filter(id => id !== terminal.turnId));
      // The owner's own recovery is in flight (backoff timer, dispatching, or
      // an already-delivered continuation that is still running) or the owner
      // already settled: the successor ran on its own and is simply forgotten
      // here — the delivered continuation keeps the slot.
      if (!ownerAwaitingOwnTerminal(current)) {
        // Raise the successor's own notice BEFORE pruning it (and its frozen
        // input) from the slot: the notice write lands first, so a crash in
        // between can only leave a harmless stale queue entry, never a lost
        // failure (10-31: this successor failed too and was only ever offered
        // a single-shot card that the outage swallowed).
        if (this.ownsQueuedFailure(terminal)) {
          const input = current.retryInputs?.[terminal.turnId];
          this.deps.warn({
            logicalTurnId: terminal.turnId,
            currentTurnId: terminal.turnId,
            continuationsStarted: 0,
            status: 'attention_required',
            lastErrorCode: RECOVERY_QUEUED_UNRECOVERED,
            ...(terminal.errorCode ? { causeErrorCode: terminal.errorCode } : {}),
            ...(input ? { retryInputs: { [terminal.turnId]: input } } : {}),
            ...(isSilentLogicalTurn(current, terminal.turnId) ? { silentLogicalTurnIds: [terminal.turnId] } : {}),
            alertSentAt: this.now(),
            warningDispatched: true,
          });
        }
        return this.commit(remaining);
      }
      // The owner never reported a terminal (lost/missed) yet its successor
      // did: the successor is the live turn now, and its terminal is handled
      // exactly as an owner terminal would be.
      const adopted = this.commit({
        ...remaining,
        logicalTurnId: terminal.turnId,
        currentTurnId: terminal.turnId,
        continuationsStarted: 0,
        status: 'running',
        nextAttemptAt: undefined,
        lastErrorCode: undefined,
        alertSentAt: undefined,
        warningDispatched: undefined,
      });
      return this.onTerminal(adopted, terminal);
    }
    if (current.status !== 'running') return current;
    if (terminal.status === 'completed') {
      const [next, ...rest] = current.queuedLogicalTurnIds ?? [];
      if (next === undefined) return this.commit({ ...current, status: 'completed' });
      // Hand the slot to the type-ahead successor Claude is about to run, so
      // its failure has a recovery consumer instead of only the fallback card.
      // The silent marks ride along; commit prunes them to the new owner + queue.
      return this.commit(withQueuedLogicalTurnIds({
        logicalTurnId: next,
        currentTurnId: next,
        continuationsStarted: 0,
        status: 'running',
        ...(current.silentLogicalTurnIds ? { silentLogicalTurnIds: current.silentLogicalTurnIds } : {}),
        ...(current.retryInputs ? { retryInputs: current.retryInputs } : {}),
      }, rest));
    }
    if (this.deps.recoverableErrorCodes
      && (terminal.status !== 'failed'
        || !this.deps.recoverableErrorCodes.includes(terminal.errorCode ?? ''))) {
      return this.commit({ ...current, status: 'cancelled', nextAttemptAt: undefined });
    }
    if (terminal.errorCode === 'provider_rate_limited') return current;
    if (this.restoredRunningWithoutRecoveryAuthority) {
      return this.requireAttention(current, 'recovery_restart_unverified');
    }
    if (terminal.status !== 'failed'
      || terminal.retryable === false
      || (!this.deps.recoverableErrorCodes && terminal.retryable !== true)) {
      const next = {
        ...current,
        status: 'attention_required' as const,
        ...(terminal.errorCode ? { lastErrorCode: terminal.errorCode } : {}),
      };
      this.warnOnce(next);
      return next;
    }
    const causeErrorCode = terminal.errorCode ?? current.causeErrorCode;
    if (this.deps.continuationsEnabled?.() === false) return this.settleNotContinued(current, terminal, causeErrorCode);
    if (this.pacing) {
      const pacing = typeof this.pacing === 'function' ? this.pacing() : this.pacing;
      return this.scheduleWindowedContinuation(current, terminal, causeErrorCode, pacing);
    }
    if (current.continuationsStarted >= this.backoffMs.length) {
      const exhausted = {
        ...current,
        status: 'exhausted' as const,
        lastErrorCode: terminal.errorCode,
        ...(causeErrorCode ? { causeErrorCode } : {}),
      };
      this.warnOnce(exhausted);
      return exhausted;
    }
    const delayMs = this.backoffMs[current.continuationsStarted];
    const next = this.commit({
      ...current,
      status: 'backoff',
      nextAttemptAt: this.now() + delayMs,
      lastErrorCode: terminal.errorCode,
      ...(causeErrorCode ? { causeErrorCode } : {}),
    });
    this.armBackoff();
    return next;
  }

  /** Automatic continuation is off: the failure settles now and its notice
   *  names the provider's own recovery time when it gave one. */
  private settleNotContinued(
    current: OrdinaryTurnRecoveryState,
    terminal: OrdinaryTurnRecoveryTerminal,
    causeErrorCode: string | undefined,
  ): OrdinaryTurnRecoveryState {
    const now = this.now();
    const retryAt = Number.isFinite(terminal.providerRetryAtMs) && terminal.providerRetryAtMs! > now
      && terminal.providerRetryAtMs! <= now + PROVIDER_RETRY_HINT_MAX_AHEAD_MS ? terminal.providerRetryAtMs : undefined;
    const { providerRetryAt: _staleRetryAt, stopReason: _staleStop, ...rest } = current;
    const settled: OrdinaryTurnRecoveryState = {
      ...rest,
      status: 'attention_required',
      nextAttemptAt: undefined,
      lastErrorCode: RECOVERY_OFF,
      ...(causeErrorCode ? { causeErrorCode } : {}),
      ...(retryAt !== undefined ? { providerRetryAt: retryAt } : {}),
    };
    this.warnOnce(settled);
    return this.state ?? settled;
  }

  private scheduleWindowedContinuation(
    current: OrdinaryTurnRecoveryState,
    terminal: OrdinaryTurnRecoveryTerminal,
    causeErrorCode: string | undefined,
    pacing: OrdinaryTurnRecoveryPacing,
  ): OrdinaryTurnRecoveryState {
    const now = this.now();
    // Worker-reported instants are hints: a future "last success" is clamped
    // to now, a retry time beyond the hint horizon is dropped.
    const reportedSuccess = Number.isFinite(terminal.providerLastSuccessAtMs)
      ? Math.min(terminal.providerLastSuccessAtMs!, now) : undefined;
    const reportedRetryAt = Number.isFinite(terminal.providerRetryAtMs)
      && terminal.providerRetryAtMs! <= now + PROVIDER_RETRY_HINT_MAX_AHEAD_MS
      ? terminal.providerRetryAtMs : undefined;
    const providerLastSuccessAt = reportedSuccess === undefined ? current.providerLastSuccessAt
      : Math.max(reportedSuccess, current.providerLastSuccessAt ?? reportedSuccess);
    // A continuation that got a reply before failing again moved the task on:
    // the ladder starts over instead of waiting at its longest step.
    const progressed = current.continuationsStarted > 0 && reportedSuccess !== undefined
      && current.dispatchedAt !== undefined && reportedSuccess > current.dispatchedAt;
    const ladderBase = progressed ? current.continuationsStarted : (current.ladderBase ?? 0);
    const firstFailureAt = current.firstFailureAt ?? now;
    const plan = planOrdinaryTurnRecoveryContinuation({
      now, pacing, random: this.random,
      continuationsStarted: current.continuationsStarted,
      ladderBase,
      firstFailureAt,
      ...(providerLastSuccessAt !== undefined ? { providerLastSuccessAt } : {}),
      ...(reportedRetryAt !== undefined ? { providerRetryAt: reportedRetryAt } : {}),
    });
    const { providerRetryAt: _staleRetryAt, stopReason: _staleStop, windowFollowsCache: _staleFollows, ...rest } = current;
    const base: OrdinaryTurnRecoveryState = {
      ...rest,
      windowMinutes: Math.round(pacing.windowMs / 60_000),
      ...(pacing.followsPromptCache ? { windowFollowsCache: true as const } : {}),
      lastErrorCode: terminal.errorCode,
      ...(causeErrorCode ? { causeErrorCode } : {}),
      firstFailureAt,
      ...(providerLastSuccessAt !== undefined ? { providerLastSuccessAt } : {}),
      windowEndsAt: plan.windowEndsAt,
      ladderBase,
      ...(plan.providerRetryAt !== undefined ? { providerRetryAt: plan.providerRetryAt } : {}),
    };
    if (plan.kind === 'stop') {
      const exhausted: OrdinaryTurnRecoveryState = {
        ...base, status: 'exhausted', nextAttemptAt: undefined, stopReason: plan.stopReason,
      };
      this.warnOnce(exhausted);
      return this.state ?? exhausted;
    }
    const noticeDue = !!this.deps.notifyWaiting
      && current.waitNoticeSentAt === undefined
      && !isSilentLogicalTurn(current, current.logicalTurnId)
      && plan.nextAttemptAt - now >= pacing.waitNoticeMinDelayMs;
    const next = this.commit({
      ...base,
      status: 'backoff',
      nextAttemptAt: plan.nextAttemptAt,
      ...(noticeDue ? { waitNoticeSentAt: now } : {}),
    });
    this.settleAfterBusy = false;
    this.armBackoff();
    if (noticeDue) {
      try { this.deps.notifyWaiting!(next); } catch { /* informational; the status card still shows it */ }
    }
    return next;
  }

  requireAttention(
    current: OrdinaryTurnRecoveryState,
    errorCode: string,
  ): OrdinaryTurnRecoveryState {
    if (current.status === 'completed'
      || current.status === 'cancelled'
      || current.status === 'exhausted'
      || current.status === 'attention_required') {
      if (current.warningDispatched !== true) this.warnOnce(current);
      return this.state ?? current;
    }
    this.cancelTimer();
    const causeErrorCode = ordinaryTurnRecoveryCauseCode(current);
    const next = {
      ...current,
      status: 'attention_required' as const,
      nextAttemptAt: undefined,
      lastErrorCode: errorCode,
      ...(causeErrorCode ? { causeErrorCode } : {}),
    };
    this.warnOnce(next);
    return this.state ?? next;
  }

  /** The CLI reached an idle prompt. When a delivered continuation still has
   *  no terminal, arm one grace timer; if the CLI is still idle when it fires
   *  and the same continuation is still unanswered, its outcome cannot be
   *  verified any more (its terminal was lost or attributed elsewhere), so the
   *  recovery settles as failed — fail closed: no further continuation is
   *  dispatched for an execution whose effects are unknown. */
  noteCliIdle(): void {
    const graceMs = this.deps.lostContinuationGraceMs;
    const current = this.state;
    if (graceMs === undefined || !ordinaryTurnRecoveryAwaitsContinuationTerminal(current)) return;
    this.cancelIdleTimer();
    const continuationTurnId = current!.currentTurnId;
    const check = (): void => {
      this.idleTimer = undefined;
      const live = this.state;
      if (!ordinaryTurnRecoveryAwaitsContinuationTerminal(live)
        || live!.currentTurnId !== continuationTurnId) return;
      // Busy (working / usage-limited): look again after another grace rather
      // than waiting for the next idle edge, which a long limit can delay.
      if (this.deps.isCliBusy?.()) {
        this.idleTimer = this.deps.schedule(graceMs, check);
        return;
      }
      this.requireAttention(live!, RECOVERY_OUTCOME_UNVERIFIED);
    };
    this.idleTimer = this.deps.schedule(graceMs, check);
  }

  /** A stop key from the user (card stop / `/stop`): an in-flight continuation
   *  or pending backoff belongs to the turn the user just stopped. Cancel it so
   *  it neither runs afterwards nor settles as a failure card. A running owner
   *  that was never continued is left to its own terminal. */
  cancelForStop(): OrdinaryTurnRecoveryState | undefined {
    const current = this.state;
    if (!current) return undefined;
    if (current.status !== 'backoff' && current.status !== 'dispatching'
      && !ordinaryTurnRecoveryAwaitsContinuationTerminal(current)) return current;
    this.cancelIdleTimer();
    return this.cancelForUserInput('stop');
  }

  private ownsQueuedFailure(terminal: OrdinaryTurnRecoveryTerminal): boolean {
    return !this.deps.recoverableErrorCodes
      && terminal.status !== 'completed'
      && this.deps.ownsQueuedFailure?.(terminal) === true;
  }

  cancelForUserInput(turnId: string): OrdinaryTurnRecoveryState {
    const current = this.state;
    if (!current) {
      return {
        logicalTurnId: turnId,
        currentTurnId: turnId,
        continuationsStarted: 0,
        status: 'cancelled',
        cancelledByTurnId: turnId,
      };
    }
    const wasBackoff = current.status === 'backoff';
    this.cancelTimer();
    try {
      return this.commit({
        ...current,
        status: 'cancelled',
        nextAttemptAt: undefined,
        cancelledByTurnId: turnId,
      });
    } catch (err) {
      if (this.deps.supersedeOnUserInput) {
        // The stop/new input is real even if its storage outcome is unknown.
        // Retain the cancellation locally and still let the host send Ctrl+C.
        const cancelled = {
          ...current, status: 'cancelled' as const, nextAttemptAt: undefined,
          cancelledByTurnId: turnId, lastErrorCode: 'recovery_persist_failed',
        };
        this.retain(cancelled);
        return cancelled;
      }
      if (wasBackoff) this.armBackoff();
      throw err;
    }
  }

  private armBackoff(): void {
    const current = this.state;
    if (!current || current.status !== 'backoff') return;
    this.cancelTimer();
    const delayMs = Math.max(0, (current.nextAttemptAt ?? this.now()) - this.now());
    this.timer = this.deps.schedule(delayMs, () => {
      this.timer = undefined;
      const live = this.state;
      if (!live || live.status !== 'backoff') return;
      if (this.deps.continuationsEnabled?.() === false) {
        // Switched off during the wait: nothing is continued; say so. It ends
        // like any failure left to a person — not `cancelled`, which would drop
        // the frozen input the card's retry needs and keep the next message
        // from clearing the attention this notice raises.
        this.warnOnce({
          ...live, status: 'attention_required', nextAttemptAt: undefined,
          lastErrorCode: 'recovery_disabled',
        });
        return;
      }
      if (this.holdWindowedContinuation(live)) return;
      const continuation = live.continuationsStarted + 1;
      const turnId = this.deps.mintContinuationTurnId?.(live.logicalTurnId, continuation)
        ?? `bmx-recovery-${this.randomId()}`;
      // Persist the exact synthetic turn before handing it to IPC. If the
      // daemon crashes after this write, restore fails closed instead of
      // replaying a continuation whose external effects may already have
      // started. A successful enqueue advances the same identity to running.
      const dispatching = this.commit({
        ...live,
        currentTurnId: turnId,
        continuationsStarted: continuation,
        status: 'dispatching',
        nextAttemptAt: undefined,
        dispatchedAt: this.now(),
      });
      const dispatch: OrdinaryTurnRecoveryDispatch = {
        logicalTurnId: dispatching.logicalTurnId,
        turnId,
        prompt: ORDINARY_TURN_RECOVERY_PROMPT,
        continuation,
        silent: isSilentLogicalTurn(dispatching, dispatching.logicalTurnId),
      };
      const finish = (): void => {
        const current = this.state;
        if (!current || current.status !== 'dispatching' || current.currentTurnId !== turnId) return;
        let enqueued = false;
        try { enqueued = this.deps.enqueue(dispatch); }
        catch { enqueued = false; }
        if (!enqueued) {
          const failed = this.commit({
            ...current,
            status: 'attention_required',
            nextAttemptAt: undefined,
            lastErrorCode: 'recovery_enqueue_failed',
          });
          this.warnOnce(failed);
          return;
        }
        this.commit({ ...current, status: 'running' });
      };
      const failPreparation = (): void => {
        const current = this.state;
        if (!current || current.status !== 'dispatching' || current.currentTurnId !== turnId) return;
        const failed = this.commit({
          ...current,
          status: 'attention_required',
          nextAttemptAt: undefined,
          lastErrorCode: 'recovery_enqueue_failed',
        });
        this.warnOnce(failed);
      };
      try {
        const preparation = this.deps.prepare?.(dispatch);
        if (preparation && typeof (preparation as Promise<void>).then === 'function') {
          void Promise.resolve(preparation).then(finish, failPreparation).catch(error => {
            // The input may already have been accepted. Keep the exact durable
            // dispatching identity; the host stops recovery and raises attention.
            try { this.deps.onError?.(error); } catch { /* reporting must not reject */ }
          });
        } else {
          finish();
        }
      } catch {
        failPreparation();
      }
    });
  }

  /** Window-paced only, when a due continuation fires. It is not sent:
   *  - past its window (the daemon was down, a closed session woke up later):
   *    the recovery settles as `window_closed`, with the usual notice;
   *  - into a CLI someone is driving (web terminal, background wake): it looks
   *    again shortly, and once more after the CLI went quiet; if the window
   *    ends while the CLI is still busy it settles as `window_closed` rather
   *    than typing into a CLI in use.
   *  Returns true when the continuation was held back or settled. */
  private holdWindowedContinuation(live: OrdinaryTurnRecoveryState): boolean {
    if (!this.pacing || live.windowEndsAt === undefined) return false;
    const now = this.now();
    const occupied = this.deps.isCliOccupied?.() === true;
    if (now > live.windowEndsAt + ORDINARY_RECOVERY_EXPIRED_GRACE_MS || (occupied && now >= live.windowEndsAt)) {
      this.settleAfterBusy = false;
      this.warnOnce({ ...live, status: 'exhausted', nextAttemptAt: undefined, stopReason: 'window_closed' });
      return true;
    }
    if (!occupied && !this.settleAfterBusy) return false;
    this.settleAfterBusy = occupied;
    this.timer = this.deps.schedule(
      Math.min(ORDINARY_RECOVERY_BUSY_RECHECK_MS, Math.max(0, live.windowEndsAt - now)),
      () => {
        this.timer = undefined;
        this.armBackoff();
      },
    );
    return true;
  }

  private warnOnce(state: OrdinaryTurnRecoveryState): void {
    const prior = this.state;
    const alerted = this.commit({
      ...state,
      alertSentAt: state.alertSentAt ?? prior?.alertSentAt ?? this.now(),
      warningDispatched: true,
      failureNoticeOwed: true,
    });
    if (prior?.warningDispatched || state.warningDispatched) return;
    this.deps.warn(alerted);
  }

  private commit(state: OrdinaryTurnRecoveryState): OrdinaryTurnRecoveryState {
    const prior = this.state;
    const next = pruneRetryInputs(pruneSilentLogicalTurnIds({ ...state }));
    this.state = next;
    try {
      this.deps.persist(next);
    } catch (err) {
      this.state = prior;
      throw err;
    }
    return next;
  }

  private retain(state: OrdinaryTurnRecoveryState): void {
    this.state = pruneRetryInputs(pruneSilentLogicalTurnIds({ ...state }));
    this.deps.retain?.(this.state);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.cancel(this.timer);
    this.timer = undefined;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== undefined) this.deps.cancel(this.idleTimer);
    this.idleTimer = undefined;
  }

  dispose(): void {
    this.cancelTimer();
    this.cancelIdleTimer();
  }

  handlesTerminal(terminal: OrdinaryTurnRecoveryTerminal, current: OrdinaryTurnRecoveryState): boolean {
    if (!this.deps.recoverableErrorCodes) return true;
    // RPC can report the terminal before its rollout fallback appears. Keep
    // owning that same failure during backoff/exhaustion so the late diagnostic
    // cannot duplicate the coordinator's notice. New input/cancellation fences
    // the old identity out through the registry below.
    // A dispatched continuation proves the logical turn's capacity failure
    // was already consumed. Its delayed rollout diagnostic remains obsolete
    // even after successful recovery; a cancelled recovery keeps normal UI.
    const recoveredPredecessor = this.handlesRecoveredPredecessor(terminal, current);
    return current.status !== 'cancelled'
      && (current.status !== 'completed' || recoveredPredecessor)
      && terminal.status === 'failed'
      && this.deps.recoverableErrorCodes.includes(terminal.errorCode ?? '');
  }

  /** A queued successor's failure that onTerminal will raise as its own
   *  notice (see ownsQueuedFailure) — the fallback card must stay quiet. */
  handlesQueuedFailure(terminal: OrdinaryTurnRecoveryTerminal, current: OrdinaryTurnRecoveryState): boolean {
    return !ownerAwaitingOwnTerminal(current)
      && (current.queuedLogicalTurnIds ?? []).includes(terminal.turnId)
      && this.ownsQueuedFailure(terminal);
  }

  handlesRecoveredPredecessor(terminal: OrdinaryTurnRecoveryTerminal, current: OrdinaryTurnRecoveryState): boolean {
    return terminal.status === 'failed'
      && this.deps.recoverableErrorCodes?.includes(terminal.errorCode ?? '') === true
      && current.continuationsStarted > 0 && terminal.turnId === current.logicalTurnId;
  }
}

/** Bind the pure coordinator to one persisted Session. This registry is only a
 * runtime timer owner; the state itself remains in `session.ordinaryTurnRecovery`
 * and is re-armed from there after daemon restore. */
export function attachOrdinaryTurnRecovery<TTimer>(
  session: OrdinaryTurnRecoverySession,
  deps: OrdinaryTurnRecoveryDeps<TTimer>,
): void {
  if (attachedRecoveries.get(session.sessionId)?.session === session) return;
  disposeOrdinaryTurnRecovery(session);
  let coordinator!: OrdinaryTurnRecoveryCoordinator<TTimer>;
  const wrapped: OrdinaryTurnRecoveryDeps<TTimer> = {
    ...deps,
    retain: state => {
      session.ordinaryTurnRecovery = structuredClone(state);
      deps.retain?.(state);
    },
    persist: state => {
      const prior = session.ordinaryTurnRecovery;
      session.ordinaryTurnRecovery = structuredClone(state);
      try {
        deps.persist(state);
      } catch (err) {
        session.ordinaryTurnRecovery = prior;
        throw err;
      }
    },
    enqueue: dispatch => {
      let contextCopied = false;
      const sourceContext = session.turnReplyContexts?.[dispatch.logicalTurnId];
      if (sourceContext !== undefined) {
        session.turnReplyContexts = {
          ...(session.turnReplyContexts ?? {}),
          [dispatch.turnId]: structuredClone(sourceContext),
        };
        contextCopied = true;
      }
      const sourceTarget = session.replyTargets?.[dispatch.logicalTurnId];
      if (sourceTarget !== undefined) {
        session.replyTargets = {
          ...(session.replyTargets ?? {}),
          [dispatch.turnId]: structuredClone(sourceTarget),
        };
        contextCopied = true;
      }
      // `botmux send` runs in the CLI child and reads this routing context from
      // the session store. Land the inherited destination before IPC can make
      // the continuation executable.
      if (contextCopied && session.ordinaryTurnRecovery) {
        deps.persist(session.ordinaryTurnRecovery);
      }
      return deps.enqueue(dispatch);
    },
  };
  coordinator = new OrdinaryTurnRecoveryCoordinator(wrapped);
  attachedRecoveries.set(session.sessionId, {
    session,
    coordinator,
    cancelActive: deps.supersedeOnUserInput === true,
    dispose: () => coordinator.dispose(),
    persist: wrapped.persist,
  });
  if (session.ordinaryTurnRecovery) {
    if (session.ordinaryTurnRecovery.status === 'dispatching'
      || (session.ordinaryTurnRecovery.status === 'backoff' && deps.resumeRecoveryOnRestore === false)) {
      const pendingBackoff = session.ordinaryTurnRecovery.status === 'backoff';
      const wasAlreadyDispatched = session.ordinaryTurnRecovery.warningDispatched === true;
      const interrupted = {
        ...session.ordinaryTurnRecovery,
        status: 'attention_required' as const,
        lastErrorCode: pendingBackoff ? 'recovery_restart_unverified' : 'recovery_dispatch_interrupted',
        alertSentAt: session.ordinaryTurnRecovery.alertSentAt ?? Date.now(),
        warningDispatched: true,
        failureNoticeOwed: true as const,
      };
      session.ordinaryTurnRecovery = interrupted;
      deps.persist(interrupted);
      if (!wasAlreadyDispatched) deps.warn(interrupted);
      coordinator.restore(interrupted);
    } else {
      coordinator.restore(session.ordinaryTurnRecovery);
      if ((session.ordinaryTurnRecovery.status === 'exhausted'
        || session.ordinaryTurnRecovery.status === 'attention_required')
        && session.ordinaryTurnRecovery.warningDispatched !== true) {
        coordinator.requireAttention(
          session.ordinaryTurnRecovery,
          session.ordinaryTurnRecovery.lastErrorCode ?? 'recovery_attention_required',
        );
      }
    }
  }
  reconcileOrdinaryTurnRecoveryTerminalReceipt(session);
}

/** Stage only the exact live owner; the caller persists this together with
 * the signed final ledger before acknowledging the runner. */
export function stageOrdinaryTurnRecoveryTerminal(
  session: OrdinaryTurnRecoverySession, terminal: OrdinaryTurnRecoveryTerminal,
): void {
  const state = session.ordinaryTurnRecovery;
  if (state?.status === 'running' && state.currentTurnId === terminal.turnId) {
    session.ordinaryTurnRecovery = { ...state, pendingTerminal: { ...terminal } };
  }
}

export function reconcileOrdinaryTurnRecoveryTerminalReceipt(session: OrdinaryTurnRecoverySession): void {
  const current = session.ordinaryTurnRecovery;
  const attached = attachedRecoveries.get(session.sessionId);
  if (!current?.pendingTerminal || !attached || attached.session !== session) return;
  const { pendingTerminal, ...clean } = current;
  session.ordinaryTurnRecovery = clean;
  try {
    if (clean.status === 'running' && clean.currentTurnId === pendingTerminal.turnId) {
      attached.coordinator.onTerminal(clean, pendingTerminal);
    } else {
      attached.persist(clean);
    }
  } catch (error) {
    session.ordinaryTurnRecovery = current;
    throw error;
  }
}

export function handleOrdinaryTurnRecoveryTerminal(
  session: OrdinaryTurnRecoverySession,
  terminal: OrdinaryTurnRecoveryTerminal,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  const current = session.ordinaryTurnRecovery;
  if (!attached || !current) return current;
  return attached.coordinator.onTerminal(current, terminal);
}

/** Positive proof that this exact terminal currently has an attached recovery
 * consumer. Callers use it before suppressing any fallback notification. */
export function ordinaryTurnRecoveryHandlesTerminal(
  session: OrdinaryTurnRecoverySession,
  terminal: OrdinaryTurnRecoveryTerminal,
): boolean {
  const current = session.ordinaryTurnRecovery;
  if (attachedRecoveries.get(session.sessionId)?.session !== session || !current) return false;
  if (!attachedRecoveries.get(session.sessionId)!.coordinator.handlesTerminal(terminal, current)) return false;
  if (current.currentTurnId === terminal.turnId) return true;
  if (attachedRecoveries.get(session.sessionId)!.coordinator.handlesRecoveredPredecessor(terminal, current)) return true;
  // A queued type-ahead successor is adopted by onTerminal only while the
  // original owner itself is still running (no continuation dispatched). In any
  // other state its terminal is forgotten by the slot; a failure that the
  // policy owns is raised as the successor's own durable notice, anything else
  // leaves the fallback notice in charge.
  return (ownerAwaitingOwnTerminal(current)
      && (current.queuedLogicalTurnIds ?? []).includes(terminal.turnId))
    || attachedRecoveries.get(session.sessionId)!.coordinator.handlesQueuedFailure(terminal, current);
}

export function beginOrdinaryTurnRecovery(
  session: OrdinaryTurnRecoverySession,
  logicalTurnId: string,
  opts: OrdinaryTurnBeginOptions = {},
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached) return session.ordinaryTurnRecovery;
  // The persisted session projection is authoritative. Re-sync before intake
  // so restore/reconciliation (or a prior transactional rollback) cannot leave
  // the runtime coordinator making an admission decision from stale state.
  if (session.ordinaryTurnRecovery) {
    attached.coordinator.restore(session.ordinaryTurnRecovery);
  }
  return attached.coordinator.begin(logicalTurnId, opts);
}

export function cancelOrdinaryTurnRecoveryForUserInput(
  session: OrdinaryTurnRecoverySession,
  turnId: string,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached || !session.ordinaryTurnRecovery
    || (!['backoff', 'exhausted', 'attention_required'].includes(session.ordinaryTurnRecovery.status)
      && !(attached.cancelActive && ['running', 'dispatching'].includes(session.ordinaryTurnRecovery.status)))) {
    return session.ordinaryTurnRecovery;
  }
  return attached.coordinator.cancelForUserInput(turnId);
}

export function requireOrdinaryTurnRecoveryAttention(
  session: OrdinaryTurnRecoverySession,
  turnId: string,
  errorCode: string,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  const current = session.ordinaryTurnRecovery;
  if (!attached || !current || current.currentTurnId !== turnId) return current;
  return attached.coordinator.requireAttention(current, errorCode);
}

/** The user pressed stop (card stop / `/stop`) on this session's CLI. */
export function cancelOrdinaryTurnRecoveryForStop(
  session: OrdinaryTurnRecoverySession,
): OrdinaryTurnRecoveryState | undefined {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached || attached.session !== session) return session.ordinaryTurnRecovery;
  return attached.coordinator.cancelForStop();
}

/** A recovery coordinator currently owns this exact session object (its
 *  timers are live). A persisted `backoff` without one is not going to run. */
export function ordinaryTurnRecoveryArmed(session: OrdinaryTurnRecoverySession): boolean {
  return attachedRecoveries.get(session.sessionId)?.session === session;
}

/** The CLI of this session reached an idle prompt (worker `prompt_ready`).
 *  Arms the lost-continuation check when a delivered continuation is still
 *  waiting for its terminal; a no-op otherwise or when the attached policy
 *  disables the check. */
export function noteOrdinaryTurnRecoveryCliIdle(session: OrdinaryTurnRecoverySession): void {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached || attached.session !== session) return;
  attached.coordinator.noteCliIdle();
}

export function disposeOrdinaryTurnRecovery(
  session: Pick<OrdinaryTurnRecoverySession, 'sessionId'>,
): void {
  const attached = attachedRecoveries.get(session.sessionId);
  if (!attached) return;
  attached.dispose();
  attachedRecoveries.delete(session.sessionId);
}
