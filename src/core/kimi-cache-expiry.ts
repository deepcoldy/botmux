/**
 * Kimi Code's "cache expired" menu (utils/kimi-cache-expiry-menu.ts): what the
 * worker does once the menu is up and a botmux turn waits on it.
 *
 * One menu *event* runs from the menu appearing on a settled screen to it
 * being gone from a settled screen (the input hold's own lifecycle, see
 * worker.ts refreshHookReviewInputHold). Each event is decided at most once:
 *
 *  - the session opted into 缓存过期自动压缩 and nothing argues against it →
 *    press Enter on "Compact and continue" (pointer re-verified on a fresh
 *    capture by the stuck-key guard right before the write), then wait up to
 *    {@link KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS} for OSC 7501 `working`. Kimi
 *    reports it the moment compaction starts and keeps it through the
 *    re-sent message, so `working` is the proof the turn goes on;
 *  - otherwise, or when that proof never comes while the menu is still up →
 *    raise the stuck card for the page (its only key is that same Enter).
 *
 * The menu disappearing and coming back is a new event (Kimi asks once per
 * idle cycle), so dedup is per event, never per CLI lifetime. Nothing is
 * decided while no botmux input waits on the menu: a menu Kimi drew on a
 * resumed session with nothing queued just stays until the next message is
 * held off it (the hold then calls {@link KimiCacheExpiryController.kick}).
 *
 * Never automatic (the card is raised instead):
 *  - the pointer is not on "Compact and continue" (`kimi cache expiry moved`);
 *  - someone interrupted the CLI (/stop, Esc) or typed into its terminal since
 *    the menu appeared — a human is handling it;
 *  - the worker is paused for the CLI: restarting, input delivery
 *    quarantined, or no authoritative screen to verify the pointer on.
 * Every step re-checks the CLI lifetime; a respawned CLI drops the attempt.
 */
import type { StuckPageType } from '../utils/stuck-detector.js';
import { isKimiCacheExpiryPage } from '../utils/stuck-detector.js';

/** Bounded wait for OSC 7501 `working` after the automatic Enter. Kimi 2.5.3
 *  reported it in the same output burst that erased the menu in every probe
 *  (before its "Compacting…" line); the window only absorbs a loaded host. */
export const KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS = 10_000;
/** Let the menu finish painting (and a transient frame settle) before the
 *  event is decided. */
export const KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS = 500;
/** A decision whose fresh capture does not show the menu (yet) is retried
 *  this many times at the settle cadence; the menu leaving for good closes
 *  the event instead (menuGone). */
export const KIMI_CACHE_EXPIRY_DECIDE_RETRIES = 6;

export type KimiCacheExpiryCardReason = 'turn_stalled' | 'input_held';

export interface KimiCacheExpiryPage {
  pageType: StuckPageType | undefined;
  screen: string;
}

export type KimiCompactPressResult =
  /** Enter was written on a re-verified `kimi cache expiry` page. */
  | { kind: 'written' }
  /** Refused before writing: the page changed, the CLI was replaced, or no
   *  fresh capture was possible. */
  | { kind: 'expired' }
  /** The write itself failed. */
  | { kind: 'failed' };

export interface KimiCacheExpiryDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The session setting (缓存过期自动压缩), read at decision time. */
  autoCompactEnabled(): boolean;
  /** CLI lifetime nonce: bumps on every CLI/backend (re)start. */
  lifetime(): number;
  /** Counts interrupts (/stop Ctrl-C, Esc) sent to the CLI. */
  interruptGeneration(): number;
  /** Counts keystrokes forwarded from a writable web terminal. */
  webInputGeneration(): number;
  /** Why the worker must not act for the CLI right now, or undefined. */
  pausedReason(): string | undefined;
  /** A written botmux turn waits on the CLI (not yet back at its prompt). */
  turnInFlight(): boolean;
  /** Queued botmux input is held off the menu. */
  inputHeld(): boolean;
  /** Fresh authoritative capture, classified as Kimi pages; undefined when no
   *  such capture can be taken — UNKNOWN, never "the menu is gone". */
  capturePage(): KimiCacheExpiryPage | undefined;
  /** The menu as the input hold last saw it, while the hold still stands (a
   *  release needs a settled screen without the menu). Stands in for a capture
   *  that failed. */
  lastKnownPage(): KimiCacheExpiryPage | undefined;
  /** Guarded Enter for `kimi cache expiry` (stuck-key guard: lifetime, fresh
   *  capture, page re-match, key allow-list). `veto` is asked once more right
   *  before the key is written — after the guard's capture, the last await —
   *  and a reason refuses the key. */
  pressCompact(expectedLifetime: number, veto: () => string | undefined): Promise<KimiCompactPressResult>;
  /** OSC 7501 currently holds the CLI `working`. */
  programStatusWorking(): boolean;
  raiseCard(input: { reason: KimiCacheExpiryCardReason; page: KimiCacheExpiryPage; elapsedMs: number; noticeKey?: KimiCacheExpiryNoticeKey }): void;
  notify(key: KimiCacheExpiryNoticeKey, params: Record<string, string>): void;
  log(message: string): void;
}

