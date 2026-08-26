/**
 * Unit tests for IdleDetector.
 *
 * Covers constructor, feed(), onIdle(), completion pattern matching,
 * quiescence detection, ANSI stripping, reset(), dispose(), and edge cases.
 *
 * Run:  pnpm vitest run test/idle-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCursorAdapter } from '../src/adapters/cli/cursor.js';
import { createGeniusAdapter } from '../src/adapters/cli/genius.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal CliAdapter stub with the given patterns. */
function makeCli(opts: {
  completionPattern?: RegExp;
  busyPattern?: RegExp;
  idleToBusyPattern?: RegExp;
  staticBusyPattern?: RegExp;
  staticBusyClearPattern?: RegExp;
  readyPattern?: RegExp;
} = {}): CliAdapter {
  return {
    id: 'test-cli',
    resolvedBin: '/usr/bin/test-cli',
    buildArgs: () => [],
    writeInput: async () => {},
    completionPattern: opts.completionPattern,
    busyPattern: opts.busyPattern,
    idleToBusyPattern: opts.idleToBusyPattern,
    staticBusyPattern: opts.staticBusyPattern,
    staticBusyClearPattern: opts.staticBusyClearPattern,
    readyPattern: opts.readyPattern,
    systemHints: [],
    altScreen: false,
  };
}

// ─── Constructor ──────────────────────────────────────────────────────────

describe('IdleDetector: constructor', () => {
  it('should accept a CliAdapter with completionPattern', () => {
    const cli = makeCli({ completionPattern: /\$\s*$/ });
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });

  it('should accept a CliAdapter without completionPattern', () => {
    const cli = makeCli();
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });

  it('should accept a CliAdapter with readyPattern', () => {
    const cli = makeCli({ readyPattern: />\s*$/ });
    const detector = new IdleDetector(cli);
    expect(detector).toBeInstanceOf(IdleDetector);
    detector.dispose();
  });
});

// ─── onIdle callback ──────────────────────────────────────────────────────

describe('IdleDetector: onIdle()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should register a callback that fires on idle', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('some output');
    // Quiescence timeout is 2000ms, then spinner guard check
    vi.advanceTimersByTime(2000);
    // Spinner guard is 3000ms from last spinner; since lastSpinnerAt = 0,
    // Date.now() - 0 should be > 3000 after advancing enough time
    vi.advanceTimersByTime(3500);

    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not fire callback if none registered', () => {
    const detector = new IdleDetector(makeCli());
    // No callback registered, should not throw
    detector.feed('some output');
    vi.advanceTimersByTime(10000);
    detector.dispose();
  });
});

// ─── onBusy callback ──────────────────────────────────────────────────────

