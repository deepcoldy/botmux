/**
 * Worker wiring of the "CLI is stuck on a blocking page" hold and card,
 * executed as the REAL worker functions (test/helpers/worker-function-harness)
 * against real adapters, real captures (test/fixtures/stuck-pages) and the
 * real classifier / catalog helpers:
 *
 *  - which CLIs hold input on which pages (the adapter's stuckPageFamily
 *    declaration, not a hard-coded cliId);
 *  - a held message raises the stuck card for ITS turn (reason input_held)
 *    on an authoritative screen, a plain notice naming the actual CLI
 *    otherwise;
 *  - after a card key lands, the post-key screen either releases the held
 *    input or raises a card for the next page;
 *  - the first-prompt timeout never force-writes into a recognised page;
 *  - the non-durable submit_unconfirmed notice becomes the stuck card when
 *    the page is recognised;
 *  - screen text leaves the terminal only as the redacted tail of a page
 *    classifyStuckPage recognises on a codex-family CLI (never a login page,
 *    a non-authoritative screen, the composer or any other free-form screen).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import {
  classifyStuckPage,
  shouldHoldInputForHookReview,
  shouldHoldInputForStuckPage,
} from '../src/utils/stuck-detector.js';
import { isAllowedStuckKeySequence, redactStuckPageTail, stuckScreenTail } from '../src/core/stuck-page-catalog.js';
import { detectCliStartupBlocker, screenMayShowCredential } from '../src/core/cli-startup-blocker.js';
import { diagnoseSubmitFailure } from '../src/services/submit-failure-diagnosis.js';
import { processStuckWarningTuiKeys, shouldRearmStuckDetector } from '../src/utils/stuck-key-guard.js';

const page = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/stuck-pages', name), 'utf-8');
const TRAEX_STARTUP = page('traex-0.213.1-hooks-startup-menu.txt');
const TRAEX_L1 = page('traex-0.213.1-hooks-browser-l1.txt');
const TRAEX_STARTUP_AFTER_ESC = page('traex-0.213.1-hooks-startup-menu-after-l1-esc.txt');
const TRAEX_MIGRATION = page('traex-0.213.1-migration-menu.txt');
const TRAEX_LOCK = page('traex-0.213.1-session-lock.txt');
const TRAEX_COMPOSER = page('traex-0.213.1-composer-after-hooks-esc.txt');
const CODEX_L2 = page('codex-0.164.0-sessionstart-detail-l2.txt');
const CODEX_STARTUP = page('codex-0.164.0-sessionstart-startup-menu.txt');
const CODEX_COMPOSER = page('codex-0.164.0-startup-menu-after-esc.txt');
/** What a frame looks like while codex repaints its startup menu (rows cleared
 *  and redrawn): the heading is there, the options are not yet. */
const GROK_LOGIN = readFileSync(join(process.cwd(), 'test/fixtures/startup-blockers/grok-1.0.70-login.txt'), 'utf-8');
const CODEX_STARTUP_MID_REDRAW = CODEX_STARTUP.split('\n').slice(0, 4).join('\n');
/** The outbound tail of a recognised page: bounded and redacted. */
const pageTail = (screen: string) => redactStuckPageTail(stuckScreenTail(screen));

const WORKER_FUNCTIONS = [
  'adapterRendersCodexFamilyStuckPages',
  'refreshHookReviewInputHold',
  'heldInputTurnIdentity',
  'heldStuckPage',
  'notifyHookReviewInputHold',
  'reevaluateHoldAfterStuckKey',
  'hookReviewHoldBlocks',
  'hookReviewAdmissionScreen',
  'hookReviewAdmissionCapture',
  'hookReviewAdmissionShowsPage',
  'hookReviewHoldsQueuedWrite',
  'scheduleHookReviewReleaseProbe',
  'cancelHookReviewReleaseProbe',
  'afterStuckKeyObserved',
  'afterStuckKeyExpired',
  'screenShowsCredentialPage',
  'shareableStuckScreenTail',
  'holdFirstPromptForStuckPage',
  'submitUnconfirmedNotice',
  'stuckDetectorWarning',
] as const;

interface Harness {
  scope: Record<string, any>;
  sent: any[];
  flushes: () => number;
  /** Held items a gated flush actually wrote (see `gateFlush`). */
  delivered: () => number;
  /** Fire the pending timers (one round: timers they schedule wait for the next). */
  runTimers: () => number;
  /** Delays of the timers still pending. */
  pendingDelays: () => Array<number | undefined>;
  logs: string[];
  /** StuckDetector.arm() calls. */
  arms: () => number;
  fn: (name: (typeof WORKER_FUNCTIONS)[number]) => (...args: any[]) => any;
}