export type KimiCacheExpiryNoticeKey =
  | 'worker.kimi_cache_expiry.auto_started'
  | 'worker.kimi_cache_expiry.auto_failed'
  | 'worker.kimi_cache_expiry.auto_write_failed'
  | 'worker.kimi_cache_expiry.auto_unconfirmed';

type Decision = 'pending' | 'auto' | 'card';

interface MenuEvent {
  seq: number;
  lifetime: number;
  openedAtMs: number;
  interruptGeneration: number;
  webInputGeneration: number;
  decision: Decision;
  /** Decisions that found no menu on the fresh capture. */
  misses: number;
}

interface AutoAttempt {
  seq: number;
  lifetime: number;
  phase: 'pressing' | 'awaiting_working';
  writtenAtMs?: number;
  timer?: unknown;
}

export class KimiCacheExpiryController {
  private seq = 0;
  private event: MenuEvent | undefined;
  private attempt: AutoAttempt | undefined;
  private decideTimer: unknown;

  constructor(private readonly deps: KimiCacheExpiryDeps) {}

  /** The menu is on a settled screen (input hold engaged on a Kimi page). */
  menuShown(): void {
    const lifetime = this.deps.lifetime();
    if (this.event && this.event.lifetime === lifetime) return;
    this.seq += 1;
    this.event = {
      seq: this.seq,
      lifetime,
      openedAtMs: this.deps.now(),
      interruptGeneration: this.deps.interruptGeneration(),
      webInputGeneration: this.deps.webInputGeneration(),
      decision: 'pending',
      misses: 0,
    };
    this.deps.log(`Kimi cache-expiry menu event #${this.seq} opened`);
    this.scheduleDecide();
  }

  /** A settled screen without the menu: the event is over. A running attempt
   *  keeps waiting for its `working` (the menu goes away as compaction starts). */
  menuGone(): void {
    if (!this.event) return;
    this.deps.log(`Kimi cache-expiry menu event #${this.event.seq} closed (${this.event.decision})`);
    this.event = undefined;
    this.cancelDecide();
  }

  /** Something now waits on the menu (input held off it, or the screen-idle
   *  veto saw it under a written turn): decide the event if still pending.
   *  Callers have just seen the menu, so an event is opened if none is (the
   *  hold may have engaged under a previous CLI generation). */
  kick(): void {
    this.menuShown();
    if (!this.event || this.event.decision !== 'pending') return;
    this.scheduleDecide();
  }

  /** OSC 7501 reported `working`. */
  programStatusWorking(): void {
    const attempt = this.attempt;
    if (!attempt || attempt.phase !== 'awaiting_working') return;
    if (attempt.lifetime !== this.deps.lifetime()) {
      this.dropAttempt('CLI replaced');
      return;
    }
    this.finishStarted(attempt);
  }

  private scheduleDecide(): void {
    this.cancelDecide();
    this.decideTimer = this.deps.setTimer(() => {
      this.decideTimer = undefined;
      void this.decide();
    }, KIMI_CACHE_EXPIRY_DECIDE_SETTLE_MS);
  }

  private cancelDecide(): void {
    if (this.decideTimer !== undefined) this.deps.clearTimer(this.decideTimer);
    this.decideTimer = undefined;
  }

