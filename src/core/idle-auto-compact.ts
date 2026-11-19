/**
 * Per-session, opt-in idle auto-compaction.
 *
 * Why: Anthropic's prompt cache lives 1h. A long session that sits idle past
 * that has to rewrite its whole prefix as a cache write on the next turn. When
 * the user turns this on for a session (card button or `/idlecompact`), botmux
 * sends the native `/compact` once the CLI has been idle for N minutes (default
 * 55) — while the cache is still warm — so the next cold start pays for a small
 * summary instead of the full context.
 *
 * Shape (mirrors core/prompt-cache-keepalive.ts):
 *  - the idle clock starts at the idle edge that follows a botmux turn (the
 *    only proof a request warmed the cache); other busy → idle edges — a CLI
 *    booting or restarting, a slash command, input typed into the terminal —
 *    keep the stretch that was already running, and a CLI with no such turn
 *    since it was (re)started is cold and never compacted;
 *  - the daemon's 60s idle sweep calls {@link runIdleAutoCompactSweep};
 *  - the compact itself goes through the same passthrough path as the card
 *    「🗜️ 压缩」button, with the unattended-maintenance safe-composer gate.
 *
 * Fires once per idle stretch: the stretch that was compacted (or skipped) is
 * recorded in `handledIdleSince`, and the compact's own busy → idle edge is
 * recognised through the persisted `inFlight` marker and folded into the
 * handled stretch, so a still-idle session is never compacted again. The next
 * botmux turn opens a new, unhandled stretch. A worker refusal that may pass
 * (input box not recognised on screen, CLI momentarily busy) releases the
 * stretch for a few more tries inside the same window before the topic is told
 * why it was skipped; a draft or a waiting dialog is reported at once.
 *
 * Restart: `idleSince` / `handledIdleSince` / `armed` are persisted on the
 * session row (only while the feature is on), so after a daemon restart the
 * timer continues from the real idle start instead of restarting at boot, and
 * a turn that was running when the daemon went down still opens its stretch.
 */
import type { DaemonSession } from './types.js';
import { supportsNativeAutoCompactRuntime } from './auto-compact.js';
import { KEEPALIVE_IN_FLIGHT_STALE_MS } from '../services/prompt-cache-policy.js';
import type { PromptCacheKeepaliveRefusal } from './unattended-input-refusal.js';

export interface IdleAutoCompactSetting {
  enabled: boolean;
  /** Idle minutes before compacting (1–59). Absent = default. */
  minutes?: number;
  /** Start (epoch ms) of the current warm idle stretch: the idle edge that
   *  followed the last botmux turn. Kept across busy flickers that are not turns. */
  idleSince?: number;
  /** A botmux turn started (`at`) and its idle edge has not been seen yet;
   *  `busy` once its busy period was seen. Persisted on the busy edge so a
   *  daemon restart mid-turn still opens a (conservatively dated) stretch. */
  armed?: IdleAutoCompactArm;
  /** Idle stretch (epoch ms start) already compacted or skipped. */
  handledIdleSince?: number;
  /** Our `/compact` was accepted but its own busy → idle edge is not seen yet.
   *  Persisted so a daemon restart mid-compact does not mistake the compact's
   *  finish for a new idle stretch. Cleared by that edge or any other turn.
   *  `stretch` / `attempt` / `previousHandled` let a worker refusal that may
   *  pass release this stretch for another try (see noteIdleAutoCompactRefused).
   *  `busyBeforeSettled` remembers a non-keep-alive busy edge observed while
   *  this turn was unsettled: if the worker then refuses, that busy was not our
   *  compact (which never typed), so the user's activity cancels the retry. */
  inFlight?: {
    turnId: string; since: number; idleMinutes: number; tokens?: number;
    stretch?: number; attempt?: number; previousHandled?: number;
    busyBeforeSettled?: true;
    /** Idle was observed after the busy edge, but no terminal has settled the
     *  compact yet: never announce success before a completed terminal. */
    idleBeforeSettled?: number;
    /** Completed terminal arrived before that idle edge; the edge may settle. */
    completed?: true;
  };
  /** The worker refused this stretch's compact for a reason that may pass
   *  (input box not recognised, CLI momentarily busy): how many attempts so
   *  far and why the last one was refused. The next sweep inside the window
   *  tries again, up to IDLE_AUTO_COMPACT_MAX_ATTEMPTS. */
  retry?: { stretch: number; attempts: number; reason: IdleAutoCompactRefusalReason };
}

export interface IdleAutoCompactArm {
  /** When the botmux turn started (no request can predate it). */
  at: number;
  /** Its busy period was seen. */
  busy: boolean;
  /** Restored from the row after a daemon restart (in-memory only). */
  restored?: boolean;
}

export const IDLE_AUTO_COMPACT_DEFAULT_MINUTES = 55;
/** A turn that has not gone busy this long after it started (rejected, never
 *  delivered) is dropped: a much later busy period is not its request. */
export const IDLE_AUTO_COMPACT_ARM_BUSY_GRACE_MS = 10 * 60_000;
const BUSY_SCREEN_STATUSES: ReadonlySet<string> = new Set(['working', 'analyzing']);

/** CLI slash commands answered locally with no model request: delivered as a
 *  passthrough turn, they must not arm a warm stretch. Anything else typed as a
 *  passthrough (/review, /compact, skills, …) does reach the model. */
const LOCAL_CLI_COMMANDS: ReadonlySet<string> = new Set([
  '/model', '/cost', '/context', '/usage', '/status', '/mcp', '/effort', '/fast',
  '/plugin', '/plugins', '/diff', '/clear', '/new', '/config', '/help', '/memory',
  '/permissions', '/approvals', '/doctor', '/agents', '/hooks', '/resume',
  '/export', '/theme', '/vim', '/statusline', '/output-style',
]);