function harness(cliId: CliId, opts: {
  screen?: string;
  authoritative?: boolean;
  backendType?: string;
  pending?: Array<{ turnId?: string; dispatchAttempt?: number }>;
  /** flushPending runs the real hook-review admission check before it
   *  "writes" the head item (instead of only counting calls). */
  gateFlush?: boolean;
} = {}): Harness {
  const sent: any[] = [];
  const logs: string[] = [];
  let flushCount = 0;
  let deliveredCount = 0;
  let armCount = 0;
  let timers: Array<{ cb: () => void; cleared: boolean; ms: number | undefined }> = [];
  const scope: Record<string, any> = {
    cliAdapter: createCliAdapterSync(cliId),
    lastInitConfig: { cliId, backendType: 'tmux' },
    /** What the backend viewport shows right now (tests repaint it). */
    screen: opts.screen ?? '',
    backend: { captureViewport: () => scope.screen },
    effectiveBackendType: opts.backendType ?? 'tmux',
    backendScreenEvidenceIsAuthoritativeForMutation: () => opts.authoritative ?? true,
    isRemoteBackendType: () => false,
    captureBackendScreen: (be: any) => be.captureViewport(),
    lastAnalyzerSnapshot: '',
    renderer: { rawSnapshot: () => scope.screen },
    hookReviewInputHold: false,
    hookReviewInputHoldNotified: false,
    hookReviewInputHoldSnapshot: '',
    pendingMessages: [...(opts.pending ?? [])],
    pendingAdoptMessages: [],
    pendingRawInputs: [],
    hasPendingInputForFlush: () => scope.pendingMessages.length > 0,
    flushPending: async () => {
      flushCount += 1;
      if (!opts.gateFlush || !scope.hasPendingInputForFlush()) return;
      if (scope.hookReviewHoldsQueuedWrite()) return;
      scope.pendingMessages.shift();
      deliveredCount += 1;
    },
    hookReviewReleaseProbeTimer: null,
    hookReviewReleaseProbeSinceMs: null,
    HOOK_REVIEW_RELEASE_SETTLE_MS: 150,
    HOOK_REVIEW_RELEASE_SETTLE_CAP_MS: 2_000,
    HOOK_REVIEW_RELEASE_STALLED_PROBE_MS: 5_000,
    lastPtyActivityAtMs: 0,
    setTimeout: (cb: () => void, ms?: number) => {
      const timer = { cb, cleared: false, ms, unref: () => timer };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: { cleared: boolean } | null) => { if (timer) timer.cleared = true; },
    queueMicrotask: (cb: () => void) => cb(),
    currentBotmuxTurnId: 'turn_current',
    currentBotmuxDispatchAttempt: undefined,
    cliLifetimeNonce: 7,
    cliName: () => scope.cliAdapter.id === 'traex' ? 'TRAE CLI (traex)' : `CLI<${scope.cliAdapter.id}>`,
    send: (msg: any) => { sent.push(msg); },
    log: (line: string) => { logs.push(line); },
    classifyStuckPage,
    shouldHoldInputForHookReview,
    shouldHoldInputForStuckPage,
    stuckScreenTail,
    redactStuckPageTail,
    detectCliStartupBlocker,
    screenMayShowCredential,
    diagnoseSubmitFailure,
    stuckDetector: { arm: () => { armCount += 1; } },
  };
  for (const name of WORKER_FUNCTIONS) scope[name] = loadWorkerFunction(name, scope);
  const runTimers = () => {
    const due = timers.filter(timer => !timer.cleared);
    timers = [];
    for (const timer of due) timer.cb();
    return due.length;
  };
  const pendingDelays = () => timers.filter(timer => !timer.cleared).map(timer => timer.ms);
  return {
    scope, sent, logs, runTimers, pendingDelays,
    arms: () => armCount,
    flushes: () => flushCount,
    delivered: () => deliveredCount,
    fn: name => scope[name],
  };
}

describe('input hold scope follows the adapter declaration', () => {
  it.each(['codex', 'traex', 'coco'] as const)('%s holds on every recognised page, migration picker included', cliId => {
    for (const screen of [TRAEX_STARTUP, TRAEX_L1, CODEX_L2, TRAEX_MIGRATION, TRAEX_LOCK]) {
      const h = harness(cliId);
      h.fn('refreshHookReviewInputHold')(screen);
      expect(h.scope.hookReviewInputHold).toBe(true);
    }
  });

  it('a CLI without the declaration keeps the hook-review-only hold', () => {
    const h = harness('claude-code');
    h.fn('refreshHookReviewInputHold')(TRAEX_MIGRATION);
    expect(h.scope.hookReviewInputHold).toBe(false);
    h.fn('refreshHookReviewInputHold')(TRAEX_LOCK);
    expect(h.scope.hookReviewInputHold).toBe(false);
    h.fn('refreshHookReviewInputHold')(CODEX_L2);
    expect(h.scope.hookReviewInputHold).toBe(true);
  });
});

describe('session lock input admission', () => {
  it('holds the pending turn without consuming it, then delivers once after stable recovery', async () => {
    const held = { turnId: 'turn_lock', dispatchAttempt: 2 };
    const worker = harness('traex', { screen: TRAEX_LOCK, pending: [held], gateFlush: true });
    await worker.scope.flushPending();
    await worker.scope.flushPending();
    expect(worker.delivered()).toBe(0);
    expect(worker.scope.pendingMessages).toEqual([held]);
    expect(worker.sent).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'session lock',
      turnId: 'turn_lock', dispatchAttempt: 2, screenTail: pageTail(TRAEX_LOCK),
    })]);
    worker.scope.screen = TRAEX_COMPOSER;
    worker.fn('refreshHookReviewInputHold')(TRAEX_COMPOSER);
    expect(worker.scope.hookReviewInputHold).toBe(true);
    worker.runTimers();
    await Promise.resolve();
    expect(worker.delivered()).toBe(1);
    expect(worker.scope.pendingMessages).toEqual([]);
    worker.runTimers();
    await Promise.resolve();
    expect(worker.delivered()).toBe(1);
  });
});

describe('a held message raises the stuck card', () => {
  it('for the held message turn, with the page and its redacted screen tail', () => {
    const h = harness('traex', { screen: TRAEX_STARTUP, pending: [{ turnId: 'turn_held', dispatchAttempt: 3 }] });
    h.fn('refreshHookReviewInputHold')(TRAEX_STARTUP);
    h.fn('notifyHookReviewInputHold')();
    h.fn('notifyHookReviewInputHold')();
    expect(h.sent).toEqual([{
      type: 'stuck_warning',
      reason: 'input_held',
      elapsedMs: 0,
      snapshot: TRAEX_STARTUP.slice(-3000),
      screenTail: pageTail(TRAEX_STARTUP),
      matchedPattern: 'hook review startup',
      turnId: 'turn_held',
      dispatchAttempt: 3,
      cliLifetime: 7,
    }]);
  });

  it('falls back to the current turn when no queued item carries one', () => {
    const h = harness('codex', { screen: CODEX_L2, pending: [{}] });
    h.fn('refreshHookReviewInputHold')(CODEX_L2);
    h.fn('notifyHookReviewInputHold')();
    expect(h.sent[0]).toMatchObject({ type: 'stuck_warning', matchedPattern: 'hook review level 2', turnId: 'turn_current' });
  });

  it('a non-authoritative screen (ZMX history) holds but sends a plain notice naming the actual CLI', () => {
    const h = harness('traex', { screen: TRAEX_STARTUP, authoritative: false, pending: [{ turnId: 't' }] });
    h.fn('refreshHookReviewInputHold')(TRAEX_STARTUP);
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.fn('notifyHookReviewInputHold')();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].type).toBe('user_notify');
    expect(h.sent[0].message).toContain('TRAE CLI (traex)');
  });

  it('a CLI without the declaration never gets a key card', () => {
    const h = harness('claude-code', { screen: CODEX_L2, pending: [{ turnId: 't' }] });
    h.fn('refreshHookReviewInputHold')(CODEX_L2);
    h.fn('notifyHookReviewInputHold')();
    expect(h.sent.map(m => m.type)).toEqual(['user_notify']);
  });
});

