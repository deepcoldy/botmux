/**
 * The worker's `away_summary_focus` case: the daemon asks after a turn's last
 * card settled; only a Claude Code session botmux launched in a tmux or pty
 * pane passes the request on (services/away-summary-focus.ts decides when to
 * write the focus report).
 */
import { describe, expect, it, vi } from 'vitest';
import { AwaySummaryFocus, awaySummaryFocusRefusal, FOCUS_IN, FOCUS_OUT } from '../src/services/away-summary-focus.js';
import { shouldDeferAutoCompactForAwaySummary } from '../src/core/auto-compact.js';
import { ClaudeModelRequestClock } from '../src/services/claude-transcript.js';
import { promptSuggestionReportTurn } from '../src/utils/prompt-suggestion-publisher.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

function worker(lastInitConfig: Record<string, unknown>) {
  const scope: Record<string, any> = {
    lastInitConfig,
    awaySummaryFocusRefusal,
    awaySummaryFocus: { request: vi.fn() },
    log: vi.fn(),
    send: vi.fn(),
  };
  return { scope, handle: loadWorkerMessageHandler('away_summary_focus', scope) };
}

describe('worker away_summary_focus', () => {
  it('passes the turn on for Claude Code in a pane botmux launched', async () => {
    const { scope, handle } = worker({ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'tmux' });
    await handle({ type: 'away_summary_focus', turnId: 'om_turn1' });
    expect(scope.awaySummaryFocus.request).toHaveBeenCalledWith('om_turn1');
  });

  it.each([
    [{ cliId: 'relay', cliVersion: '3.28.0 (Relay)', backendType: 'tmux' }, 'not Claude Code'],
    [{ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'tmux', adoptMode: true }, 'adopted pane'],
    [{ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'zmx' }, 'zmx backend'],
    [{ cliId: 'claude-code', backendType: 'tmux' }, 'version "unknown"'],
  ])('writes nothing for %j', async (config, reason) => {
    const { scope, handle } = worker(config);
    await handle({ type: 'away_summary_focus', turnId: 'om_turn1' });
    expect(scope.awaySummaryFocus.request).not.toHaveBeenCalled();
    expect(scope.log.mock.calls.flat().join('\n')).toContain(reason);
  });
});