export function isLocalCliCommand(cmd: string): boolean {
  return LOCAL_CLI_COMMANDS.has(cmd.trim().split(/\s+/)[0]!.toLowerCase());
}
export const IDLE_AUTO_COMPACT_MIN_MINUTES = 1;
/** Must stay below the cache window so at least one sweep tick lands in it. */
export const IDLE_AUTO_COMPACT_MAX_MINUTES = 59;
/** Anthropic's 1h prompt-cache lifetime. Past it the cache is gone: a compact
 *  would re-read the whole context uncached, which is exactly the cost the
 *  feature exists to avoid, so the stretch is dropped instead. */
export const IDLE_AUTO_COMPACT_CACHE_WINDOW_MS = 60 * 60_000;
/** Contexts smaller than this are cheap to rewrite; compacting them only
 *  loses detail. Applied only when the context size is known. */
export const IDLE_AUTO_COMPACT_MIN_CONTEXT_TOKENS = 100_000;
/** A compact whose busy → idle edge never showed up stops being recognised
 *  after this (generous: compacting a huge context can take many minutes). */
export const IDLE_AUTO_COMPACT_IN_FLIGHT_STALE_MS = 60 * 60_000;
/** Shares the `auto-compact:` prefix so the worker's safe-composer refusal is
 *  settled like the threshold auto-compact's (see auto-compact.ts). */
export const IDLE_AUTO_COMPACT_TURN_PREFIX = 'auto-compact:idle:';
/** Attempts per idle stretch when the worker keeps refusing for a reason that
 *  may pass. Sweeps run a minute apart and the window is the minutes between
 *  the configured idle time and the cache's hour, so this many tries fit the
 *  default 55-minute setting; a later setting just gets fewer. */
export const IDLE_AUTO_COMPACT_MAX_ATTEMPTS = 3;

/**
 * Why the worker refused, as the topic is told it:
 *  - `draft`: the input box holds text nobody sent;
 *  - `choice`: a dialog or picker is waiting for an answer;
 *  - `unconfirmed`: the screen was read but no empty input box was recognised;
 *  - `no_screen`: this terminal backend gives no screen the write may trust;
 *  - `busy`: the CLI was not idle at the write (input going in, restarting);
 *  - `unknown`: an older worker that does not say.
 * The first two are a person's state and are reported at once; the others can
 * pass and are retried inside the window first.
 */
export type IdleAutoCompactRefusalReason = 'draft' | 'choice' | 'unconfirmed' | 'no_screen' | 'busy' | 'unknown';

export function idleAutoCompactRefusalReason(refusal: PromptCacheKeepaliveRefusal | undefined): IdleAutoCompactRefusalReason {
  switch (refusal) {
    case 'composer_not_empty': return 'draft';
    case 'action_prompt_open':
    case 'tui_prompt_open': return 'choice';
    case 'prompt_not_framed': return 'unconfirmed';
    case 'no_screen_evidence': return 'no_screen';
    case 'no_backend':
    case 'restarting':
    case 'prompt_not_ready':
    case 'input_pending':
    case 'bare_shell': return 'busy';
    default: return 'unknown';
  }
}

function refusalMayPass(reason: IdleAutoCompactRefusalReason): boolean {
  return reason !== 'draft' && reason !== 'choice';
}

type IdleAutoCompactSessionState = Pick<DaemonSession,
  'session' | 'lastScreenStatus' | 'idleSinceAt'
  | 'idleAutoCompactPendingNotice' | 'idleAutoCompactDispatchedTurnId' | 'promptCacheKeepalive'
  | 'idleAutoCompactWarmSince' | 'idleAutoCompactArm'
  | 'idleAutoCompactBusyBeforeSettledTurnId' | 'idleAutoCompactLocalTurn'
  | 'idleAutoCompactCompletedTurnId'>;

export function idleAutoCompactMinutes(setting: IdleAutoCompactSetting | undefined): number {
  const minutes = setting?.minutes;
  return typeof minutes === 'number' && Number.isInteger(minutes)
    && minutes >= IDLE_AUTO_COMPACT_MIN_MINUTES && minutes <= IDLE_AUTO_COMPACT_MAX_MINUTES
    ? minutes
    : IDLE_AUTO_COMPACT_DEFAULT_MINUTES;
}

export function isIdleAutoCompactEnabled(session: { idleAutoCompact?: IdleAutoCompactSetting }): boolean {
  return session.idleAutoCompact?.enabled === true;
}

export type IdleAutoCompactCommand =
  | { kind: 'status' }
  | { kind: 'on'; minutes?: number }
  | { kind: 'off' }
  | { kind: 'invalid' };

/** `/idlecompact [on|off|<minutes>]` argument (text after the command name). */
export function parseIdleAutoCompactCommand(args: string): IdleAutoCompactCommand {
  const arg = args.trim().toLowerCase();
  if (!arg || arg === 'status') return { kind: 'status' };
  if (arg === 'on') return { kind: 'on' };
  if (arg === 'off') return { kind: 'off' };
  const m = /^(\d{1,3})\s*(?:m|min|分钟|分)?$/.exec(arg);
  if (m) {
    const minutes = Number(m[1]);
    if (minutes >= IDLE_AUTO_COMPACT_MIN_MINUTES && minutes <= IDLE_AUTO_COMPACT_MAX_MINUTES) {
      return { kind: 'on', minutes };
    }
  }
  return { kind: 'invalid' };
}

/**
 * Turn the feature on/off for one session (caller persists). Minutes, the
 * handled stretch and the tries spent on a refused one survive any toggle, so
 * off → on inside one idle stretch never compacts that stretch twice; the running-stretch mirror is dropped on off
 * (it stops being maintained) and re-derived from the live idle clock.
 */