describe('after a stuck-card key lands', () => {
  it('raises a new card when the key led to another blocking page while input is still held', () => {
    const h = harness('traex', { screen: TRAEX_L1, pending: [{ turnId: 'turn_held' }] });
    h.fn('refreshHookReviewInputHold')(TRAEX_L1);
    h.fn('notifyHookReviewInputHold')();
    expect(h.sent.map(m => m.matchedPattern)).toEqual(['hook review level 1']);
    // Esc on traex L1 goes back to the startup menu. The rendered screen may
    // still lag on L1; the post-key backend capture decides the next card.
    h.fn('reevaluateHoldAfterStuckKey')(TRAEX_STARTUP_AFTER_ESC);
    expect(h.sent.map(m => m.matchedPattern)).toEqual(['hook review level 1', 'hook review startup']);
    expect(h.sent[1].turnId).toBe('turn_held');
    expect(h.flushes()).toBe(0);
  });

  it('releases the held input when the composer is back, without another card', () => {
    const h = harness('traex', { screen: TRAEX_STARTUP, pending: [{ turnId: 'turn_held' }] });
    h.fn('refreshHookReviewInputHold')(TRAEX_STARTUP);
    h.fn('notifyHookReviewInputHold')();
    h.fn('reevaluateHoldAfterStuckKey')(TRAEX_COMPOSER);
    // The post-key frame goes through the release probe (PTY quiet → release).
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.screen = TRAEX_COMPOSER;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.flushes()).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it('with no input waiting, a next blocking page re-arms the stall detector instead of raising an input card', () => {
    const h = harness('traex', { screen: TRAEX_L1 });
    h.fn('afterStuckKeyObserved')({ screen: TRAEX_STARTUP_AFTER_ESC, pageType: 'hook review startup' });
    expect(h.sent).toEqual([]);
    expect(h.arms()).toBe(1);
  });

  it('with held input, the next page gets the input card and the stall detector stays as it was', () => {
    const h = harness('traex', { screen: TRAEX_L1, pending: [{ turnId: 'turn_held' }] });
    h.fn('refreshHookReviewInputHold')(TRAEX_L1);
    h.fn('notifyHookReviewInputHold')();
    h.fn('afterStuckKeyObserved')({ screen: TRAEX_STARTUP_AFTER_ESC, pageType: 'hook review startup' });
    expect(h.sent.map(m => m.matchedPattern)).toEqual(['hook review level 1', 'hook review startup']);
    expect(h.arms()).toBe(0);
  });

  it('back on the composer: nothing is re-armed', () => {
    const h = harness('traex', { screen: TRAEX_COMPOSER });
    h.fn('afterStuckKeyObserved')({ screen: TRAEX_COMPOSER, pageType: undefined });
    expect(h.arms()).toBe(0);
    expect(h.sent).toEqual([]);
  });
});

describe('codex-family hold across transient frames', () => {
  it('non-printing escapes in a raw PTY chunk do not hide the page above them', () => {
    for (const chunk of ['\x1b]0;codex\x07', '\x1b]0;x\x1b\\', '\x1b[2 q', '\x1b(B\x1b[?25l', '\x1b=']) {
      expect(classifyStuckPage(`${CODEX_STARTUP}\n${chunk}`), JSON.stringify(chunk)).toBe('hook review startup');
      // Non-family CLIs still release on any frame without the page, so this
      // is what keeps their hook-review hold up across such a chunk.
      const h = harness('claude-code', { screen: CODEX_L2 });
      h.fn('refreshHookReviewInputHold')(CODEX_L2);
      h.fn('refreshHookReviewInputHold')(`${CODEX_L2}\n${chunk}`);
      expect(h.scope.hookReviewInputHold, JSON.stringify(chunk)).toBe(true);
    }
  });

  it('without a fresh capture, a page on either cached screen holds', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 't' }] });
    h.scope.backend = null;
    h.scope.lastAnalyzerSnapshot = CODEX_COMPOSER; // tick cache lagging behind
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
  });

  const cards = (h: Harness) => h.sent.filter(m => m.type === 'stuck_warning');

  it('frames without the page (redraw / PTY chunk) never release the hold nor raise another card', () => {
    expect(classifyStuckPage(CODEX_STARTUP)).toBe('hook review startup');
    expect(classifyStuckPage(CODEX_STARTUP_MID_REDRAW)).toBeUndefined();
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    // The screen-update tick's cache still shows the page as well.
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    // Codex repaints the menu: per-chunk frames alternate between the page and
    // a half-drawn page, and flushes re-check the hold in between.
    for (let i = 0; i < 16; i++) {
      h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
      expect(h.scope.hookReviewInputHold).toBe(true);
      h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
      expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    }
    // The bounded re-capture sees the page is still up: nothing changes.
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]).toMatchObject({ reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_held' });
    expect(h.logs.filter(l => l.includes('releasing queued input'))).toEqual([]);
    expect(h.delivered()).toBe(0);
  });

  it('once the page is really gone the held message is written exactly once, even with a stale cached screen', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.fn('hookReviewHoldsQueuedWrite')();
    // Esc lands: codex shows the composer; the tick cache still has the menu.
    h.scope.screen = CODEX_COMPOSER;
    h.scope.lastPtyActivityAtMs = Date.now();
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    expect(h.scope.hookReviewInputHold).toBe(true);
    // Still repainting: the probe waits for the PTY to settle.
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.lastPtyActivityAtMs = 0;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.delivered()).toBe(1);
    // A second trigger (post-key re-evaluation, a later flush) delivers nothing more.
    h.fn('reevaluateHoldAfterStuckKey')(CODEX_COMPOSER);
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(false);
    h.runTimers();
    expect(h.delivered()).toBe(1);
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(cards(h)).toHaveLength(1);
  });

  it('the ordinary composer path decides on cached screens without a fresh capture per flush', () => {
    const h = harness('codex', { screen: CODEX_COMPOSER, pending: [{ turnId: 't' }], gateFlush: true });
    let captures = 0;
    h.scope.captureBackendScreen = (be: any) => { captures += 1; return be.captureViewport(); };
    h.scope.lastAnalyzerSnapshot = CODEX_COMPOSER;
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(false);
    expect(captures).toBe(0);
    // A cached screen that shows a page (maybe stale) is confirmed on a fresh capture.
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(false);
    expect(captures).toBe(1);
    expect(cards(h)).toHaveLength(0);
  });

  it('a new blocking page after a confirmed release raises a new card', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'a' }, { turnId: 'b' }] });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.fn('hookReviewHoldsQueuedWrite')();
    h.scope.screen = CODEX_COMPOSER;
    h.fn('refreshHookReviewInputHold')(CODEX_COMPOSER);
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    h.scope.screen = CODEX_L2;
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    expect(cards(h).map(m => m.matchedPattern)).toEqual(['hook review startup', 'hook review level 2']);
  });

  it('a CLI without the declaration still releases on the next frame without the page', () => {
    const h = harness('claude-code', { screen: CODEX_L2, pending: [{ turnId: 't' }] });
    h.fn('refreshHookReviewInputHold')(CODEX_L2);
    h.fn('refreshHookReviewInputHold')(CODEX_COMPOSER);
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.flushes()).toBe(1);
    expect(h.runTimers()).toBe(0);
  });
});