describe('IdleDetector: onBusy()', () => {
  const idleToBusyPattern = /Working[^\r\n]{0,160}esc to interrupt/i;

  it('fires once when an explicit busy marker follows idle, but ignores an ordinary redraw', () => {
    const detector = new IdleDetector(makeCli({ idleToBusyPattern }));
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K› Ask anything');
    expect(cb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K• Working (3s • esc to interrupt)');
    detector.feed('• Working (4s • esc to interrupt)');
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('matches a busy marker split across chunks and re-arms after the next idle', () => {
    const detector = new IdleDetector(makeCli({ idleToBusyPattern }));
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('Wor');
    detector.feed('king (12s • esc to inter');
    detector.feed('rupt)');
    expect(cb).toHaveBeenCalledTimes(1);

    detector.fireIdle();
    detector.feed('• Working (1s • esc to interrupt)');
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it.each(['reset', 'resetReadyEvidence'] as const)(
    'does not report busy after %s without a new idle',
    (method) => {
      const detector = new IdleDetector(makeCli({ idleToBusyPattern }));
      const cb = vi.fn();
      detector.onBusy(cb);

      detector.fireIdle();
      detector[method]();
      detector.feed('• Working (1s • esc to interrupt)');
      expect(cb).not.toHaveBeenCalled();
      detector.dispose();
    },
  );

  it.each([
    {
      name: 'Genius',
      cli: createGeniusAdapter('/bin/genius'),
      redraw: '\x1b[2JThe previous screen said esc to interrupt while it was running.',
    },
    {
      name: 'Grok',
      cli: createGrokAdapter('/bin/grok'),
      redraw: '\x1b[2JThe previous help bar showed Ctrl+c: cancel.',
    },
  ])('does not promote a $name transcript redraw through legacy busyPattern', ({ cli, redraw }) => {
    expect(cli.busyPattern?.test(redraw)).toBe(true);

    const detector = new IdleDetector(cli);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed(redraw);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('Pi opts in: Working... after idle flips busy so a false ready self-heals', () => {
    // Pi's `Working...` is an ephemeral status line — never part of transcript
    // history redraws — so the adapter explicitly sets idleToBusyPattern. A
    // falsely published ready (e.g. a startup-window quiescence idle that
    // slipped past the gates) is corrected as soon as the marker renders:
    // the worker's onBusy pulls isPromptReady back to false and republishes
    // working.
    const cli = createPiAdapter('/bin/pi');
    expect(cli.idleToBusyPattern?.source).toBe(cli.busyPattern?.source);

    const detector = new IdleDetector(cli);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K plain redraw without the marker');
    expect(cb).not.toHaveBeenCalled();
    detector.feed('\x1b[2K● Working... (esc to interrupt)');
    expect(cb).toHaveBeenCalledTimes(1);

    // Re-arms per idle cycle: a second marker in the same cycle stays quiet,
    // the next idle re-arms the edge.
    detector.feed('● Working... still');
    expect(cb).toHaveBeenCalledTimes(1);
    detector.fireIdle();
    detector.feed('● Working...');
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

// ─── TraeX capacity-queue busy pattern (regression) ──────────────────────

describe('IdleDetector: TraeX capacity-queue busy pattern', () => {
  // Bind directly to the production adapter so this suite stays honest if the
  // pattern in adapters/cli/traex.ts ever changes — no parallel hand-rolled
  // regex to drift out of sync. '/bin/true' stub keeps resolveCommand() from
  // failing on hosts without `traex` installed; the lazy resolvedBin getter
  // is never touched by IdleDetector.
  //
  // All PTY text below is composed from strings extracted verbatim from the
  // traex binary's compiled-in TUI string tables (verified across all 9 local
  // releases, 0.201.1-alpha.5 … 0.201.2-alpha.2):
  //   spinner frames:  "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  //   working labels:  "Working…", "Pondering…" (full rotation in traex.ts)
  //   queue strings:   "Queued for capacity",
  //                    "Too many requests right now. You're in the queue."
  //   idle composer:   "Ask TraeCode CLI to do anything" + "100% context left"
  // TraeX forked from Codex and DELETED the "esc to interrupt" footer hint
  // (0 hits across all releases + the 94MB TUI logs).
  const traexAdapter = createTraexAdapter('/bin/true');

  it('flips a queued session back to busy when the capacity-queue string renders after a false idle', () => {
    // TraeX's readyPattern matches the `\d+% left` status bar, so a static
    // queue screen survives the 2s quiescence window and fires a false idle.
    // The adapter's idleToBusyPattern must flip the session back to working
    // as soon as the queue marker renders in the PTY stream.
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2KQueued for capacity');
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('flips busy when the full queue notice renders after a false idle', () => {
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed("\x1b[2KToo many requests right now. You're in the queue.");
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('flips busy when a spinner-anchored working label renders after a false idle', () => {
    // The same self-heal must cover the ordinary working screen, not just
    // the capacity queue — a false idle during a working turn should recover
    // when the spinner status line renders again. The braille frame + label
    // is the real TUI rendering (frame from the compiled-in spinner set,
    // label from the compiled-in spinner string table).
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K⠋ Working…');
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('flips busy on rotating spinner labels beyond Working…', () => {
    // The working status rotates through the full compiled-in label set;
    // every frame must self-heal a false idle.
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K⠹ Pondering…');
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not flip busy on an idle composer redraw', () => {
    // The idle composer (with the `\d+% left` status bar that readyPattern
    // matches) must NOT trigger the busy transition — only the explicit
    // active-turn markers do.
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('does not flip busy on prose containing a working label without the spinner frame', () => {
    // The braille frame anchor is the discriminator: assistant output like
    // "Working… on the fix" must not revive a completed card.
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('Working… on the fix');
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('re-arms the busy edge after the next idle cycle', () => {
    const detector = new IdleDetector(traexAdapter);
    const cb = vi.fn();
    detector.onBusy(cb);

    detector.fireIdle();
    detector.feed('\x1b[2KQueued for capacity');
    expect(cb).toHaveBeenCalledTimes(1);

    // A second queue screen in the same idle→busy cycle stays quiet.
    detector.feed('\x1b[2KQueued for capacity');
    expect(cb).toHaveBeenCalledTimes(1);

    // The next idle re-arms the edge.
    detector.fireIdle();
    detector.feed('\x1b[2K⠼ Working it out…');
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

// ─── TraeX static capacity-queue pre-idle latch (ZMX regression) ─────────

describe('IdleDetector: static capacity-queue pre-idle latch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Same production adapter as the suite above — see its comment for the
  // binary-extraction evidence behind every string used here.
  const traexAdapter = createTraexAdapter('/bin/true');

  it('ZMX shape: one queue+status chunk followed by silence never goes idle; composer redraw recovers', () => {
    // The supported ZMX backend cannot use busyPattern viewport probes
    // (its history is not an authoritative viewport) and never feeds
    // history into IdleDetector, so a static queue screen that matches
    // readyPattern's `\d+% left` arm used to survive quiescence and fire a
    // false idle with no PTY bytes left to self-heal. The pre-idle latch
    // must consume the queue evidence straight from the byte stream.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    // Single chunk: ANSI clear-line + queue notice + readyPattern status bar.
    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    expect(idleCb).not.toHaveBeenCalled();

    // Complete silence, timers far past quiescence (2s) + spinner guard (3s).
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Queue resolves: the real composer redraws (prompt marker, no queue
    // string) — the latch must clear and normal quiescence fire idle.
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('holds the spinner-prefixed queue screen busy the same way', () => {
    // The queue screen can render a frozen braille frame in front of the
    // label; the spinner guard alone would expire after 3s and still
    // false-idle. The latch must cover the spinner-prefixed form too.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('\x1b[2K⠋ Queued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('holds the full queue notice busy, with or without the at-position suffix', () => {
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed("\x1b[2KToo many requests right now. You're in the queue at position 3.\nContext 100% left");
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not latch on a mid-sentence prose quote of the queue string', () => {
    // Line anchoring: assistant transcript prose quoting the queue notice
    // mid-line must not suppress idle. The chunk carries a real composer at
    // the bottom so quiescence is allowed to run.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('The CLI printed "Queued for capacity" and then stalled\n› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(5_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not clear the latch on a noise chunk without fresh ready evidence', () => {
    // The latch is decided from the CURRENT chunk: a stray redraw fragment
    // carrying neither the queue marker nor ready evidence must leave it
    // armed (the queue screen's own `100% left` lingers in the tail and
    // must not be allowed to clear it).
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('clears the latch on reset so a rebased cycle can go idle', () => {
    // ZMX resync / botmux submit call reset(): a latched queue cycle must
    // not suppress idle forever after the state rebase.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.reset();
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    // reset() synthesizes a recent spinner timestamp, so idle needs the full
    // 3s spinner guard on top of the 2s quiescence window.
    vi.advanceTimersByTime(6_000);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('lets external structured completion (fireIdle) through while latched', () => {
    // reliableTurnTerminal (task_complete) is authoritative independently
    // of the screen observer; the latch must not block it.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.fireIdle();
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('generic adapter: latch suppresses screen idle but not external idle, and recovers on composer', () => {
    // Mechanism-level check with a stub adapter so the behavior does not
    // depend on traex's exact string table.
    const detector = new IdleDetector(makeCli({
      staticBusyPattern: /(?:^|[\n\r])[ \t]*QUEUED/i,
      staticBusyClearPattern: /PROMPT>/,
      readyPattern: /PROMPT>/,
    }));
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('QUEUED for capacity\n');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    detector.fireIdle();
    expect(idleCb).toHaveBeenCalledTimes(1);

    // After the external idle, a composer redraw clears the latch and a
    // later silence goes idle via the screen path.
    detector.feed('PROMPT> ');
    vi.advanceTimersByTime(5_500);
    expect(idleCb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('chunk-invariant: queue line and status bar in separate deltas do not clear the latch', () => {
    // ZMX captures history at ~50ms tail debounce / 250ms hot poll; adjacent
    // prefix snapshots each emitData(delta). A queue line in one capture and
    // the `\d+% left` status bar in the next must NOT clear the latch — the
    // broad readyPattern matches the status bar, so only explicit composer
    // evidence (staticBusyClearPattern) may clear it.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    // Chunk 1: queue line only (no status bar yet).
    detector.feed('\x1b[2KQueued for capacity');
    expect(idleCb).not.toHaveBeenCalled();

    // Chunk 2: status bar in a separate delta. The old code cleared the
    // latch here because readyPattern matches `\d+% left`.
    detector.feed('\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Real composer redraw clears the latch and idle fires.
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('chunk-invariant: queue marker split across chunks is detected via rolling tail', () => {
    // The queue text itself can be split across PTY chunks ("Queued for cap"
    // + "acity"). The latch must scan the rolling outputTail, not just the
    // current chunk, to detect the full marker.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    // Chunk 1: first half of the queue marker (no match yet).
    detector.feed('\x1b[2KQueued for cap');
    expect(idleCb).not.toHaveBeenCalled();

    // Chunk 2: second half + status bar. The rolling tail now contains the
    // full "Queued for capacity" string — the latch must fire.
    detector.feed('acity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Real composer redraw clears the latch and idle fires.
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('chunk-internal freshness: submitted user line before fresh queue does not clear latch', () => {
    // ZMX prefix snapshots merge new history into one delta. A submitted
    // user message (`› text`) followed by a fresh queue line in the SAME
    // chunk must NOT clear the latch — the queue is fresher evidence.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('› 请修复这个问题\nQueued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Real composer (placeholder text, not a submitted user line) clears.
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything\nContext 100% left');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('chunk-internal freshness: queue before composer in same chunk clears latch', () => {
    // The inverse: a queue line followed by a real composer redraw in the
    // same chunk means the queue is gone — the latch must clear and idle
    // must fire after quiescence.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('Queued for capacity\nContext 100% left\n› Ask TraeCode CLI to do anything');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('stale-tail: composer clear followed by status-only redraw does not re-latch', () => {
    // After a composer redraw clears the latch, a subsequent status-bar-only
    // chunk (no composer, no fresh queue) must NOT re-set the latch from
    // stale queue text lingering in the rolling tail. ZMX hot-poll makes
    // composer→status-redraw a common sequence. The status-only chunk
    // arrives BEFORE quiescence fires (isIdle still false), so the stale
    // tail is still present.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    // Queue screen latches.
    detector.feed('Queued for capacity\nContext 100% left');
    vi.advanceTimersByTime(5_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Composer redraw clears the latch. Do NOT advance timers yet — the
    // stale tail is still present.
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything');

    // Status-bar-only redraw: tail still has old queue text, but it must
    // not re-latch (stale position < clear position).
    detector.feed('\x1b[2K100% left');
    vi.advanceTimersByTime(5_000);
    // Idle fires: the latch was not re-set by the stale tail.
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('stale-tail: composer+status same chunk followed by status-only redraw does not re-latch', () => {
    // Real-world shape: the composer line itself carries the status bar,
    // followed by a pure status-bar redraw — all before quiescence fires.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('Queued for capacity\n100% left');
    vi.advanceTimersByTime(5_000);
    expect(idleCb).not.toHaveBeenCalled();

    // Composer + status in the same chunk — clear wins (composer is after
    // queue in the chunk).
    detector.feed('› Ask TraeCode CLI to do anything   100% left');

    // Pure status redraw must not re-latch from stale tail.
    detector.feed('100% left');
    vi.advanceTimersByTime(5_000);
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('stale-tail: fresh queue after clear re-latches (position > clear pos)', () => {
    // Control: a genuinely new queue screen AFTER the clear must re-latch.
    // The new queue arrives after idle fired (isIdle=true), so feed()
    // resets the tail and clear position — the new queue is fresh.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    detector.feed('Queued for capacity\nContext 100% left');
    detector.feed('\x1b[2K› Ask TraeCode CLI to do anything');
    vi.advanceTimersByTime(2_500);
    expect(idleCb).toHaveBeenCalledTimes(1);

    // New queue screen — fresh evidence after the clear.
    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    vi.advanceTimersByTime(10_000);
    // Latch held: idle does NOT fire again.
    expect(idleCb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('stale-tail: clear position shifts left when tail window slides', () => {
    // After a composer clear, if the turn produces >~470 chars of output,
    // the tail window slides (drops from head). The clear position must
    // shift left too — otherwise a fresh queue landing at a low index in
    // the new window is falsely treated as stale (position < clearPos).
    // Do NOT advance timers between clear and fresh queue: an idle fire
    // would reset clearPos via the isIdle path, making the test pass
    // without exercising the slide-decrement.
    const detector = new IdleDetector(traexAdapter);
    const idleCb = vi.fn();
    detector.onIdle(idleCb);

    // Queue + filler + composer clear, all before any timer advance.
    detector.feed('Queued for capacity\n100% left');
    detector.feed('z'.repeat(471) + '\n');
    detector.feed('\n› Ask TraeCode CLI to do anything');

    // Fresh queue lands at a LOW index in the new tail window (after the
    // slide). It must re-latch despite the old high clearPos.
    detector.feed('\nQueued for capacity\n' + 't'.repeat(430));
    vi.advanceTimersByTime(10_000);
    // Latch held: idle does NOT fire. Without the slide-decrement, the
    // stale clearPos would suppress the latch and idle would fire.
    expect(idleCb).not.toHaveBeenCalled();
    detector.dispose();
  });
});

// ─── Completion pattern matching ──────────────────────────────────────────

describe('IdleDetector: completion pattern', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should fire idle when completion pattern is matched', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /\$ $/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('command output\n$ ');
    // Completion pattern triggers a 500ms delay
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not fire idle when pattern does not match', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /\$ $/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('still working...');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('should detect pattern built up across multiple feed() calls', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DON');
    vi.advanceTimersByTime(100);
    detector.feed('E>');
    // After second feed, outputTail contains "DONE>", pattern matches
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should detect completion in current chunk even when pushed out of tail', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /COMPLETE/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('COMPLETE' + 'x'.repeat(600));
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── Quiescence detection ─────────────────────────────────────────────────

describe('IdleDetector: quiescence detection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should fire idle after PTY silence (no spinner)', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed plain text (no spinner chars)
    detector.feed('hello world');

    // 2000ms quiescence timer fires, then quiescenceCheck runs
    // lastSpinnerAt = 0, so sinceSpinner = Date.now() which is > 3000ms from epoch
    // with fake timers, Date.now() starts at some value; advance enough
    vi.advanceTimersByTime(2000);
    // After quiescence check, spinner guard needs Date.now() - lastSpinnerAt >= 3000
    // lastSpinnerAt is 0. Date.now() in vitest fake timers starts at real time, so should pass.
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should delay idle if spinner was recently seen', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed spinner character (⠋ = U+280B, in SPINNER_RE)
    detector.feed('loading ⠋');

    vi.advanceTimersByTime(2000);
    // Spinner was just seen, so spinner guard delays idle
    expect(cb).not.toHaveBeenCalled();

    // Advance past spinner guard (3000ms) + buffer (200ms)
    vi.advanceTimersByTime(3500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('still reports quiescence after static busy output', () => {
    const detector = new IdleDetector(makeCli({ busyPattern: /Working\.\.\./ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('Tool 3.3s\nWorking...');
    vi.advanceTimersByTime(10_000);

    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should reset quiescence timer on each new feed', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('output 1');
    vi.advanceTimersByTime(1500);  // Not yet 2000ms
    expect(cb).not.toHaveBeenCalled();

    // New data resets the timer
    detector.feed('output 2');
    vi.advanceTimersByTime(1500);  // 1500ms from last feed, not 3000ms total
    expect(cb).not.toHaveBeenCalled();

    // Now let it expire
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should suppress quiescence when readyPattern is set but not yet seen', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('still loading...');
    vi.advanceTimersByTime(10000);  // Even after long silence
    expect(cb).not.toHaveBeenCalled();

    // Now ready pattern appears
    detector.feed('READY>');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  // Regression (PR #996 P0): cursor-agent renders `sessionEmpty ? "Plan,
  // search, build anything" : "Add a follow-up"` and never reverts. The worker
  // reset()s the detector before every write (clearing readySeen), and
  // quiescence stays suppressed until readyPattern is seen again. A
  // first-turn-only readyPattern therefore matched on turn 1 but never on turn
  // 2+, so idle never fired again and the CLI was stuck reporting "working".
  // With the real cursor adapter's two-state readyPattern, every turn's idle
  // edge survives the reset.
  it('cursor: idle still fires on turn 2+ after the composer placeholder switches', () => {
    const detector = new IdleDetector(createCursorAdapter('/bin/cursor-agent'));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Turn 1: empty-session composer.
    detector.feed('  → Plan, search, build anything');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);

    // Worker resets before writing the next turn's input (clears readySeen).
    detector.reset();

    // Turn 2: cursor now shows the post-turn placeholder. The bug: this never
    // matched a first-turn-only pattern, so readySeen stayed false and idle
    // never fired. The fix: the two-state pattern matches, idle fires again.
    detector.feed('working on it...');
    vi.advanceTimersByTime(2000);
    expect(cb, 'quiescence must stay suppressed until the post-turn composer is seen').toHaveBeenCalledTimes(1);
    detector.feed('  → Add a follow-up');
    vi.advanceTimersByTime(2000);
    expect(cb, 'turn-2 idle must fire on the post-turn "Add a follow-up" placeholder').toHaveBeenCalledTimes(2);
    detector.dispose();
  });
});

// ─── ANSI stripping ──────────────────────────────────────────────────────

describe('IdleDetector: ANSI stripping', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should strip CSI sequences before pattern matching', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed "DONE" wrapped in ANSI color codes
    detector.feed('\x1b[32mDONE\x1b[0m');
    // After stripping: "DONE"
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should convert CSI cursor-forward to spaces', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /A {3}B$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // \x1b[3C = move cursor forward 3 positions -> 3 spaces
    detector.feed('A\x1b[3CB');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should strip OSC sequences (title changes)', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /prompt>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\x1b]0;My Terminal\x07prompt>');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should strip character set designation sequences', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /ready$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\x1b(0ready');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── feed() behavior ─────────────────────────────────────────────────────

describe('IdleDetector: feed()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should start a new detection cycle after already idle', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Adopted panes can receive local terminal input after botmux has already
    // marked the CLI idle. New data should re-arm the detector so transcript
    // fallback can emit when that local work finishes.
    detector.feed('more data DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('should keep only last 500 chars in outputTail', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /END$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed 600 chars of padding followed by "END" — only last 500 visible
    const padding = 'x'.repeat(600);
    detector.feed(padding + 'END');
    vi.advanceTimersByTime(500);
    // "END" should still be in the last 500 chars
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should fall back to quiescence if later data cancels a completion timer', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /^MARKER/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('MARKER');
    // New data before the 500ms completion delay means the CLI is still
    // painting output, so the detector falls back to quiescence.
    detector.feed('y'.repeat(500));
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalled();
    detector.dispose();
  });
});

// ─── reset() ──────────────────────────────────────────────────────────────

describe('IdleDetector: reset()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should allow detecting idle again after reset', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // First idle
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Reset and trigger again
    detector.reset();
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('should clear outputTail on reset', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed partial pattern
    detector.feed('DON');
    detector.reset();

    // Feed the remainder — should NOT match since tail was cleared
    detector.feed('E');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    // Let quiescence handle it instead (need to wait past spinner guard)
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should cancel pending timers on reset', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('data');
    // Timer is pending (2000ms)
    vi.advanceTimersByTime(1000);
    detector.reset();

    // Original timer should have been cleared
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('should reset readySeen flag so quiescence is suppressed again', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // See ready pattern, then go idle
    detector.feed('READY>');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);

    // After reset, readySeen is false again — quiescence suppressed
    detector.reset();
    detector.feed('output without ready');
    vi.advanceTimersByTime(10000);
    expect(cb).toHaveBeenCalledTimes(1);  // Still 1, no new idle
    detector.dispose();
  });

  it('should set lastSpinnerAt to current time on reset', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    // Advance time so lastSpinnerAt (initially 0) is far in the past
    vi.advanceTimersByTime(10000);

    // Reset sets lastSpinnerAt = Date.now(), which acts as a spinner guard
    detector.reset();
    detector.feed('output');

    // After 2000ms quiescence, the spinner guard should still be active
    // because lastSpinnerAt was just set to Date.now()
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();

    // After spinner guard expires (3000ms + 200ms from reset)
    vi.advanceTimersByTime(1500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe('IdleDetector: resetReadyEvidence()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('drops a selector-era prompt and waits for a newly rendered prompt', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /❯/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('startup selector ❯');
    vi.advanceTimersByTime(1_000);
    detector.resetReadyEvidence();

    // The old quiescence timer and readySeen flag were both discarded.
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();

    detector.feed('real Claude prompt ❯');
    vi.advanceTimersByTime(1_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('distinguishes screen evidence from an external idle source', () => {
    const screenDetector = new IdleDetector(makeCli({ readyPattern: /❯/ }));
    const screenCb = vi.fn();
    screenDetector.onIdle(screenCb);
    screenDetector.feed('real prompt ❯');
    vi.advanceTimersByTime(2_000);
    expect(screenCb).toHaveBeenCalledWith('screen');

    const externalDetector = new IdleDetector(makeCli());
    const externalCb = vi.fn();
    externalDetector.onIdle(externalCb);
    externalDetector.fireIdle();
    expect(externalCb).toHaveBeenCalledWith('external');

    screenDetector.dispose();
    externalDetector.dispose();
  });
});

// ─── dispose() ────────────────────────────────────────────────────────────

describe('IdleDetector: dispose()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should clear pending timers', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('data');
    detector.dispose();

    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('should null out the callback', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.dispose();

    // Reset to un-idle, then trigger — callback should be null
    detector.reset();
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── Spinner interaction ──────────────────────────────────────────────────

describe('IdleDetector: spinner handling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should not treat spinner chars as spinners when readyPattern already seen', () => {
    // When readySeen is true, spinner chars in status bar should be ignored
    const detector = new IdleDetector(makeCli({ readyPattern: /READY>/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('READY>');
    // readySeen is now true; feed a dot spinner — should NOT update lastSpinnerAt
    vi.advanceTimersByTime(100);
    detector.feed('\u00B7');  // middle dot ·
    vi.advanceTimersByTime(2000);
    // Should idle without spinner guard delay
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should not update spinner timestamp when completion pattern matches', () => {
    // Spinner chars that are part of the completion marker should be ignored
    const detector = new IdleDetector(makeCli({
      completionPattern: /\u2738$/,  // ✸ — a decorative spinner-like char
    }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('\u2738');
    // Should trigger completion path (500ms), not be blocked by spinner guard
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('IdleDetector: edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should handle rapid sequential feed calls', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /PROMPT>$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Rapid-fire feeds
    for (let i = 0; i < 100; i++) {
      detector.feed(`line ${i}\n`);
    }
    detector.feed('PROMPT>');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle empty string feed', () => {
    const detector = new IdleDetector(makeCli());
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('');
    // Should not crash; timer still set
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle pattern split across chunks with ANSI in between', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /COMPLETE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('COM');
    detector.feed('\x1b[32m');  // ANSI color (stripped)
    detector.feed('PLETE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle completion pattern overriding quiescence timer', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Feed non-matching data to start quiescence timer
    detector.feed('working...');
    vi.advanceTimersByTime(1000);

    // Now feed completion pattern — should switch to completion path
    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should fire idle only once even if multiple conditions met', () => {
    const detector = new IdleDetector(makeCli({ completionPattern: /DONE$/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    detector.feed('DONE');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledTimes(1);

    // Advance more — should not fire again
    vi.advanceTimersByTime(10000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should handle readyPattern appearing in same chunk as other data', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /\u23F5\u23F5/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // Ready pattern in one big chunk with lots of status bar data after it
    detector.feed('loading output...\u23F5\u23F5 status bar info here');
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('should detect readyPattern in the current chunk even if pushed out of tail', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /READY/ }));
    const cb = vi.fn();
    detector.onIdle(cb);

    // READY at the start followed by >500 chars that push it out of tail
    detector.feed('READY' + 'x'.repeat(600));
    // readySeen should be true because stripped chunk is checked directly
    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

// ─── fireIdle (transcript-driven) ──────────────────────────────────────────

describe('IdleDetector: fireIdle()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires the registered callback synchronously', () => {
    const detector = new IdleDetector(makeCli({ readyPattern: /❯/ }));
    const cb = vi.fn();
    detector.onIdle(cb);
    // Note: readyPattern is NOT yet seen — fireIdle short-circuits regardless,
    // because the transcript event is the authoritative signal.
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('is idempotent within a turn (does not re-fire while already idle)', () => {
    const detector = new IdleDetector(makeCli({}));
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.fireIdle();
    detector.fireIdle();
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('cancels a pending quiescence timer so we do not double-fire', () => {
    const detector = new IdleDetector(makeCli({}));
    const cb = vi.fn();
    detector.onIdle(cb);
    // Arm quiescence with some output, then fire idle externally before
    // the timer matures — the timer should be torn down.
    detector.feed('streaming output ');
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('re-arms after reset() so a new turn can fire idle again', () => {
    const detector = new IdleDetector(makeCli({}));
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(1);
    detector.reset();
    detector.fireIdle();
    expect(cb).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('works even when readyPattern was never matched (transcript bypasses screen scrape)', () => {
    // The whole point of the transcript-driven path: when the CLI's status
    // bar changes between versions and our readyPattern stops matching,
    // an explicit fireIdle from the transcript watcher still surfaces the
    // turn instead of stranding it forever.
    const detector = new IdleDetector(makeCli({ readyPattern: /THIS_NEVER_APPEARS/ }));
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('lots of output that does not contain the magic ready token');
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(0);  // regex+quiescence both gated off
    detector.fireIdle();                    // transcript event arrives
    expect(cb).toHaveBeenCalledTimes(1);   // ← the bug class this fixes
    detector.dispose();
  });
});

// ─── CoCo readyPattern variants (regression: Trae CLI 0.120.31) ──────────

describe('IdleDetector: CoCo readyPattern compatibility', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Bind directly to the production adapter so this suite stays honest if
  // the readyPattern in adapters/cli/coco.ts ever changes — no parallel
  // hand-rolled regex to drift out of sync. We swap in a stub binary so
  // resolveCommand() doesn't fail on hosts without `coco` installed.
  const cocoAdapter = createCocoAdapter('/bin/true');

  it('matches `⏵⏵` when CoCo runs with --yolo (bypass permissions)', () => {
    const detector = new IdleDetector(cocoAdapter);
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('⏵⏵ bypass permissions on');
    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('matches `⬡` when CoCo runs without --yolo (adopted session)', () => {
    // Pre-d289034 the readyPattern was just /⏵⏵/; an adopted CoCo (no --yolo)
    // never matched, idle never fired, the transcript bridge never drained
    // — and the user got radio silence on Lark.
    const detector = new IdleDetector(cocoAdapter);
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('⬡ openrouter-2o');
    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('does not match unrelated decorative chars on CoCo screens', () => {
    // Things like █ ◆ in the Trae announcements banner must not flip readySeen.
    const detector = new IdleDetector(cocoAdapter);
    const cb = vi.fn();
    detector.onIdle(cb);
    detector.feed('█ ◆ ◆ █  Try Codebase Copilot');
    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(0);
    detector.dispose();
  });
});