export function applyIdleAutoCompactSetting(
  session: { idleAutoCompact?: IdleAutoCompactSetting },
  change: { enabled: boolean; minutes?: number },
): IdleAutoCompactSetting {
  const minutes = change.minutes ?? session.idleAutoCompact?.minutes;
  const next: IdleAutoCompactSetting = {
    enabled: change.enabled,
    ...(minutes !== undefined ? { minutes } : {}),
  };
  const prev = session.idleAutoCompact;
  if (prev?.handledIdleSince !== undefined) next.handledIdleSince = prev.handledIdleSince;
  // Tries already spent on this stretch stay spent across a toggle.
  if (prev?.retry) next.retry = prev.retry;
  if (change.enabled && prev?.enabled) {
    // Re-affirming "on" (stale card, minutes change) keeps the live bookkeeping.
    if (prev.idleSince !== undefined) next.idleSince = prev.idleSince;
    if (prev.inFlight) next.inFlight = prev.inFlight;
    if (prev.armed) next.armed = prev.armed;
  }
  session.idleAutoCompact = next;
  return next;
}

export interface IdleAutoCompactSupportSnapshot {
  cliId: string;
  backendType: string | undefined;
  codexRpcInput: boolean;
  adopted: boolean;
  headless: boolean;
  vcMeetingReceiver: boolean;
}

/** Same CLI/runtime set as the unattended threshold auto-compact (Claude Code;
 *  Codex on tmux without RPC input), minus sessions botmux does not own. */
export function supportsIdleAutoCompact(s: IdleAutoCompactSupportSnapshot): boolean {
  return supportsNativeAutoCompactRuntime(s.cliId, s.backendType, s.codexRpcInput)
    && s.backendType !== 'remote-runner'
    && !s.adopted && !s.headless && !s.vcMeetingReceiver;
}

/** Start of the warm idle stretch the timer counts from, or undefined while
 *  busy or when no stretch is known to follow a model request (cold). */
function stretchStart(ds: IdleAutoCompactSessionState): number | undefined {
  if (ds.idleSinceAt === undefined) return undefined;
  return ds.idleAutoCompactWarmSince ?? ds.session.idleAutoCompact?.idleSince;
}

function liveInFlight(setting: IdleAutoCompactSetting, now: number): IdleAutoCompactSetting['inFlight'] {
  const f = setting.inFlight;
  return f && now - f.since < IDLE_AUTO_COMPACT_IN_FLIGHT_STALE_MS ? f : undefined;
}

type IdleAutoCompactFlight = NonNullable<IdleAutoCompactSetting['inFlight']>;

function hasBusyBeforeSettled(ds: IdleAutoCompactSessionState, flight: IdleAutoCompactFlight): boolean {
  // The second leg survives updateSession rolling the nested session object
  // back to its durable row after a failed save. It is deliberately in-memory:
  // a later refusal or idle edge reconciles it before any new compact is sent.
  return flight.busyBeforeSettled === true
    || ds.idleAutoCompactBusyBeforeSettledTurnId === flight.turnId;
}

function hasCompleted(ds: IdleAutoCompactSessionState, flight: IdleAutoCompactFlight): boolean {
  return flight.completed === true || ds.idleAutoCompactCompletedTurnId === flight.turnId;
}

/** A completed compact and its finishing idle edge have BOTH been observed. */
function settleCompletedIdleCompact(
  ds: IdleAutoCompactSessionState,
  setting: IdleAutoCompactSetting,
  finished: IdleAutoCompactFlight,
  idle: number,
): boolean {
  delete setting.inFlight;
  delete setting.retry;
  if (ds.idleAutoCompactBusyBeforeSettledTurnId === finished.turnId) {
    ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
  }
  ds.idleAutoCompactWarmSince = idle;
  setting.idleSince = idle;
  setting.handledIdleSince = idle;
  // Only a compact THIS process dispatched may be announced as done. A marker
  // inherited from a restarted daemon folds as handled without a success claim.
  if (ds.idleAutoCompactDispatchedTurnId === finished.turnId) {
    ds.idleAutoCompactPendingNotice = {
      kind: 'compacted',
      turnId: finished.turnId,
      idleMinutes: finished.idleMinutes,
      ...(finished.tokens !== undefined ? { tokens: finished.tokens } : {}),
    };
    delete ds.idleAutoCompactDispatchedTurnId;
  }
  return true;
}

/**
 * Screen-status hook, called right after `ds.lastScreenStatus` / `idleSinceAt`
 * were updated (worker-pool stampIdleSinceAt). Returns true when the persisted
 * setting changed and the caller should save the session row.
 *
 * Only a botmux turn proves a request reached the model (see
 * {@link noteIdleAutoCompactTurnStarted}); a busy → idle edge is not enough.
 * A CLI booting after a daemon restart, a cold resume or a crash restart can
 * show `working` before its first `idle` without any request, and compacting
 * that stretch would read the whole context cold — the cost this feature
 * exists to avoid. So an idle edge opens a new stretch only when a turn armed
 * it; any other edge keeps the stretch that was already running (usually long
 * expired), and with no stretch at all the session stays cold. Errs toward not
 * compacting: input typed straight into the terminal does not open a stretch.
 */