describe('first-prompt timeout on a recognised page', () => {
  it('cannot force a pending prompt into a session lock', () => {
    const worker = harness('traex', { screen: TRAEX_LOCK, pending: [{ turnId: 'turn_first' }] });
    expect(worker.fn('holdFirstPromptForStuckPage')('First prompt timeout')).toBe(true);
    expect(worker.scope.pendingMessages).toEqual([{ turnId: 'turn_first' }]);
    expect(worker.sent[0]).toMatchObject({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'session lock', turnId: 'turn_first',
    });
  });

  it('keeps the queued prompt held and raises the card instead of letting the timeout write', () => {
    const h = harness('traex', { screen: TRAEX_MIGRATION, pending: [{ turnId: 'turn_first' }] });
    expect(h.fn('holdFirstPromptForStuckPage')('First prompt timeout')).toBe(true);
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.sent).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'cli migration menu', turnId: 'turn_first',
    })]);
    // The bounded re-check calls it again: still held, no second card.
    expect(h.fn('holdFirstPromptForStuckPage')('First prompt timeout')).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it('does not veto the timeout on the composer, on a non-authoritative screen, or for other CLIs', () => {
    expect(harness('traex', { screen: TRAEX_COMPOSER }).fn('holdFirstPromptForStuckPage')('x')).toBe(false);
    expect(harness('traex', { screen: TRAEX_STARTUP, authoritative: false }).fn('holdFirstPromptForStuckPage')('x')).toBe(false);
    expect(harness('claude-code', { screen: CODEX_L2 }).fn('holdFirstPromptForStuckPage')('x')).toBe(false);
  });
});

describe('submit_unconfirmed notice (non-durable turns)', () => {
  const notice = (h: Harness, screen: string, diagnosisReason: string) => h.fn('submitUnconfirmedNotice')({
    screen, diagnosisReason, turnId: 'turn_unconfirmed', message: 'localized notice',
  });

  it('becomes the stuck card for a recognised page, carrying the notice text', () => {
    expect(notice(harness('traex'), TRAEX_L1, 'interactive_menu')).toEqual({
      type: 'stuck_warning',
      reason: 'submit_unconfirmed',
      elapsedMs: 0,
      snapshot: TRAEX_L1.slice(-3000),
      screenTail: pageTail(TRAEX_L1),
      noticeText: 'localized notice',
      matchedPattern: 'hook review level 1',
      turnId: 'turn_unconfirmed',
      dispatchAttempt: undefined,
      cliLifetime: 7,
    });
  });

  it('stays the plain input_not_submitted notice, without a screen tail, for an unrecognised screen', () => {
    expect(notice(harness('traex'), TRAEX_COMPOSER, 'unknown')).toEqual({
      type: 'user_notify',
      kind: 'input_not_submitted',
      turnId: 'turn_unconfirmed',
      message: 'localized notice',
    });
  });

  it('a claude-code screen showing `cat .env` output stays the plain notice and repeats none of it', () => {
    const screen = [
      '> cat .env',
      '',
      '⏺ Bash(cat .env)',
      '  ⎿  DATABASE_URL=postgres://app:Zq9-kiro-db-pass@db.internal:5432/app',
      '     STRIPE_KEY=rk_live_kiroFAKE0000000000',
      '     SESSION_COOKIE=kiro-cookie-0123456789abcdef',
      '',
      '╭──────────────────────────────────────────────╮',
      '│ >                                            │',
      '╰──────────────────────────────────────────────╯',
      '  ? for shortcuts',
    ].join('\n');
    const msg = notice(harness('claude-code'), screen, 'unknown');
    expect(msg).toEqual({
      type: 'user_notify',
      kind: 'input_not_submitted',
      turnId: 'turn_unconfirmed',
      message: 'localized notice',
    });
    // The same screen on a codex-family CLI is not a recognised page either.
    expect(notice(harness('codex'), screen, 'unknown')).toEqual(msg);
    expect(JSON.stringify(msg)).not.toMatch(/Zq9-kiro-db-pass|rk_live|kiro-cookie/);
  });

  it('never forwards a login screen the diagnosis did not flag (device code on screen)', () => {
    expect(GROK_LOGIN).toContain('ABCD-1234');
    const msg = notice(harness('traex'), GROK_LOGIN, 'unknown');
    expect(msg.type).toBe('user_notify');
    expect(msg).not.toHaveProperty('screenTail');
    expect(JSON.stringify(msg)).not.toContain('ABCD-1234');
  });

  it('never forwards a login screen', () => {
    const msg = notice(harness('traex'), page('traex-0.213.1-sign-in.txt'), 'logged_out');
    expect(msg.type).toBe('user_notify');
    expect(msg).not.toHaveProperty('screenTail');
  });

  it('never forwards a non-authoritative screen, nor turns it into a key card', () => {
    for (const h of [harness('traex', { backendType: 'zmx' }), harness('traex', { authoritative: false })]) {
      const msg = notice(h, TRAEX_L1, 'interactive_menu');
      expect(msg.type).toBe('user_notify');
      expect(msg).not.toHaveProperty('screenTail');
    }
  });

  it('a CLI without the declaration gets neither the screen tail nor a key card, even on a recognised page', () => {
    const msg = notice(harness('claude-code'), CODEX_L2, 'interactive_menu');
    expect(msg).toEqual({
      type: 'user_notify',
      kind: 'input_not_submitted',
      turnId: 'turn_unconfirmed',
      message: 'localized notice',
    });
  });
});

