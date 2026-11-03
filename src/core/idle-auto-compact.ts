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
 *  - the idle clock is the daemon's existing `ds.idleSinceAt` (stamped on the
 *    non-idle → idle edge by worker-pool's stampIdleSinceAt);
 *  - the daemon's 60s idle sweep calls {@link runIdleAutoCompactSweep};
 *  - the compact itself goes through the same passthrough path as the card
 *    「🗜️ 压缩」button, with the unattended-maintenance safe-composer gate.
 *
 * Fires once per idle stretch: the stretch that was compacted (or skipped) is
 * recorded in `handledIdleSince`, and the compact's own busy → idle edge is
 * recognised through the persisted `inFlight` marker and folded into the
 * handled stretch, so a still-idle session is never compacted again. Any real activity
 * produces a new idle edge and therefore a new, unhandled stretch.
 *
 * Restart: `idleSince` / `handledIdleSince` are persisted on the session row
 * (only while the feature is on). On the first idle edge after a daemon
 * restart, a persisted stretch that no newer message superseded is kept, so the
 * timer continues from the real idle start instead of restarting at boot.
 */
import type { DaemonSession } from './types.js';
import { supportsNativeAutoCompactRuntime } from './auto-compact.js';
import { KEEPALIVE_IN_FLIGHT_STALE_MS } from '../services/prompt-cache-policy.js';

export interface IdleAutoCompactSetting {
  enabled: boolean;
  /** Idle minutes before compacting (1–59). Absent = default. */
  minutes?: number;
  /** Start (epoch ms) of the current idle stretch; cleared on a busy edge. */
  idleSince?: number;
  /** Idle stretch (epoch ms start) already compacted or skipped. */
  handledIdleSince?: number;
  /** Our `/compact` was accepted but its own busy → idle edge is not seen yet.
   *  Persisted so a daemon restart mid-compact does not mistake the compact's
   *  finish for a new idle stretch. Cleared by that edge or any other turn. */
  inFlight?: { turnId: string; since: number; idleMinutes: number; tokens?: number };
}

export const IDLE_AUTO_COMPACT_DEFAULT_MINUTES = 55;
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
  | 'idleAutoCompactPendingNotice' | 'idleAutoCompactDispatchedTurnId' | 'promptCacheKeepalive'>;

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

/** Start of the idle stretch the timer counts from: the persisted stretch when
 *  it is older than the live stamp (restored across a daemon restart), else
 *  the live stamp. */
function stretchStart(ds: IdleAutoCompactSessionState): number | undefined {
  const live = ds.idleSinceAt;
  if (live === undefined) return undefined;
  const persisted = ds.session.idleAutoCompact?.idleSince;
  return persisted !== undefined && persisted <= live ? persisted : live;
}

function liveInFlight(setting: IdleAutoCompactSetting, now: number): IdleAutoCompactSetting['inFlight'] {
  const f = setting.inFlight;
  return f && now - f.since < IDLE_AUTO_COMPACT_IN_FLIGHT_STALE_MS ? f : undefined;
}

/**
 * Screen-status hook, called right after `ds.lastScreenStatus` / `idleSinceAt`
 * were updated (worker-pool stampIdleSinceAt). Returns true when the persisted
 * setting changed and the caller should save the session row.
 */
export function noteIdleAutoCompactScreenStatus(
  ds: IdleAutoCompactSessionState,
  prev: DaemonSession['lastScreenStatus'],
  now = Date.now(),
): boolean {
  const setting = ds.session.idleAutoCompact;
  if (!setting?.enabled || prev === ds.lastScreenStatus) return false;
  if (ds.lastScreenStatus !== 'idle' || ds.idleSinceAt === undefined) {
    if (setting.idleSince === undefined) return false;
    delete setting.idleSince;
    return true;
  }
  const idle = ds.idleSinceAt;
  const finished = liveInFlight(setting, now);
  if (finished) {
    // Our own /compact just finished: the stretch it opens counts as handled.
    delete setting.inFlight;
    setting.idleSince = idle;
    setting.handledIdleSince = idle;
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
  delete setting.inFlight;
  const persisted = setting.idleSince;
  const lastMessageAt = Date.parse(ds.session.lastMessageAt ?? '');
  if (persisted !== undefined && persisted <= idle
    && (!Number.isFinite(lastMessageAt) || lastMessageAt <= persisted)) {
    // First idle edge after a daemon restart (or a worker respawn with no new
    // input): the stretch that was running before continues.
    return false;
  }
  if (persisted === idle) return false;
  setting.idleSince = idle;
  return true;
}

/** A turn started. Any turn other than our own in-flight compact ends the
 *  in-flight window, so its idle edge opens a fresh, unhandled stretch (the
 *  row is saved by that turn's own busy edge). */
export function noteIdleAutoCompactTurnStarted(
  ds: Pick<DaemonSession, 'session'>,
  turnId: string,
): void {
  const setting = ds.session.idleAutoCompact;
  if (setting?.inFlight && setting.inFlight.turnId !== turnId) delete setting.inFlight;
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

/** Forget the persisted idle-stretch mirror and any in-flight marker when the
 *  live CLI is destroyed (worker suspend): a cold-resumed CLI opens a fresh
 *  idle edge, and compacting it immediately would read the whole context
 *  cold — the cost this feature exists to avoid. Returns true when the
 *  persisted setting changed (the caller saves the row). */
export function clearIdleAutoCompactStretch(session: { idleAutoCompact?: IdleAutoCompactSetting }): boolean {
  const setting = session.idleAutoCompact;
  if (!setting || (setting.idleSince === undefined && !setting.inFlight)) return false;
  delete setting.idleSince;
  delete setting.inFlight;
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