export function noteIdleAutoCompactScreenStatus(
  ds: IdleAutoCompactSessionState,
  prev: DaemonSession['lastScreenStatus'],
  now = Date.now(),
): boolean {
  if (prev === ds.lastScreenStatus) return false;
  const setting = ds.session.idleAutoCompact;
  const enabled = setting?.enabled === true;
  if (enabled && ds.idleAutoCompactArm === undefined && setting!.armed) {
    // First edge after a daemon restart: the turn that was running continues.
    ds.idleAutoCompactArm = { at: setting!.armed.at, busy: setting!.armed.busy, restored: true };
  }
  let changed = false;
  const syncArm = (): void => {
    if (!enabled) return;
    const arm = ds.idleAutoCompactArm;
    const saved = setting!.armed;
    if (!arm) {
      if (saved) { delete setting!.armed; changed = true; }
    } else if (!saved || saved.at !== arm.at || saved.busy !== arm.busy) {
      setting!.armed = { at: arm.at, busy: arm.busy };
      changed = true;
    }
  };
  if (ds.lastScreenStatus !== 'idle' || ds.idleSinceAt === undefined) {
    const arm = ds.idleAutoCompactArm;
    if (arm && !arm.busy && BUSY_SCREEN_STATUSES.has(ds.lastScreenStatus ?? '')) {
      if (now - arm.at <= IDLE_AUTO_COMPACT_ARM_BUSY_GRACE_MS) arm.busy = true;
      else ds.idleAutoCompactArm = undefined;
    }
    const busy = BUSY_SCREEN_STATUSES.has(ds.lastScreenStatus ?? '');
    const nonKeepaliveBusy = busy && !keepaliveInFlight(ds, now) && !localCommandInFlight(ds, now);
    if (setting?.inFlight && nonKeepaliveBusy) {
      // If this turn is refused later, its write never happened, so this busy
      // edge was someone else's activity even though it arrived before the
      // refusal. Keep both a durable marker and a rollback-proof live witness.
      ds.idleAutoCompactBusyBeforeSettledTurnId = setting.inFlight.turnId;
      if (!setting.inFlight.busyBeforeSettled) {
        setting.inFlight.busyBeforeSettled = true;
        changed = true;
      }
    }
    if (setting?.retry && !setting.inFlight && nonKeepaliveBusy) {
      // The CLI went busy while a refused compact waited for another try, and
      // neither our compact nor a keep-alive did it: someone is using the
      // session (a turn typed into the terminal, a background task waking
      // it). That stretch is over, not to be compacted under them.
      setting.handledIdleSince = setting.retry.stretch;
      delete setting.retry;
      changed = true;
    }
    // Busy edge: save the arm so a daemon restart before the idle edge keeps it.
    syncArm();
    return changed;
  }
  const idle = ds.idleSinceAt;
  if (enabled && ds.idleAutoCompactWarmSince === undefined && setting!.idleSince !== undefined) {
    // First edge after a daemon restart: the stretch saved before continues.
    ds.idleAutoCompactWarmSince = setting!.idleSince;
  }
  const arm = ds.idleAutoCompactArm;
  if (arm?.busy) {
    // The turn's request went out no earlier than its start. Only an idle edge
    // this process saw directly after the turn's busy period dates the stretch
    // from the idle edge; otherwise (restart in between — possibly days —,
    // or leaving `limited`) date it from the turn start, which is never later
    // than the last request, so the stretch can only look older, not warmer.
    ds.idleAutoCompactWarmSince = !arm.restored && BUSY_SCREEN_STATUSES.has(prev ?? '') ? idle : arm.at;
    ds.idleAutoCompactArm = undefined;
  } else if (arm && idle - arm.at > IDLE_AUTO_COMPACT_ARM_BUSY_GRACE_MS) {
    // Never went busy: it sent nothing.
    ds.idleAutoCompactArm = undefined;
  }
  if (!enabled) return false;
  syncArm();
  // A local command's own repaint is over; later busy edges are activity again.
  ds.idleAutoCompactLocalTurn = undefined;
  const finished = liveInFlight(setting!, now);
  if (finished && hasBusyBeforeSettled(ds, finished) && !hasCompleted(ds, finished)) {
    // A busy → idle edge alone cannot distinguish our compact from the user's
    // turn. Keep the claim settled against THIS stretch, but wait for the real
    // terminal before announcing success. A safe-composer refusal will instead
    // cancel silently; completed settles here or in noteIdleAutoCompactTurnEnded.
    finished.idleBeforeSettled = idle;
    return true;
  }
  if (finished) return settleCompletedIdleCompact(ds, setting!, finished, finished.idleBeforeSettled ?? idle);
  // A stale marker (or one a different turn already ended) is just dropped.
  if (setting!.inFlight) { delete setting!.inFlight; changed = true; }
  const warm = ds.idleAutoCompactWarmSince;
  if (warm !== setting!.idleSince) {
    if (warm === undefined) delete setting!.idleSince;
    else setting!.idleSince = warm;
    changed = true;
  }
  return changed;
}

export interface IdleAutoCompactRetryInvalidation {
  /** The persistent setting changed and must be saved before worker admission. */
  changed: boolean;
  /** Restore the old retry after an IPC admission rejection (best effort). */
  rollback(): void;
}

/** Invalidate a real turn's old retry and unsettled compact BEFORE admitting it
 *  to the worker. A failed save therefore rejects the input instead of letting
 *  an accepted turn revive either one after a restart. Locally answered
 *  commands preserve only the retry, not another turn's in-flight compact. */
export function invalidateIdleAutoCompactRetryForTurn(
  ds: Pick<DaemonSession, 'session'>,
  turnId: string | undefined,
  opts: { preserveRetry?: boolean } = {},
): IdleAutoCompactRetryInvalidation {
  if (!turnId || turnId.startsWith(IDLE_AUTO_COMPACT_TURN_PREFIX)) {
    return { changed: false, rollback: () => {} };
  }
  const setting = ds.session.idleAutoCompact;
  const previousInFlight = setting?.inFlight && setting.inFlight.turnId !== turnId
    ? setting.inFlight
    : undefined;
  const retry = opts.preserveRetry ? undefined : setting?.retry;
  if (!setting || (!previousInFlight && !retry)) return { changed: false, rollback: () => {} };
  const previousHandled = setting.handledIdleSince;
  const savedRetry = retry ? { ...retry } : undefined;
  if (previousInFlight) delete setting.inFlight;
  if (savedRetry) {
    setting.handledIdleSince = savedRetry.stretch;
    delete setting.retry;
  }
  return {
    changed: true,
    rollback: () => {
      const current = ds.session.idleAutoCompact;
      // updateSession may have replaced the nested object. Never overwrite a
      // newer compact/retry, only our own still-unsettled invalidation.
      if (!current) return;
      if (previousInFlight && !current.inFlight) current.inFlight = previousInFlight;
      if (savedRetry && !current.retry && current.handledIdleSince === savedRetry.stretch) {
        if (previousHandled === undefined) delete current.handledIdleSince;
        else current.handledIdleSince = previousHandled;
        current.retry = savedRetry;
      }
    },
  };
}