it('the harness runs the shipped adapters (sanity: the declaration is what flips the scope)', () => {
  const declared = (['codex', 'traex', 'coco', 'claude-code'] as const)
    .filter(id => harness(id).fn('adapterRendersCodexFamilyStuckPages')());
  expect(declared).toEqual(['codex', 'traex', 'coco']);
});

describe('tui_keys IPC from a stuck card (real handler)', () => {
  function keyHarness(screens: string[]) {
    const h = harness('traex', { screen: screens[0], pending: [{ turnId: 'turn_held' }] });
    const written: string[][] = [];
    let captures = 0;
    let arms = 0;
    const settles: number[] = [];
    Object.assign(h.scope, {
      processStuckWarningTuiKeys,
      shouldRearmStuckDetector,
      isAllowedStuckKeySequence,
      snapshotToText: async () => ({ content: screens[Math.min(captures++, screens.length - 1)] }),
      handleTuiKeys: async (keys: string[]) => { written.push(keys); return true; },
      delay: async (ms: number) => { settles.push(ms); },
      scaleMs: (ms: number) => ms,
      STUCK_KEY_AFTER_WRITE_SETTLE_MS: 800,
      renderCols: 200,
      renderRows: 50,
      stuckDetector: null,
      t: (key: string) => key,
    });
    h.scope.stuckDetector = { arm: () => { arms += 1; } };
    const handle = loadWorkerMessageHandler('tui_keys', h.scope);
    const click = (pageType: string, keys: string[]) => handle({
      type: 'tui_keys', keys, isFinal: true, stuckNonce: 4, stuckCliLifetime: 7, stuckPageType: pageType,
    });
    return { ...h, written, settles, click, keyArms: () => arms };
  }

  it('Esc on traex L1: writes the key, reports the next page, and raises its card for the held input', async () => {
    const k = keyHarness([TRAEX_L1, TRAEX_STARTUP_AFTER_ESC]);
    k.fn('refreshHookReviewInputHold')(TRAEX_L1);
    k.fn('notifyHookReviewInputHold')();
    await k.click('hook review level 1', ['Escape']);
    expect(k.written).toEqual([['Escape']]);
    expect(k.settles).toEqual([800]);
    expect(k.sent.slice(1)).toEqual([
      {
        type: 'tui_keys_delivered', nonce: 4, turnId: 'turn_current', dispatchAttempt: undefined,
        key: 'Escape', afterObserved: true, afterPageType: 'hook review startup',
        afterScreenTail: pageTail(TRAEX_STARTUP_AFTER_ESC),
      },
      expect.objectContaining({ type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_held' }),
    ]);
  });

  it('a click that expired because the page moved on raises the card for the page on screen now', async () => {
    // The owner pressed Esc on L1 in the web terminal: the card still says L1.
    const k = keyHarness([TRAEX_STARTUP_AFTER_ESC]);
    k.fn('refreshHookReviewInputHold')(TRAEX_L1);
    k.fn('notifyHookReviewInputHold')();
    await k.click('hook review level 1', ['Escape']);
    expect(k.written).toEqual([]);
    expect(k.sent.slice(1)).toEqual([
      { type: 'stuck_warning_expired', nonce: 4, turnId: 'turn_current', dispatchAttempt: undefined },
      expect.objectContaining({ type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_held' }),
    ]);
  });

  it('an expired click on a new page with no input waiting re-arms the stall detector', async () => {
    const k = keyHarness([TRAEX_STARTUP_AFTER_ESC]);
    k.scope.pendingMessages = [];
    await k.click('hook review level 1', ['Escape']);
    expect(k.sent).toEqual([{ type: 'stuck_warning_expired', nonce: 4, turnId: 'turn_current', dispatchAttempt: undefined }]);
    expect(k.keyArms()).toBe(1);
  });

  it('an expired click with the composer back does not release on that single capture', async () => {
    const k = keyHarness([TRAEX_COMPOSER]);
    k.fn('refreshHookReviewInputHold')(TRAEX_L1);
    k.fn('notifyHookReviewInputHold')();
    await k.click('hook review level 1', ['Escape']);
    expect(k.scope.hookReviewInputHold).toBe(true);
    k.scope.screen = TRAEX_COMPOSER;
    k.runTimers();
    expect(k.scope.hookReviewInputHold).toBe(false);
    expect(k.flushes()).toBe(1);
    expect(k.sent.filter(m => m.type === 'stuck_warning')).toHaveLength(1);
  });

  it('a key that lands on a login page reports no screen tail', async () => {
    const k = keyHarness([TRAEX_MIGRATION, GROK_LOGIN]);
    await k.click('cli migration menu', ['Escape']);
    expect(k.sent[0]).toMatchObject({ type: 'tui_keys_delivered', key: 'Escape', afterObserved: true });
    expect(k.sent[0]).not.toHaveProperty('afterScreenTail');
    expect(JSON.stringify(k.sent)).not.toContain('ABCD-1234');
  });

  it.each([
    'credential-claude-2.1.318-oauth-paste-code.txt',
    'credential-codex-0.164.0-browser-login.txt',
    'credential-codex-0.164.0-device-code.txt',
    'credential-codex-0.164.0-api-key-entry.txt',
  ])('a key that lands on %s reports no screen tail', async name => {
    const after = page(name);
    const k = keyHarness([TRAEX_MIGRATION, after]);
    await k.click('cli migration menu', ['Escape']);
    expect(k.sent[0]).toMatchObject({ type: 'tui_keys_delivered', key: 'Escape', afterObserved: true });
    expect(k.sent[0]).not.toHaveProperty('afterScreenTail');
    expect(JSON.stringify(k.sent)).not.toMatch(/FAKE/);
  });

  it('a key the catalog does not list for the page is never written', async () => {
    const k = keyHarness([TRAEX_STARTUP]);
    await k.click('hook review startup', ['Enter']);
    expect(k.written).toEqual([]);
    expect(k.sent).toEqual([{ type: 'stuck_warning_expired', nonce: 4, turnId: 'turn_current', dispatchAttempt: undefined }]);
  });

  it('R while another process still owns the session keeps input held and reports the lock', async () => {
    const worker = keyHarness([TRAEX_LOCK, TRAEX_LOCK]);
    worker.fn('refreshHookReviewInputHold')(TRAEX_LOCK);
    worker.fn('notifyHookReviewInputHold')();
    await worker.click('session lock', ['r']);
    expect(worker.written).toEqual([['r']]);
    expect(worker.scope.hookReviewInputHold).toBe(true);
    expect(worker.scope.pendingMessages).toEqual([{ turnId: 'turn_held' }]);
    expect(worker.sent).toContainEqual(expect.objectContaining({
      type: 'tui_keys_delivered', key: 'r', afterObserved: true, afterPageType: 'session lock',
    }));
    expect(worker.flushes()).toBe(0);
  });

  it('R after the owner exits observes recovery and releases only after a stable capture', async () => {
    const worker = keyHarness([TRAEX_LOCK, TRAEX_COMPOSER]);
    worker.fn('refreshHookReviewInputHold')(TRAEX_LOCK);
    await worker.click('session lock', ['r']);
    expect(worker.written).toEqual([['r']]);
    expect(worker.scope.hookReviewInputHold).toBe(true);
    worker.scope.screen = TRAEX_COMPOSER;
    worker.runTimers();
    expect(worker.scope.hookReviewInputHold).toBe(false);
    expect(worker.flushes()).toBe(1);
  });

  it('an old retry click cannot type r into an already recovered composer', async () => {
    const worker = keyHarness([TRAEX_COMPOSER]);
    await worker.click('session lock', ['r']);
    expect(worker.written).toEqual([]);
    expect(worker.sent[0]).toMatchObject({ type: 'stuck_warning_expired', nonce: 4 });
  });

  it.each([['Enter'], ['Escape'], ['q'], ['C-c'], ['r', 'Enter']].map(keys => ({ keys })))('rejects unlisted lock-page keys $keys', async ({ keys }) => {
    const worker = keyHarness([TRAEX_LOCK]);
    await worker.click('session lock', keys);
    expect(worker.written).toEqual([]);
    expect(worker.sent[0]).toMatchObject({ type: 'stuck_warning_expired' });
  });

  it('re-matches with the full classifier (startup menu and migration picker cards are clickable)', async () => {
    const k = keyHarness([TRAEX_MIGRATION, TRAEX_COMPOSER]);
    await k.click('cli migration menu', ['Escape']);
    expect(k.written).toEqual([['Escape']]);
    expect(k.sent[0]).toMatchObject({ type: 'tui_keys_delivered', key: 'Escape', afterObserved: true });
    expect(k.sent[0].afterPageType).toBeUndefined();
  });
});

/** Sign-in / API-key screens laid out from the shipped binaries' strings
 *  (fake links, codes and keys). */
const CREDENTIAL_SCREENS = {
  'claude oauth': page('credential-claude-2.1.318-oauth-paste-code.txt'),
  'codex browser login': page('credential-codex-0.164.0-browser-login.txt'),
  'codex browser url fallback': page('credential-codex-0.164.0-browser-url-fallback.txt'),
  'codex api key entry': page('credential-codex-0.164.0-api-key-entry.txt'),
  'codex device code': page('credential-codex-0.164.0-device-code.txt'),
};
/** A hook detail page whose hook command quotes a key: still the page (key
 *  card), but its text must not leave the terminal. */
const CODEX_L2_WITH_KEY = CODEX_L2.replace('echo kiro-sessionstart', 'OPENAI_API_KEY=sk-FAKEfake00000000 ./notify.sh');

describe('credential screens: no outbound screen tail', () => {
  it.each(Object.entries(CREDENTIAL_SCREENS))('submit_unconfirmed notice on the %s screen carries no screen tail', (_label, screen) => {
    const msg = harness('codex').fn('submitUnconfirmedNotice')({
      screen, diagnosisReason: 'unknown', turnId: 't', message: 'localized notice',
    });
    expect(msg).toEqual({ type: 'user_notify', kind: 'input_not_submitted', turnId: 't', message: 'localized notice' });
  });

  it('a recognised page quoting a key keeps its key card, without the screen tail', () => {
    expect(classifyStuckPage(CODEX_L2_WITH_KEY)).toBe('hook review level 2');
    const msg = harness('codex').fn('submitUnconfirmedNotice')({
      screen: CODEX_L2_WITH_KEY, diagnosisReason: 'interactive_menu', turnId: 't', message: 'n',
    });
    expect(msg).toMatchObject({ type: 'stuck_warning', reason: 'submit_unconfirmed', matchedPattern: 'hook review level 2', screenTail: '' });
  });

  it('the input_held card for such a page carries no screen tail', () => {
    const h = harness('codex', { screen: CODEX_L2_WITH_KEY, pending: [{ turnId: 'turn_held' }] });
    h.fn('refreshHookReviewInputHold')(CODEX_L2_WITH_KEY);
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    expect(h.sent).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review level 2', turnId: 'turn_held', screenTail: '',
    })]);
    // The ordinary page still sends its tail, its free-form rows masked.
    const plain = harness('codex', { screen: CODEX_L2, pending: [{ turnId: 'turn_held' }] });
    plain.fn('refreshHookReviewInputHold')(CODEX_L2);
    plain.fn('hookReviewHoldsQueuedWrite')();
    expect(plain.sent[0].screenTail).toBe(pageTail(CODEX_L2));
    expect(plain.sent[0].screenTail).toContain('Trust     New hook - review required');
    expect(plain.sent[0].screenTail).not.toContain('echo kiro-sessionstart');
  });

  it.each(Object.entries(CREDENTIAL_SCREENS))('the StuckDetector card on the %s screen carries no screen tail', (_label, screen) => {
    const h = harness('codex');
    h.scope.lastAnalyzerSnapshot = screen;
    const msg = h.fn('stuckDetectorWarning')(45_000, undefined);
    expect(msg).toMatchObject({ type: 'stuck_warning', elapsedMs: 45_000, screenTail: '', turnId: 'turn_current', cliLifetime: 7 });
  });

  it('the StuckDetector card carries the redacted tail only for a recognised page, never for any other screen', () => {
    const h = harness('codex');
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    expect(h.fn('stuckDetectorWarning')(45_000, 'hook review startup').screenTail).toBe(pageTail(CODEX_STARTUP));
    h.scope.lastAnalyzerSnapshot = CODEX_COMPOSER;
    expect(h.fn('stuckDetectorWarning')(45_000, undefined).screenTail).toBe('');
    const other = harness('claude-code');
    other.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    expect(other.fn('stuckDetectorWarning')(45_000, undefined).screenTail).toBe('');
  });

  it('a recognised page the submit diagnosis reads as a login gate carries no tail either', () => {
    const screen = TRAEX_STARTUP.replace(/\n\n/, '\n\n  Not logged in · run /login\n');
    expect(classifyStuckPage(screen)).toBe('hook review startup');
    expect(diagnoseSubmitFailure({ screenText: screen }).reason).toBe('logged_out');
    expect(screenMayShowCredential(screen)).toBe(false);
    const h = harness('traex');
    expect(h.fn('shareableStuckScreenTail')(screen)).toBe('');
    expect(h.fn('shareableStuckScreenTail')(TRAEX_STARTUP)).toBe(pageTail(TRAEX_STARTUP));
  });
});