  private async decide(): Promise<void> {
    const event = this.event;
    if (!event || event.decision !== 'pending') return;
    if (event.lifetime !== this.deps.lifetime()) {
      this.event = undefined;
      return;
    }
    const turnInFlight = this.deps.turnInFlight();
    const inputHeld = this.deps.inputHeld();
    // Nothing waits on the menu yet: leave the event pending; a held message
    // or the screen-idle veto kicks it again.
    if (!turnInFlight && !inputHeld) return;
    const reason: KimiCacheExpiryCardReason = turnInFlight ? 'turn_stalled' : 'input_held';
    const page = this.deps.capturePage();
    if (!page || !isKimiCacheExpiryPage(page.pageType)) {
      // The frame that opened the event may be ahead of what a capture shows,
      // or the capture failed: look again, boundedly (later kicks — the tick,
      // a held message, the idle veto — start over).
      event.misses += 1;
      if (event.misses <= KIMI_CACHE_EXPIRY_DECIDE_RETRIES) {
        this.scheduleDecide();
        return;
      }
      // Still no capture to verify the pointer on, while the hold stands on
      // the menu: never a key, but a human must hear about it.
      const held = page ? undefined : this.deps.lastKnownPage();
      if (held && isKimiCacheExpiryPage(held.pageType)) {
        event.decision = 'card';
        this.deps.log(`Kimi cache-expiry menu event #${event.seq}: card (no capture to verify the menu on)`);
        this.deps.raiseCard({ reason, page: held, elapsedMs: this.deps.now() - event.openedAtMs });
      }
      return;
    }
    const notAuto = this.whyNotAuto(event, page);
    if (notAuto) {
      event.decision = 'card';
      this.deps.log(`Kimi cache-expiry menu event #${event.seq}: card (${notAuto})`);
      this.deps.raiseCard({ reason, page, elapsedMs: this.deps.now() - event.openedAtMs });
      return;
    }
    event.decision = 'auto';
    await this.runAuto(event, reason);
  }

  private whyNotAuto(event: MenuEvent, page: KimiCacheExpiryPage): string | undefined {
    if (page.pageType !== 'kimi cache expiry') return 'pointer not on Compact and continue';
    return this.autoVeto(event);
  }

  /** What may change while the key is on its way: re-asked right before the
   *  write, so an Esc, a keystroke, a toggle or a restart landing during the
   *  guard's capture still stops it. */
  private autoVeto(event: MenuEvent): string | undefined {
    if (!this.deps.autoCompactEnabled()) return 'auto-compact off';
    if (this.deps.interruptGeneration() !== event.interruptGeneration) return 'interrupted';
    if (this.deps.webInputGeneration() !== event.webInputGeneration) return 'terminal input since the menu appeared';
    if (event.lifetime !== this.deps.lifetime()) return 'CLI replaced';
    return this.deps.pausedReason();
  }

  /** The menu now: a fresh capture, or — when none can be taken — what the
   *  standing input hold last saw. Undefined only when neither shows it. */
  private currentPage(): KimiCacheExpiryPage | undefined {
    const page = this.deps.capturePage();
    if (page) return isKimiCacheExpiryPage(page.pageType) ? page : undefined;
    const held = this.deps.lastKnownPage();
    return held && isKimiCacheExpiryPage(held.pageType) ? held : undefined;
  }

  private async runAuto(event: MenuEvent, reason: KimiCacheExpiryCardReason): Promise<void> {
    const attempt: AutoAttempt = { seq: event.seq, lifetime: event.lifetime, phase: 'pressing' };
    this.attempt = attempt;
    this.deps.log(`Kimi cache-expiry menu event #${event.seq}: auto-compact (Compact and continue)`);
    let result: KimiCompactPressResult;
    let vetoed: string | undefined;
    try {
      result = await this.deps.pressCompact(event.lifetime, () => (vetoed = this.autoVeto(event)));
    } catch (err) {
      this.deps.log(`Kimi cache-expiry auto-compact press threw: ${err instanceof Error ? err.message : String(err)}`);
      result = { kind: 'failed' };
    }
    if (this.attempt !== attempt) return;
    if (attempt.lifetime !== this.deps.lifetime()) {
      this.dropAttempt('CLI replaced');
      return;
    }
    if (result.kind === 'written') {
      attempt.phase = 'awaiting_working';
      attempt.writtenAtMs = this.deps.now();
      if (this.deps.programStatusWorking()) {
        this.finishStarted(attempt);
        return;
      }
      attempt.timer = this.deps.setTimer(() => this.workingWindowExpired(attempt, reason), KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS);
      return;
    }
    this.attempt = undefined;
    // Not written: hand the event to a human if the menu is (or may still be)
    // there — the pointer may have moved, that page's card offers no key.
    const current = this.currentPage();
    if (current) {
      if (this.event === event) event.decision = 'card';
      this.deps.log(`Kimi cache-expiry auto-compact not written (${vetoed ?? result.kind}); raising the card`);
      this.deps.raiseCard({
        reason,
        page: current,
        elapsedMs: this.deps.now() - event.openedAtMs,
        ...(result.kind === 'failed' ? { noticeKey: 'worker.kimi_cache_expiry.auto_write_failed' as const } : {}),
      });
      return;
    }
    this.deps.log(`Kimi cache-expiry auto-compact not written (${vetoed ?? result.kind}); the menu is gone`);
  }