/** A botmux turn started: it sends a request to the model, so the idle edge
 *  that follows opens a fresh, warm stretch. Our own idle /compact does not
 *  arm one (its finishing edge is folded as handled; if it is cancelled first,
 *  the already-handled stretch stays current instead of being compacted
 *  again). Any other turn also ends the in-flight window. A real turn invalidates
 *  a retry immediately, so the cancellation can be persisted even if the daemon
 *  restarts before the busy edge; locally answered CLI commands explicitly keep
 *  it. The arm is saved by the turn's busy edge. Returns true when the caller
 *  must save the retry invalidation now. */
export function noteIdleAutoCompactTurnStarted(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactArm' | 'lastScreenStatus'
    | 'idleAutoCompactLocalTurn' | 'idleAutoCompactBusyBeforeSettledTurnId' | 'idleAutoCompactCompletedTurnId'>,
  turnId: string,
  now = Date.now(),
  opts: { preserveRetry?: boolean } = {},
): boolean {
  const setting = ds.session.idleAutoCompact;
  const endedInFlight = setting?.inFlight !== undefined && setting.inFlight.turnId !== turnId;
  if (endedInFlight) delete setting!.inFlight;
  if (turnId.startsWith(IDLE_AUTO_COMPACT_TURN_PREFIX)) return endedInFlight;
  const invalidation = invalidateIdleAutoCompactRetryForTurn(ds, turnId, opts);
  ds.idleAutoCompactLocalTurn = opts.preserveRetry && setting?.retry
    ? { turnId, since: now }
    : undefined;
  ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
  ds.idleAutoCompactCompletedTurnId = undefined;
  // Started while the CLI is already busy: no new busy edge will follow, the
  // turn runs on in the same busy period.
  ds.idleAutoCompactArm = { at: now, busy: BUSY_SCREEN_STATUSES.has(ds.lastScreenStatus ?? '') };
  return endedInFlight || invalidation.changed;
}

/** A direct Web-terminal submit is positive user-attribution, not a repaint to
 *  guess about: end any local-command exemption and cancel unsettled maintenance
 *  state immediately. Returns true when the caller must persist the change. */
export function noteIdleAutoCompactDirectInput(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactLocalTurn' | 'idleAutoCompactBusyBeforeSettledTurnId'>,
): boolean {
  ds.idleAutoCompactLocalTurn = undefined;
  const setting = ds.session.idleAutoCompact;
  let changed = false;
  if (setting?.inFlight) {
    ds.idleAutoCompactBusyBeforeSettledTurnId = setting.inFlight.turnId;
    if (!setting.inFlight.busyBeforeSettled) {
      setting.inFlight.busyBeforeSettled = true;
      changed = true;
    }
  }
  if (setting?.retry) {
    setting.handledIdleSince = setting.retry.stretch;
    delete setting.retry;
    changed = true;
  }
  return changed;
}

export interface IdleAutoCompactRefusalOutcome {
  reason: IdleAutoCompactRefusalReason;
  /** 1-based attempt the worker just refused. */
  attempt: number;
  /** The stretch was released and a later sweep tries again. */
  retry: boolean;
}

/** The worker refused our unattended write (no live empty-composer proof).
 *  A reason that may pass releases the stretch so a later sweep inside the
 *  window tries again (bounded by IDLE_AUTO_COMPACT_MAX_ATTEMPTS), without
 *  telling the topic yet; a draft or a waiting dialog, or the last attempt,
 *  keeps the stretch handled and queues a notice that says which. Undefined
 *  when the refusal is not for our in-flight compact; otherwise the caller
 *  saves the session row. */
export function noteIdleAutoCompactRefused(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactPendingNotice' | 'idleAutoCompactDispatchedTurnId'
    | 'idleAutoCompactBusyBeforeSettledTurnId' | 'idleAutoCompactCompletedTurnId'>,
  turnId: string,
  refusal?: PromptCacheKeepaliveRefusal,
): IdleAutoCompactRefusalOutcome | undefined {
  const setting = ds.session.idleAutoCompact;
  const flight = setting?.inFlight;
  if (!setting || flight?.turnId !== turnId) return undefined;
  const reason = idleAutoCompactRefusalReason(refusal);
  const attempt = flight.attempt ?? 1;
  const stretch = flight.stretch ?? setting.handledIdleSince;
  const busyBeforeSettled = hasBusyBeforeSettled(ds, flight);
  const locallyDispatched = ds.idleAutoCompactDispatchedTurnId === turnId;
  delete setting.inFlight;
  delete ds.idleAutoCompactDispatchedTurnId;
  if (ds.idleAutoCompactBusyBeforeSettledTurnId === turnId) {
    ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
  }
  if (ds.idleAutoCompactCompletedTurnId === turnId) ds.idleAutoCompactCompletedTurnId = undefined;
  if (busyBeforeSettled || !locallyDispatched) {
    // Busy before refusal proves activity. An inherited claim without THIS
    // process's dispatch witness is also never retryable: a failed marker save
    // followed by restart must fail closed rather than resurrect the stretch.
    if (stretch !== undefined) setting.handledIdleSince = stretch;
    delete setting.retry;
    return { reason, attempt, retry: false };
  }
  if (refusalMayPass(reason) && attempt < IDLE_AUTO_COMPACT_MAX_ATTEMPTS && stretch !== undefined) {
    if (flight.previousHandled === undefined) delete setting.handledIdleSince;
    else setting.handledIdleSince = flight.previousHandled;
    setting.retry = { stretch, attempts: attempt, reason };
    return { reason, attempt, retry: true };
  }
  delete setting.retry;
  ds.idleAutoCompactPendingNotice = { kind: 'refused', idleMinutes: flight.idleMinutes, reason, attempts: attempt };
  return { reason, attempt, retry: false };
}