describe('release probe edge cases', () => {
  afterEach(() => { vi.useRealTimers(); });
  const cards = (h: Harness) => h.sent.filter(m => m.type === 'stuck_warning');

  it('a hold that only awaits its release probe raises no card for a message that arrives meanwhile', async () => {
    // Hold set with nothing queued (no card). The owner clears the page in the
    // terminal; the PTY is still busy repainting when a message arrives.
    const h = harness('codex', { screen: CODEX_STARTUP, gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.screen = CODEX_COMPOSER;
    h.scope.lastPtyActivityAtMs = Date.now();
    h.scope.pendingMessages.push({ turnId: 'turn_new' });
    await h.scope.flushPending();
    expect(h.sent).toEqual([]);
    expect(h.delivered()).toBe(0);
    expect(h.scope.hookReviewInputHold).toBe(true);
    // The probe releases once the PTY is quiet and the message goes out once.
    h.scope.lastPtyActivityAtMs = 0;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.delivered()).toBe(1);
    h.runTimers();
    expect(h.delivered()).toBe(1);
    expect(h.sent).toEqual([]);
  });

  it('a message held on a mid-redraw admission frame gets its card once the probe confirms the page', async () => {
    // Hold set with nothing queued (no card yet). The page is mid-redraw when
    // a message arrives: held, but no card from that frame.
    const h = harness('codex', { screen: CODEX_STARTUP, gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.screen = CODEX_STARTUP_MID_REDRAW;
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP_MID_REDRAW;
    h.scope.pendingMessages.push({ turnId: 'turn_new' });
    await h.scope.flushPending();
    expect(h.delivered()).toBe(0);
    expect(h.sent).toEqual([]);
    // The repaint finishes; the probe sees the page and raises the card.
    h.scope.screen = CODEX_STARTUP;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.sent).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_new',
      screenTail: pageTail(CODEX_STARTUP),
    })]);
    // Exactly one: further frames and probes on the same page add none.
    await h.scope.flushPending();
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    h.runTimers();
    h.runTimers();
    expect(h.sent).toHaveLength(1);
    expect(h.delivered()).toBe(0);
  });

  it('a probe that confirms the page with nothing queued raises no card', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('a capture that throws keeps the probe going (no stale cached page stops it) and releases once it recovers', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    expect(cards(h)).toHaveLength(1);
    // Esc lands; the caches still show the menu and the backend capture fails.
    h.scope.screen = CODEX_COMPOSER;
    h.scope.lastAnalyzerSnapshot = CODEX_STARTUP;
    h.scope.renderer = { rawSnapshot: () => CODEX_STARTUP };
    const capture = h.scope.captureBackendScreen;
    h.scope.captureBackendScreen = () => { throw new Error('capture-pane failed'); };
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    for (let i = 0; i < 3; i++) {
      h.runTimers();
      expect(h.scope.hookReviewInputHold).toBe(true);
      expect(h.pendingDelays()).toEqual([150]);
    }
    h.scope.captureBackendScreen = capture;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.delivered()).toBe(1);
    h.runTimers();
    expect(h.delivered()).toBe(1);
    expect(cards(h)).toHaveLength(1);
  });

  it('a capture that stays blank never releases on the cached composer, keeps probing slower past the cap, and raises no cards', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.scope.captureBackendScreen = () => '';
    h.scope.renderer = { rawSnapshot: () => CODEX_COMPOSER };
    h.scope.lastAnalyzerSnapshot = CODEX_COMPOSER;
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    const delays: Array<number | undefined> = [];
    for (let elapsed = 0; elapsed < 12_000;) {
      const [delay] = h.pendingDelays();
      expect(delay).toBeDefined();
      delays.push(delay);
      elapsed += delay!;
      vi.setSystemTime(1_000_000 + elapsed);
      h.runTimers();
      expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
      expect(h.scope.hookReviewInputHold).toBe(true);
    }
    expect(delays.slice(0, 5)).toEqual([150, 150, 150, 150, 150]);
    expect(delays.at(-1)).toBe(5_000);
    expect(h.pendingDelays()).toHaveLength(1);
    expect(h.delivered()).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it('a PTY that never goes quiet still releases at the cap, exactly once', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(2_000_000);
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.scope.screen = CODEX_COMPOSER;
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    let elapsed = 0;
    while (h.scope.hookReviewInputHold && elapsed < 10_000) {
      elapsed += 150;
      vi.setSystemTime(2_000_000 + elapsed);
      h.scope.lastPtyActivityAtMs = Date.now();
      h.runTimers();
    }
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(2_500);
    expect(h.delivered()).toBe(1);
    expect(h.logs.filter(l => l.includes('releasing queued input'))).toHaveLength(1);
    h.runTimers();
    expect(h.delivered()).toBe(1);
  });

  it.each([
    ['backend replaced', (h: Harness) => { h.scope.backend = { captureViewport: () => CODEX_COMPOSER }; }],
    ['CLI lifetime changed', (h: Harness) => { h.scope.cliLifetimeNonce = 8; }],
  ] as const)('a probe scheduled before the %s does nothing', (_label, change) => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.scope.screen = CODEX_COMPOSER;
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP_MID_REDRAW);
    change(h);
    expect(h.runTimers()).toBe(1);
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.delivered()).toBe(0);
    expect(h.pendingDelays()).toEqual([]);
  });

  it('while held, a fresh capture showing the page outweighs cached screens showing the composer', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.scope.renderer = { rawSnapshot: () => CODEX_COMPOSER };
    h.scope.lastAnalyzerSnapshot = CODEX_COMPOSER;
    expect(h.fn('hookReviewHoldsQueuedWrite')()).toBe(true);
    h.runTimers();
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.delivered()).toBe(0);
    expect(cards(h)).toHaveLength(1);
  });
});

