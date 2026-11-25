import { describe, expect, it, vi } from 'vitest';
import { parseAntigravityFooterBackgroundTasks } from '../src/adapters/cli/antigravity.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const IDLE_NO_TASKS = [
  '────────────────────────────────────────────────────────────────────────',
  '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
  '────────────────────────────────────────────────────────────────────────',
  '? for shortcuts                                          auto · Gemini 4 Neon · high',
  '',
].join('\n');

const IDLE_ONE_TASK = [
  '────────────────────────────────────────────────────────────────────────',
  '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
  '────────────────────────────────────────────────────────────────────────',
  '● [19:44:14] 9m 45s timer running',
  '────────────────────────────────────────────────────────────────────────',
  '? for shortcuts   auto · Gemini 4 Neon · high · 1 task(s) · /tasks',
  '',
].join('\n');

const WORKING_TWO_TASKS = [
  '● Bash(sleep 30)',
  '⣻ Running command...',
  '────────',
  '>',
  '────────',
  '● command running',
  '────────',
  'esc to cancel · 2 task(s)',
].join('\n');

describe('parseAntigravityFooterBackgroundTasks', () => {
  it('parses running background task counts from real ready and busy footers', () => {
    expect(parseAntigravityFooterBackgroundTasks(IDLE_ONE_TASK)).toBe(1);
    expect(parseAntigravityFooterBackgroundTasks(WORKING_TWO_TASKS)).toBe(2);
    // ANSI + CRLF tmux capture
    const colored = IDLE_ONE_TASK.split('\n').map(l => `\x1b[38;2;99;102;241m${l}\x1b[0m`).join('\r\n');
    expect(parseAntigravityFooterBackgroundTasks(colored)).toBe(1);
  });

  it('handles narrow wrapped two-line footers', () => {
    const wrapped = [
      '────────',
      '? for shortcuts   auto · Gemini 4 Neon · high ·',
      '3 task(s) · /tasks',
    ].join('\n');
    expect(parseAntigravityFooterBackgroundTasks(wrapped)).toBe(3);
  });

  it('returns 0 when the real footer is visible without task(s) (task finished or cancelled)', () => {
    expect(parseAntigravityFooterBackgroundTasks(IDLE_NO_TASKS)).toBe(0);
    expect(parseAntigravityFooterBackgroundTasks('output\n────────\nesc to cancel\n')).toBe(0);
  });

  it('ignores quoted footer text in scrollback/body and reads only the viewport tail footer', () => {
    const bodyQuotingTasks = [
      'Here is an old footer quote:',
      '? for shortcuts   auto · 5 task(s) · /tasks',
      IDLE_NO_TASKS,
    ].join('\n');
    expect(parseAntigravityFooterBackgroundTasks(bodyQuotingTasks)).toBe(0);

    // Body line without a separator boundary must not be treated as a real footer.
    expect(parseAntigravityFooterBackgroundTasks('prose line\n? for shortcuts · 4 task(s)')).toBeUndefined();
    // Blank lines after prose or permission dialogs must not be treated as a footer boundary either.
    expect(parseAntigravityFooterBackgroundTasks('prose\n\n? for shortcuts · 4 task(s)')).toBeUndefined();
    expect(parseAntigravityFooterBackgroundTasks('Allow this command?\n\n? for shortcuts · 2 task(s)')).toBeUndefined();
    expect(parseAntigravityFooterBackgroundTasks('? for shortcuts · 2 task(s)')).toBeUndefined();
    // PTY rawSnapshot strips box-drawing bars into blanks, but keeps the native empty composer row above.
    const rawSnapshotIdle = [
      '',
      '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
      '',
      '? for shortcuts   auto · Gemini 4 Neon · high · 2 task(s) · /tasks',
    ].join('\n');
    expect(parseAntigravityFooterBackgroundTasks(rawSnapshotIdle)).toBe(2);
  });

  it('returns undefined when no real footer is present (capture failure, overlay, error composer)', () => {
    expect(parseAntigravityFooterBackgroundTasks('')).toBeUndefined();
    expect(parseAntigravityFooterBackgroundTasks('Allow this command?\n1. Yes\n2. No')).toBeUndefined();
    expect(parseAntigravityFooterBackgroundTasks('⚠ Request failed.\nError ID: abc\n────\n>\n────')).toBeUndefined();
  });
});

describe('worker Antigravity footer background wait integration', () => {
  function harness(authoritative = true) {
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'antigravity' },
      antigravityFooterBackgroundTasks: 0,
      backgroundWaitTasks: 0,
      backgroundStopScanSinceMs: 0,
      backgroundStopScanOffsets: new Map<string, number>(),
      backgroundTaskTracker: { backgroundWait: () => 0 },
      backendScreenEvidenceIsAuthoritativeForMutation: () => authoritative,
      parseAntigravityFooterBackgroundTasks,
      syncBackgroundTaskPinsToDaemon: vi.fn(),
      screenUpdateTimer: null,
      renderer: null,
      lastAnalyzerSnapshot: 'stale',
      nativeSessionForkPending: () => false,
      inputDeliveryObservedCliSessionId: 'conv-1',
      publishCliSessionIdToDaemon: () => true,
      sessionId: 'sid',
      currentBotmuxTurnId: 'om_1',
      currentBotmuxDispatchAttempt: undefined,
      send: vi.fn(),
      log: vi.fn(),
      ensureAntigravityCotReader: vi.fn(),
    };
    scope.observeAntigravityFooterBackgroundTasks = loadWorkerFunction('observeAntigravityFooterBackgroundTasks', scope);
    scope.refreshBackgroundWait = loadWorkerFunction('refreshBackgroundWait', scope);
    scope.backgroundWaitPayload = loadWorkerFunction('backgroundWaitPayload', scope);
    scope.stopScreenUpdates = loadWorkerFunction('stopScreenUpdates', scope);
    scope.persistCliSessionId = loadWorkerFunction('persistCliSessionId', scope);
    return scope;
  }

  it('publishes count from footer, preserves it across unreadable frames, and clears on completion', () => {
    const h = harness();
    h.observeAntigravityFooterBackgroundTasks(IDLE_ONE_TASK);
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({ backgroundTasks: 1 });

    // Unreadable/overlay screen returns undefined → must NOT overwrite with 0.
    h.observeAntigravityFooterBackgroundTasks('Allow this command?\n1. Yes');
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({ backgroundTasks: 1 });

    // Task finishes/cancels → real footer without task(s) clears count to 0.
    h.observeAntigravityFooterBackgroundTasks(IDLE_NO_TASKS);
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({});
  });

  it('ignores non-authoritative screens', () => {
    const h = harness(false);
    h.observeAntigravityFooterBackgroundTasks(IDLE_ONE_TASK);
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({});
  });

  it('resets footer background count on stopScreenUpdates and conversation switch', () => {
    const h = harness();
    h.observeAntigravityFooterBackgroundTasks(IDLE_ONE_TASK);
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({ backgroundTasks: 1 });

    h.persistCliSessionId('conv-2');
    expect(h.backgroundWaitPayload()).toEqual({});

    h.observeAntigravityFooterBackgroundTasks(WORKING_TWO_TASKS);
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({ backgroundTasks: 2 });

    h.stopScreenUpdates();
    h.refreshBackgroundWait();
    expect(h.backgroundWaitPayload()).toEqual({});
  });
});
