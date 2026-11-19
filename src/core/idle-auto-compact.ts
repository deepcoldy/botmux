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
 * botmux turn opens a new, unhandled stretch.
 *
 * Restart: `idleSince` / `handledIdleSince` / `armed` are persisted on the
 * session row (only while the feature is on), so after a daemon restart the
 * timer continues from the real idle start instead of restarting at boot, and
 * a turn that was running when the daemon went down still opens its stretch.
 */
import type { DaemonSession } from './types.js';
import { supportsNativeAutoCompactRuntime } from './auto-compact.js';
import { KEEPALIVE_IN_FLIGHT_STALE_MS } from '../services/prompt-cache-policy.js';

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
   *  finish for a new idle stretch. Cleared by that edge or any other turn. */
  inFlight?: { turnId: string; since: number; idleMinutes: number; tokens?: number };
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

type IdleAutoCompactSessionState = Pick<DaemonSession,
  'session' | 'lastScreenStatus' | 'idleSinceAt'
  | 'idleAutoCompactPendingNotice' | 'idleAutoCompactDispatchedTurnId' | 'promptCacheKeepalive'
  | 'idleAutoCompactWarmSince' | 'idleAutoCompactArm'>;

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
 * Turn the feature on/off for one session (caller persists). Minutes and the
 * handled stretch survive any toggle, so off → on inside one idle stretch never
 * compacts that stretch twice; the running-stretch mirror is dropped on off
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
  const finished = liveInFlight(setting!, now);
  if (finished) {
    // Our own /compact just finished: the stretch it opens counts as handled.
    delete setting!.inFlight;
    ds.idleAutoCompactWarmSince = idle;
    setting!.idleSince = idle;
    setting!.handledIdleSince = idle;
    // Only a compact THIS process dispatched may be announced as done. A
    // marker inherited from a restarted daemon is folded as handled (never
    // compacted twice) but makes no success claim — we never saw it run.
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

/** A botmux turn started: it sends a request to the model, so the idle edge
 *  that follows opens a fresh, warm stretch. Our own idle /compact does not
 *  arm one (its finishing edge is folded as handled; if it is cancelled first,
 *  the already-handled stretch stays current instead of being compacted
 *  again). Any other turn also ends the in-flight window. The row is saved by
 *  the turn's busy edge. */
export function noteIdleAutoCompactTurnStarted(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactArm' | 'lastScreenStatus'>,
  turnId: string,
  now = Date.now(),
): void {
  const setting = ds.session.idleAutoCompact;
  if (setting?.inFlight && setting.inFlight.turnId !== turnId) delete setting.inFlight;
  if (turnId.startsWith(IDLE_AUTO_COMPACT_TURN_PREFIX)) return;
  // Started while the CLI is already busy: no new busy edge will follow, the
  // turn runs on in the same busy period.
  ds.idleAutoCompactArm = { at: now, busy: BUSY_SCREEN_STATUSES.has(ds.lastScreenStatus ?? '') };
}

/** The worker refused our unattended write (no live empty-composer proof).
 *  The stretch stays handled (no retry loop); the topic is told it was skipped.
 *  Returns true when the caller should save the session row. */
export function noteIdleAutoCompactRefused(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactPendingNotice' | 'idleAutoCompactDispatchedTurnId'>,
  turnId: string,
): boolean {
  const setting = ds.session.idleAutoCompact;
  if (setting?.inFlight?.turnId !== turnId) return false;
  ds.idleAutoCompactPendingNotice = { kind: 'refused', idleMinutes: setting.inFlight.idleMinutes };
  delete setting.inFlight;
  delete ds.idleAutoCompactDispatchedTurnId;
  return true;
}

/** The compact turn reached a terminal receipt. Anything other than
 *  `completed` (cancelled / failed / ambiguous — Ctrl-C, a crash, an
 *  interrupted compact) means the topic must not be told the compact ran:
 *  the stretch stays handled (no immediate retry) and, when this process
 *  witnessed the dispatch, an "interrupted" notice is queued. Also retracts a
 *  `compacted` notice whose finishing edge beat the terminal here but has not
 *  been posted yet (the two events can race on Ctrl-C/crash). Returns true
 *  when the caller should save the session row. */
export function noteIdleAutoCompactTurnEnded(
  ds: IdleAutoCompactSessionState,
  turnId: string,
  status: string,
): boolean {
  if (status === 'completed') return false;
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
  | { kind: 'refused'; idleMinutes: number }
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
  if (p.kind === 'compacted' && p.tokens !== undefined) {
    return { kind: 'compacted', idleMinutes: p.idleMinutes, tokens: p.tokens };
  }
  return { kind: p.kind, idleMinutes: p.idleMinutes };
}

/** Forget the warm stretch, the arm and any in-flight marker when the live CLI
 *  is destroyed (worker suspend): the cold-resumed CLI has no warm cache, so
 *  nothing is timed until the next botmux turn. Returns true when the
 *  persisted setting changed (the caller saves the row). */
export function clearIdleAutoCompactStretch(
  ds: Pick<DaemonSession, 'session' | 'idleAutoCompactWarmSince' | 'idleAutoCompactArm'>,
): boolean {
  ds.idleAutoCompactWarmSince = undefined;
  ds.idleAutoCompactArm = undefined;
  const setting = ds.session.idleAutoCompact;
  if (!setting || (setting.idleSince === undefined && !setting.inFlight && setting.armed === undefined)) return false;
  delete setting.idleSince;
  delete setting.inFlight;
  delete setting.armed;
  return true;
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
      const pending = ds.idleAutoCompactPendingNotice;
      if (pending) {
        ds.idleAutoCompactPendingNotice = undefined;
        deps.notify(ds, postedNotice(pending));
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
        current()!.handledIdleSince = decision.stretch;
        deps.persist(ds);
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
      claim.handledIdleSince = decision.stretch;
      claim.idleSince = decision.stretch;
      claim.inFlight = { turnId, since: now, idleMinutes, ...(decision.tokens !== undefined ? { tokens: decision.tokens } : {}) };
      deps.persist(ds);
      let accepted = false;
      try {
        accepted = deps.compact(ds, turnId);
      } catch (error) {
        deps.log(`[idle-compact] ${id} send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!accepted) {
        // Not delivered: release the claim so a later tick inside the window retries.
        const release = current();
        if (release) {
          if (release.inFlight?.turnId === turnId) delete release.inFlight;
          if (previousHandled === undefined) delete release.handledIdleSince;
          else release.handledIdleSince = previousHandled;
          if (ds.idleAutoCompactDispatchedTurnId === turnId) delete ds.idleAutoCompactDispatchedTurnId;
          deps.persist(ds);
        }
        continue;
      }
      // This process itself saw the worker accept the compact: only it may
      // later claim the compact ran. In-memory only, so a restart inherits the
      // persisted in-flight marker without the success witness.
      ds.idleAutoCompactDispatchedTurnId = turnId;
      sent += 1;
      deps.log(`[idle-compact] ${id} /compact sent after ${idleMinutes}m idle`
        + (decision.tokens !== undefined ? ` (context ${decision.tokens} tokens)` : ' (context size unknown)'));
    } catch (error) {
      deps.log(`[idle-compact] ${id} sweep failed safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}