describe('post-key capture without a page goes through the release probe', () => {
  it('a mid-redraw frame after the key neither releases nor raises a notice; the probe decides', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.fn('notifyHookReviewInputHold')();
    h.fn('reevaluateHoldAfterStuckKey')(CODEX_STARTUP_MID_REDRAW);
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.delivered()).toBe(0);
    expect(h.sent).toHaveLength(1);
    // The menu finishes repainting: still on it. The key re-armed the card,
    // so the held input gets one card for the page the probe confirmed.
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    expect(h.delivered()).toBe(0);
    expect(h.sent.slice(1)).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_held',
    })]);
    h.runTimers();
    expect(h.sent).toHaveLength(2);
  });

  it('when the key really left the page, the probe releases once the PTY is quiet', () => {
    const h = harness('codex', { screen: CODEX_STARTUP, pending: [{ turnId: 'turn_held' }], gateFlush: true });
    h.fn('refreshHookReviewInputHold')(CODEX_STARTUP);
    h.fn('notifyHookReviewInputHold')();
    h.scope.screen = CODEX_COMPOSER;
    h.scope.lastPtyActivityAtMs = Date.now();
    h.fn('reevaluateHoldAfterStuckKey')(CODEX_STARTUP_MID_REDRAW);
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(true);
    h.scope.lastPtyActivityAtMs = 0;
    h.runTimers();
    expect(h.scope.hookReviewInputHold).toBe(false);
    expect(h.delivered()).toBe(1);
    expect(h.sent).toHaveLength(1);
  });
});