  private workingWindowExpired(attempt: AutoAttempt, reason: KimiCacheExpiryCardReason): void {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    if (attempt.lifetime !== this.deps.lifetime()) {
      this.deps.log('Kimi cache-expiry auto-compact: CLI replaced while waiting for working');
      return;
    }
    if (this.deps.programStatusWorking()) {
      this.finishStarted(attempt);
      return;
    }
    const secs = String(Math.round(KIMI_CACHE_EXPIRY_WORKING_WINDOW_MS / 1000));
    // No `working`: the menu still up — or a capture that fails while the
    // hold still stands on it — is a failed Enter.
    const page = this.currentPage();
    const event = this.event;
    if (page && event && event.seq !== attempt.seq) {
      // The menu went away and came back meanwhile: that is a new event, and
      // it is decided on its own.
      this.deps.log(`Kimi cache-expiry auto-compact unconfirmed: menu event #${event.seq} replaced #${attempt.seq}`);
      return;
    }
    if (page) {
      // Still idle and the menu still up: the automatic Enter did not take.
      if (event) event.decision = 'card';
      this.deps.log(`Kimi cache-expiry auto-compact failed: no working within ${secs}s and the menu is still up`);
      this.deps.raiseCard({
        reason,
        page,
        elapsedMs: this.deps.now() - (attempt.writtenAtMs ?? this.deps.now()),
        noticeKey: 'worker.kimi_cache_expiry.auto_failed',
      });
      return;
    }
    this.deps.log(`Kimi cache-expiry auto-compact unconfirmed: no working within ${secs}s, menu gone`);
    this.deps.notify('worker.kimi_cache_expiry.auto_unconfirmed', { secs });
  }

  private finishStarted(attempt: AutoAttempt): void {
    if (attempt.timer !== undefined) this.deps.clearTimer(attempt.timer);
    if (this.attempt === attempt) this.attempt = undefined;
    this.deps.log(`Kimi cache-expiry menu event #${attempt.seq}: compaction started`);
    this.deps.notify('worker.kimi_cache_expiry.auto_started', {});
  }

  private dropAttempt(why: string): void {
    const attempt = this.attempt;
    if (!attempt) return;
    if (attempt.timer !== undefined) this.deps.clearTimer(attempt.timer);
    this.attempt = undefined;
    this.deps.log(`Kimi cache-expiry auto-compact dropped: ${why}`);
  }
}

// ─── Session setting (daemon side) ──────────────────────────────────────────

export interface KimiCacheExpirySupportSnapshot {
  cliId: string;
  backendType: string | undefined;
  adopted: boolean;
  headless: boolean;
  vcMeetingReceiver: boolean;
}

/** Kimi Code on a local backend whose screen the worker can verify the menu's
 *  pointer on (PTY, tmux; unset = the default local backend), in a session
 *  botmux owns. */
export function supportsKimiCacheExpiryAutoCompact(s: KimiCacheExpirySupportSnapshot): boolean {
  return s.cliId === 'kimi'
    && (s.backendType === undefined || s.backendType === 'pty' || s.backendType === 'tmux')
    && !s.adopted && !s.headless && !s.vcMeetingReceiver;
}

export function isKimiCacheExpiryAutoCompactEnabled(session: { kimiCacheExpiryAutoCompact?: { enabled: boolean } }): boolean {
  return session.kimiCacheExpiryAutoCompact?.enabled === true;
}

/** Turn the setting on/off for one session (caller persists, and restores the
 *  returned previous value when that fails). */
export function applyKimiCacheExpiryAutoCompact(
  session: { kimiCacheExpiryAutoCompact?: { enabled: boolean } },
  enabled: boolean,
): { enabled: boolean } | undefined {
  const previous = session.kimiCacheExpiryAutoCompact ? { ...session.kimiCacheExpiryAutoCompact } : undefined;
  session.kimiCacheExpiryAutoCompact = { enabled };
  return previous;
}