describe('worker away-summary cancellation and keepalive', () => {
  it('cancels a pending request and restores focus on the revocation IPC', async () => {
    const scope = { awaySummaryFocus: { restore: vi.fn() } };
    const handle = loadWorkerMessageHandler('away_summary_focus_cancel', scope);
    await handle({ type: 'away_summary_focus_cancel' });
    expect(scope.awaySummaryFocus.restore).toHaveBeenCalledWith('replyCardRecap off');
  });

  it('defers keepalive while a recap is waiting or blurred, without typing it', async () => {
    const scope: Record<string, any> = {
      awaySummaryFocus: { isActive: true },
      backend: {},
      cliAdapter: {},
      cliRestartInProgress: false,
      isPromptReady: true,
      tuiPromptBlocking: false,
      bareShellLaunchBlocked: false,
      isFlushing: false,
      injectionFlushing: false,
      pendingMessages: [],
      pendingRawInputs: [],
      pendingSessionRename: null,
      unattendedComposerScreen: vi.fn(() => undefined),
      promptCacheKeepaliveRefusal: vi.fn(() => undefined),
      setCaptureIdentity: vi.fn(),
      pendingInjections: [],
      send: vi.fn(),
      log: vi.fn(),
      flushPendingInjections: vi.fn(),
    };
    const handle = loadWorkerMessageHandler('prompt_cache_keepalive', scope);
    await handle({ type: 'prompt_cache_keepalive', text: 'keepalive' });
    expect(scope.send).toHaveBeenCalledWith({
      type: 'prompt_cache_keepalive_result', injected: false, reason: 'away_summary_pending',
    });
    expect(scope.pendingInjections).toEqual([]);
    expect(scope.flushPendingInjections).not.toHaveBeenCalled();
    expect(scope.setCaptureIdentity).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'blurred'] as const)('defers automatic compact without cancelling %s recap, then settles', (stage) => {
    const turnId = 'om_recap_turn';
    const writes: string[] = [];
    const focus = new AwaySummaryFocus({
      now: () => Date.UTC(2026, 10, 22, 1, 0, 0),
      setTimer: () => () => {},
      refusal: () => undefined,
      currentTurnId: () => turnId,
      watched: () => false,
      write: bytes => { writes.push(bytes); return true; },
      log: () => {},
    });
    focus.request(turnId);
    if (stage === 'blurred') focus.noteSuggestion(turnId);
    expect(focus.isActive).toBe(true);
    const scope: Record<string, any> = { awaySummaryFocus: focus, shouldDeferAutoCompactForAwaySummary };
    scope.deferAutoCompactForAwaySummary = loadWorkerFunction('deferAutoCompactForAwaySummary', scope);
    const restore = loadWorkerFunction<(msg: Record<string, unknown>) => void>('restoreFocusForDaemonMessage', scope);
    const refuse = loadWorkerFunction<(msg: Record<string, unknown>) => { refusal: string } | undefined>('unattendedRawInputRefusal', scope);
    const msg = { type: 'raw_input', turnId: 'auto-compact:idle:test', requireSafeComposer: true };
    restore(msg);
    expect(focus.isActive).toBe(true);
    expect(writes).toEqual(stage === 'blurred' ? [FOCUS_OUT] : []);
    expect(refuse(msg)?.refusal).toBe('away_summary_pending');
    expect(writes).toEqual(stage === 'blurred' ? [FOCUS_OUT] : []);

    focus.noteRecap({ turnId });
    expect(focus.isActive).toBe(false);
    expect(writes).toEqual(stage === 'blurred' ? [FOCUS_OUT, FOCUS_IN] : []);
    expect(scope.deferAutoCompactForAwaySummary(msg)).toBe(false);
  });

  it('restores focus immediately for a human raw input even while recap is active', () => {
    const turnId = 'om_recap_turn';
    const writes: string[] = [];
    const focus = new AwaySummaryFocus({
      now: () => Date.UTC(2026, 10, 22, 1, 0, 0), setTimer: () => () => {},
      refusal: () => undefined, currentTurnId: () => turnId, watched: () => false,
      write: bytes => { writes.push(bytes); return true; }, log: () => {},
    });
    focus.request(turnId);
    focus.noteSuggestion(turnId);
    const scope: Record<string, any> = { awaySummaryFocus: focus, shouldDeferAutoCompactForAwaySummary };
    scope.deferAutoCompactForAwaySummary = loadWorkerFunction('deferAutoCompactForAwaySummary', scope);
    loadWorkerFunction('restoreFocusForDaemonMessage', scope)({ type: 'raw_input', turnId: 'om_human', requireSafeComposer: true });
    expect(writes).toEqual([FOCUS_OUT, FOCUS_IN]);
    expect(focus.isActive).toBe(false);
  });

  it('reports the away-summary pending transition in the screen_update payload', () => {
    const turnId = 'om_recap_turn';
    const focus = new AwaySummaryFocus({
      now: () => Date.UTC(2026, 10, 22, 1, 0, 0), setTimer: () => () => {},
      refusal: () => undefined, currentTurnId: () => turnId, watched: () => false,
      write: () => true, log: () => {},
    });
    focus.request(turnId);
    const scope: Record<string, unknown> = { awaySummaryFocus: focus, modelRequestClock: new ClaudeModelRequestClock() };
    const payload = loadWorkerFunction<() => Record<string, unknown>>('modelRequestPayload', scope);
    expect(payload()).toEqual({ awaySummaryPending: true });
    focus.noteRecap({ turnId });
    expect(payload()).toEqual({ awaySummaryPending: false });
  });

  it('resolves the folded turn once for both focus and transcript recap attribution', () => {
    const scope = {
      currentBotmuxTurnId: 'om_host',
      currentBotmuxDispatchAttempt: 1,
      foldedTypeAheadTurn: { turnId: 'om_folded', dispatchAttempt: 2, into: 'om_host' },
      turnTerminalEmitted: vi.fn(() => true),
      promptSuggestionReportTurn,
    };
    const currentRecapTurn = loadWorkerFunction('currentRecapTurn', scope);
    expect(currentRecapTurn()).toEqual({ turnId: 'om_folded', dispatchAttempt: 2 });
  });

  it('feeds that resolved turn to the transcript recap observer', () => {
    const events = [{ type: 'system', subtype: 'away_summary' }];
    const recap = { text: 'recap', turnId: 'om_folded', dispatchAttempt: 2 };
    const scope = {
      cliRecapObserver: { observe: vi.fn(() => recap) },
      currentRecapTurn: vi.fn(() => ({ turnId: 'om_folded', dispatchAttempt: 2 })),
      awaySummaryFocus: { noteRecap: vi.fn() },
    };
    const observe = loadWorkerFunction('observeCurrentCliRecap', scope);
    expect(observe(events)).toBe(recap);
    expect(scope.currentRecapTurn).toHaveBeenCalledTimes(1);
    expect(scope.cliRecapObserver.observe).toHaveBeenCalledWith(
      events, { turnId: 'om_folded', dispatchAttempt: 2 }, expect.any(Number),
    );
    expect(scope.awaySummaryFocus.noteRecap).toHaveBeenCalledWith(recap);
  });

  it('uses only the bridge-confirmed busy-after-idle signal to end a recap turn', () => {
    const scope = {
      bridgeJsonlPath: '/tmp/claude.jsonl',
      bridgeReadPosition: vi.fn(() => ({ path: '/tmp/claude.jsonl', offset: 10 })),
      bridgeBlindTurnWatch: { noteTurnStarted: vi.fn() },
      awaySummaryFocus: { noteCliTurnStarted: vi.fn() },
    };
    const noteStarted = loadWorkerFunction('noteClaudeBridgeTurnStarted', scope);
    noteStarted();
    expect(scope.awaySummaryFocus.noteCliTurnStarted).toHaveBeenCalledTimes(1);
  });
});