/** The compact turn reached a terminal receipt. When a busy edge was observed,
 *  success needs BOTH the completed terminal and the finishing idle edge (in
 *  either order), so a user's busy → idle can never masquerade as our compact.
 *  Anything other than `completed` (cancelled / failed / ambiguous — Ctrl-C, a
 *  crash, an interrupted compact) means the topic must not be told the compact
 *  ran: the stretch stays handled (no immediate retry) and, when this process
 *  witnessed the dispatch, an "interrupted" notice is queued. Also retracts a
 *  `compacted` notice whose settlement beat a contradictory later terminal here
 *  but has not been posted yet. Returns true when the caller should save the
 *  session row. */
export function noteIdleAutoCompactTurnEnded(
  ds: IdleAutoCompactSessionState,
  turnId: string,
  status: string,
): boolean {
  if (ds.idleAutoCompactLocalTurn?.turnId === turnId && ds.lastScreenStatus === 'idle') {
    // A terminal while the command is busy can precede its own repaint: keep
    // the exemption until the idle edge. Already-idle means no repaint is due.
    ds.idleAutoCompactLocalTurn = undefined;
  }
  if (status === 'completed') {
    const setting = ds.session.idleAutoCompact;
    const flight = setting?.inFlight;
    if (!setting || flight?.turnId !== turnId || !hasBusyBeforeSettled(ds, flight)) return false;
    // Keep a rollback-proof witness until a new turn/claim/suspend. If the
    // session row rolls back, the next sweep can reconcile without duplicating.
    ds.idleAutoCompactCompletedTurnId = turnId;
    const idle = flight.idleBeforeSettled
      ?? (ds.lastScreenStatus === 'idle' ? ds.idleSinceAt : undefined);
    if (idle === undefined) {
      // Terminal beat the finishing idle edge: remember it so that edge may
      // announce success. Without both, an idle edge alone proves nothing.
      flight.completed = true;
      return true;
    }
    return settleCompletedIdleCompact(ds, setting, flight, idle);
  }
  const setting = ds.session.idleAutoCompact;
  const witnessed = ds.idleAutoCompactDispatchedTurnId === turnId;
  let idleMinutes: number | undefined;
  let changed = false;
  if (setting?.inFlight?.turnId === turnId) {
    idleMinutes = setting.inFlight.idleMinutes;
    delete setting.inFlight;
    changed = true;
  }
  if (witnessed) delete ds.idleAutoCompactDispatchedTurnId;
  if (ds.idleAutoCompactBusyBeforeSettledTurnId === turnId) {
    ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
  }
  if (ds.idleAutoCompactCompletedTurnId === turnId) ds.idleAutoCompactCompletedTurnId = undefined;
  const pending = ds.idleAutoCompactPendingNotice;
  if (pending?.kind === 'compacted' && pending.turnId === turnId) {
    // The idle edge announced success first; retract it before the sweep posts.
    idleMinutes = pending.idleMinutes;
    ds.idleAutoCompactPendingNotice = { kind: 'interrupted', idleMinutes };
    return true;
  }
  if (changed && witnessed && idleMinutes !== undefined) {
    ds.idleAutoCompactPendingNotice = { kind: 'interrupted', idleMinutes };
  }
  return changed;
}

/** A locally answered CLI command whose own repaint must not cancel a retry. */
function localCommandInFlight(ds: IdleAutoCompactSessionState, now: number): boolean {
  const turn = ds.idleAutoCompactLocalTurn;
  return turn !== undefined && now - turn.since < IDLE_AUTO_COMPACT_ARM_BUSY_GRACE_MS;
}

/** A prompt-cache keep-alive is being typed into the CLI right now. */
function keepaliveInFlight(ds: IdleAutoCompactSessionState, now: number): boolean {
  const since = ds.promptCacheKeepalive?.inFlightSince;
  return since !== undefined && now - since < KEEPALIVE_IN_FLIGHT_STALE_MS;
}

type IdleAutoCompactDecision =
  | { action: 'wait'; reason: 'not_idle' | 'handled' | 'too_early' | 'keepalive' | 'ineligible' }
  | { action: 'expired'; stretch: number; idleMs: number }
  | { action: 'skip_small'; stretch: number; idleMs: number; tokens: number }
  | { action: 'compact'; stretch: number; idleMs: number; tokens?: number };

interface IdleAutoCompactProbe {
  now: number;
  /** Final fire-time gate (live worker, CLI ready, nothing queued, …). */
  eligible: () => boolean;
  /** Current context size in tokens; undefined = unknown (threshold skipped). */
  contextTokens: () => number | undefined;
  minContextTokens?: number;
}

/** Caller has checked the setting is enabled. `idleSinceAt` is defined only
 *  while the screen is idle, and a stretch we already compacted (including the
 *  one our own /compact opens) is marked handled, so those two checks cover
 *  "busy" and "in flight". */