describe('raw_input passthrough decides on the admission screen (real handler)', () => {
  function rawHarness(opts: { fresh: string; cached: string; held: boolean }) {
    const h = harness('codex', { screen: opts.fresh });
    if (opts.held) h.scope.hookReviewInputHold = true;
    h.scope.hookReviewInputHoldSnapshot = opts.held ? CODEX_STARTUP : '';
    h.scope.lastAnalyzerSnapshot = opts.cached;
    h.scope.renderer = { rawSnapshot: () => opts.cached };
    const delivered: any[] = [];
    Object.assign(h.scope, {
      unattendedRawInputRefusal: () => undefined,
      discardDeploymentContinuation: () => {},
      firstWriteLivenessConfirmed: true,
      startupCommandAckHold: null,
      pendingInjections: [],
      shouldDeferUserFlush: () => false,
      sessionRenameInFlight: () => false,
      shouldHoldCodexRunnerInput: () => false,
      nativeSessionForkPending: () => false,
      codexModelMigrationHoldsRawInput: () => false,
      freshnessInputQueue: { enqueueRaw: (m: any) => { h.scope.pendingRawInputs.push(m); } },
      deliverRawInput: async (m: any) => { delivered.push(m); },
    });
    const handle = loadWorkerMessageHandler('raw_input', h.scope);
    return { ...h, delivered, send: () => handle({ type: 'raw_input', content: '/btw hi', turnId: 'turn_raw' }) };
  }

  it('held, cached screens on the composer, fresh capture on the page: parks the input and raises its card', async () => {
    const r = rawHarness({ fresh: CODEX_STARTUP, cached: CODEX_COMPOSER, held: true });
    await r.send();
    expect(r.delivered).toEqual([]);
    expect(r.scope.pendingRawInputs).toHaveLength(1);
    expect(r.sent).toEqual([expect.objectContaining({
      type: 'stuck_warning', reason: 'input_held', matchedPattern: 'hook review startup', turnId: 'turn_raw',
    })]);
  });

  it('a hold that only awaits its release probe parks the passthrough without a card', async () => {
    const r = rawHarness({ fresh: CODEX_COMPOSER, cached: CODEX_COMPOSER, held: true });
    r.scope.lastPtyActivityAtMs = Date.now();
    await r.send();
    expect(r.delivered).toEqual([]);
    expect(r.scope.pendingRawInputs).toHaveLength(1);
    expect(r.sent).toEqual([]);
  });

  it('not held, a stale cached page but the fresh capture on the composer: delivered directly', async () => {
    const r = rawHarness({ fresh: CODEX_COMPOSER, cached: CODEX_STARTUP, held: false });
    await r.send();
    expect(r.delivered).toHaveLength(1);
    expect(r.scope.pendingRawInputs).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});