function decideIdleAutoCompact(
  ds: IdleAutoCompactSessionState,
  setting: IdleAutoCompactSetting,
  probe: IdleAutoCompactProbe,
): IdleAutoCompactDecision {
  const stretch = stretchStart(ds);
  if (stretch === undefined) return { action: 'wait', reason: 'not_idle' };
  if (setting.handledIdleSince === stretch) return { action: 'wait', reason: 'handled' };
  const idleMs = probe.now - stretch;
  if (idleMs < idleAutoCompactMinutes(setting) * 60_000) return { action: 'wait', reason: 'too_early' };
  if (idleMs >= IDLE_AUTO_COMPACT_CACHE_WINDOW_MS) return { action: 'expired', stretch, idleMs };
  const tokens = probe.contextTokens();
  const minTokens = probe.minContextTokens ?? IDLE_AUTO_COMPACT_MIN_CONTEXT_TOKENS;
  if (tokens !== undefined && tokens < minTokens) return { action: 'skip_small', stretch, idleMs, tokens };
  // Never type /compact on top of a keep-alive prompt in the same tick.
  if (keepaliveInFlight(ds, probe.now)) return { action: 'wait', reason: 'keepalive' };
  if (!probe.eligible()) return { action: 'wait', reason: 'ineligible' };
  return { action: 'compact', stretch, idleMs, ...(tokens !== undefined ? { tokens } : {}) };
}

export type IdleAutoCompactNotice =
  | { kind: 'compacted'; idleMinutes: number; tokens?: number }
  | { kind: 'refused'; idleMinutes: number; reason: IdleAutoCompactRefusalReason; attempts: number }
  | { kind: 'interrupted'; idleMinutes: number }
  | { kind: 'skipped_small'; idleMinutes: number; tokens: number; minTokens: number };

/** A notice parked in memory until the next sweep tick posts it. A
 *  `compacted` notice carries its compact turnId internally so a non-completed
 *  turn_terminal that arrives after the finishing idle edge but before the
 *  notice is flushed can still retract it (the two can race on Ctrl-C/crash). */
export type IdleAutoCompactPendingNotice = IdleAutoCompactNotice & { turnId?: string };

/** Drop the internal retraction-correlation field before posting. */
function postedNotice(p: IdleAutoCompactPendingNotice): IdleAutoCompactNotice {
  if (p.kind === 'skipped_small') {
    return { kind: 'skipped_small', idleMinutes: p.idleMinutes, tokens: p.tokens, minTokens: p.minTokens };
  }
  if (p.kind === 'refused') {
    return { kind: 'refused', idleMinutes: p.idleMinutes, reason: p.reason, attempts: p.attempts };
  }
  if (p.kind === 'compacted' && p.tokens !== undefined) {
    return { kind: 'compacted', idleMinutes: p.idleMinutes, tokens: p.tokens };
  }
  return { kind: p.kind as 'compacted' | 'interrupted', idleMinutes: p.idleMinutes };
}

/** Forget the warm stretch, the arm and any in-flight marker when the live CLI
 *  is destroyed (worker suspend): the cold-resumed CLI has no warm cache, so
 *  nothing is timed until the next botmux turn. Returns true when the
 *  persisted setting changed (the caller saves the row). */
export function clearIdleAutoCompactStretch(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactWarmSince' | 'idleAutoCompactArm'
    | 'idleAutoCompactBusyBeforeSettledTurnId' | 'idleAutoCompactLocalTurn' | 'idleAutoCompactCompletedTurnId'>,
): boolean {
  ds.idleAutoCompactWarmSince = undefined;
  ds.idleAutoCompactArm = undefined;
  ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
  ds.idleAutoCompactLocalTurn = undefined;
  ds.idleAutoCompactCompletedTurnId = undefined;
  const setting = ds.session.idleAutoCompact;
  if (!setting || (setting.idleSince === undefined && !setting.inFlight && setting.armed === undefined && !setting.retry)) return false;
  delete setting.idleSince;
  delete setting.inFlight;
  delete setting.armed;
  delete setting.retry;
  return true;
}

function describeOutcome(notice: IdleAutoCompactNotice): string {
  switch (notice.kind) {
    case 'compacted': return 'worker ran /compact and it finished';
    case 'interrupted': return '/compact was interrupted (cancelled or failed)';
    case 'skipped_small': return `context ${notice.tokens} < ${notice.minTokens} tokens; not compacted`;
    case 'refused': return `worker refused /compact (${notice.reason}) after ${notice.attempts} attempt(s); not compacted`;
  }
}

export interface IdleAutoCompactSweepDeps {
  now?: () => number;
  supported(ds: DaemonSession): boolean;
  eligible(ds: DaemonSession): boolean;
  contextTokens(ds: DaemonSession): number | undefined;
  /** Save `ds.session` (the setting rides the session row). */
  persist(ds: DaemonSession): void;
  /** Send `/compact` with this turnId; true only when the worker accepted it. */
  compact(ds: DaemonSession, turnId: string): boolean;
  notify(ds: DaemonSession, notice: IdleAutoCompactNotice): void;
  log(message: string): void;
  minContextTokens?: number;
}

/** One sweep over a bot's live sessions. Returns how many compacts were sent. */
export function runIdleAutoCompactSweep(
  sessions: Iterable<DaemonSession>,
  deps: IdleAutoCompactSweepDeps,
): number {
  const now = (deps.now ?? Date.now)();
  const minTokens = deps.minContextTokens ?? IDLE_AUTO_COMPACT_MIN_CONTEXT_TOKENS;
  let sent = 0;
  for (const ds of sessions) {
    // Always read through ds.session: the store's updateSession re-assigns the
    // row's fields onto the session object, replacing this nested object.
    const current = (): IdleAutoCompactSetting | undefined => ds.session.idleAutoCompact;
    if (!current()?.enabled) continue;
    const id = ds.session.sessionId.slice(0, 8);
    try {
      // An unsettled claim is a hard stop regardless of handled/stretch. If a
      // completed/idle save rolled back, reconcile from the rollback-proof
      // witnesses first and never flush a success notice before that save works.
      const unsettled = current()!.inFlight;
      if (unsettled) {
        const idle = unsettled.idleBeforeSettled
          ?? (ds.lastScreenStatus === 'idle' ? ds.idleSinceAt : undefined);
        if (!hasCompleted(ds, unsettled)) {
          if (unsettled.idleBeforeSettled !== undefined
            && ds.idleAutoCompactDispatchedTurnId !== unsettled.turnId) {
            // This claim came from another process. Its idle edge is durable,
            // but its in-memory completed witness is unrecoverable (for example
            // a failed completed save followed by restart). Fold it silently as
            // handled rather than waiting forever or claiming success.
            const inheritedIdle = unsettled.idleBeforeSettled;
            delete current()!.inFlight;
            delete current()!.retry;
            ds.idleAutoCompactWarmSince = inheritedIdle;
            current()!.idleSince = inheritedIdle;
            current()!.handledIdleSince = inheritedIdle;
            try { deps.persist(ds); } catch { /* the next sweep reconciles again */ }
          }
          continue;
        }
        if (idle === undefined) continue;
        settleCompletedIdleCompact(ds, current()!, unsettled, idle);
        try { deps.persist(ds); }
        catch (error) {
          deps.log(`[idle-compact] ${id} could not reconcile the completed claim: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
      const pending = ds.idleAutoCompactPendingNotice;
      if (pending) {
        ds.idleAutoCompactPendingNotice = undefined;
        const notice = postedNotice(pending);
        deps.notify(ds, notice);
        deps.log(`[idle-compact] ${id} outcome: ${describeOutcome(notice)}`);
      }
      if (!deps.supported(ds)) continue;
      // Turned on mid-stretch: mirror the live warm stretch onto the row so a
      // daemon restart continues it instead of seeing an unexplained stretch.
      const live = stretchStart(ds);
      if (live !== undefined && current()!.idleSince === undefined) {
        current()!.idleSince = live;
        deps.persist(ds);
      }
      const decision = decideIdleAutoCompact(ds, current()!, {
        now,
        eligible: () => deps.eligible(ds),
        contextTokens: () => deps.contextTokens(ds),
        minContextTokens: minTokens,
      });
      if (decision.action === 'wait') continue;
      const idleMinutes = Math.floor(decision.idleMs / 60_000);
      if (decision.action === 'expired') {
        const expired = current()!;
        expired.handledIdleSince = decision.stretch;
        const retry = expired.retry;
        delete expired.retry;
        deps.persist(ds);
        if (retry?.stretch === decision.stretch) {
          // The window closed while a refused compact was waiting to be tried
          // again: the topic hears why it never ran.
          const notice: IdleAutoCompactNotice = { kind: 'refused', idleMinutes, reason: retry.reason, attempts: retry.attempts };
          deps.notify(ds, notice);
          deps.log(`[idle-compact] ${id} idle ${idleMinutes}m is past the cache window before a retry; outcome: ${describeOutcome(notice)}`);
          continue;
        }
        deps.log(`[idle-compact] ${id} idle ${idleMinutes}m is past the cache window; skipped`);
        continue;
      }
      if (decision.action === 'skip_small') {
        current()!.handledIdleSince = decision.stretch;
        deps.persist(ds);
        deps.notify(ds, { kind: 'skipped_small', idleMinutes, tokens: decision.tokens, minTokens });
        deps.log(`[idle-compact] ${id} context ${decision.tokens} < ${minTokens} tokens; skipped`);
        continue;
      }
      // Claim the stretch before dispatch: a crash between here and the send
      // loses one compact rather than ever sending two.
      const previousHandled = current()!.handledIdleSince;
      const turnId = `${IDLE_AUTO_COMPACT_TURN_PREFIX}${now.toString(36)}`;
      const claim = current()!;
      const attempt = (claim.retry?.stretch === decision.stretch ? claim.retry.attempts : 0) + 1;
      ds.idleAutoCompactCompletedTurnId = undefined;
      ds.idleAutoCompactBusyBeforeSettledTurnId = undefined;
      claim.handledIdleSince = decision.stretch;
      claim.idleSince = decision.stretch;
      claim.inFlight = {
        turnId, since: now, idleMinutes, ...(decision.tokens !== undefined ? { tokens: decision.tokens } : {}),
        stretch: decision.stretch, attempt,
        ...(previousHandled !== undefined ? { previousHandled } : {}),
      };
      // Release the claim so a later tick inside the window retries.
      const releaseClaim = (): void => {
        const release = current();
        if (!release) return;
        if (release.inFlight?.turnId === turnId) delete release.inFlight;
        if (previousHandled === undefined) delete release.handledIdleSince;
        else release.handledIdleSince = previousHandled;
        if (ds.idleAutoCompactDispatchedTurnId === turnId) delete ds.idleAutoCompactDispatchedTurnId;
      };
      try {
        deps.persist(ds);
      } catch (error) {
        // An unsaved claim is not sent: a stretch held handled in memory with
        // nothing dispatched would otherwise go silent for good.
        releaseClaim();
        deps.log(`[idle-compact] ${id} could not save the claim; not sending: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      let accepted = false;
      try {
        accepted = deps.compact(ds, turnId);
      } catch (error) {
        deps.log(`[idle-compact] ${id} send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!accepted) {
        releaseClaim();
        try { deps.persist(ds); } catch { /* the in-memory release already lets a later tick retry */ }
        continue;
      }
      // This process itself handed the compact to the worker: only it may
      // later claim the compact ran. In-memory only, so a restart inherits the
      // persisted in-flight marker without the success witness. Handed over is
      // not run: the worker still checks the screen before it types anything,
      // and its refusal or the compact's finish is logged as the outcome.
      ds.idleAutoCompactDispatchedTurnId = turnId;
      sent += 1;
      deps.log(`[idle-compact] ${id} /compact dispatched to worker after ${idleMinutes}m idle`
        + (decision.tokens !== undefined ? ` (context ${decision.tokens} tokens` : ' (context size unknown')
        + `, attempt ${attempt}/${IDLE_AUTO_COMPACT_MAX_ATTEMPTS})`);
    } catch (error) {
      deps.log(`[idle-compact] ${id} sweep failed safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}
