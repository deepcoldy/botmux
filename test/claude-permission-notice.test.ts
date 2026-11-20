import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePermissionNoticeTracker } from '../src/services/claude-action-prompt.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { PromptSuggestionPublisher, promptSuggestionReportTurn } from '../src/utils/prompt-suggestion-publisher.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dialog = 'Bash command\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel';
afterEach(() => vi.useRealTimers());

function start(cliId = 'claude-code') {
  vi.useFakeTimers();
  let screen = dialog;
  const messages: any[] = [];
  const scope: any = {
    renderCols: 160, renderRows: 40, PromptSuggestionPublisher, promptSuggestionReportTurn,
    turnTerminalEmitted: () => false,
    TerminalRenderer: class {
      rawSnapshot() { return screen; }
      async writeAndFlush() {}
    },
    backend: {}, cliSpawnGeneration: 1, cliLifetimeNonce: 1,
    lastInitConfig: { cliId }, effectiveBackendType: 'pty', cliAdapter: {},
    awaitingFirstPrompt: false, currentBotmuxTurnId: 'turn-1',
    webTerminalInputGeneration: 0, ptyOutputGeneration: { snapshot: () => 0 },
    lastAnalyzerSnapshot: dialog, SCREEN_UPDATE_INTERVAL_MS: 2_000,
    snapshotWithLatestRuntimeStatus: async () => ({ snapshot: { content: dialog }, status: 'idle' }),
    projectedRuntimeScreenStatus: () => 'idle', observeTraexAutoModelCapacity() {},
    classifyUsageLimitWithNativeEvidence: (_: string, status: string) => ({ status }),
    settleBackgroundTasksFromSiblings() {}, refreshBackgroundWait() {},
    startupInputHeld: () => false, backgroundWaitPayload: () => ({}),
    send: (message: any) => messages.push(message),
  };
  loadWorkerFunction<() => void>('startScreenUpdates', scope)();
  return { scope, messages, setScreen: (value: string) => { screen = value; },
    notices: () => messages.filter(m => m.kind === 'claude_permission_prompt') };
}

describe('fresh permission notice observations', () => {
  it('does not add captures to a static idle observe backend without a dialog', async () => {
    const run = start();
    run.setScreen('Ready');
    run.scope.backend = { captureCurrentScreen() {} };
    run.scope.snapshotWithLatestRuntimeStatus = async () => ({ snapshot: { content: 'Ready' }, status: 'idle' });
    run.scope.snapshotToText = vi.fn(async () => ({ content: 'Ready' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.scope.snapshotToText).not.toHaveBeenCalled();
    expect(run.notices()).toEqual([]);
  });

  it('does not notify after auto-allow clears the viewport, even with a stale analyzer cache', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.notices()).toEqual([]);
    run.setScreen('Running command');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.notices()).toEqual([]);
  });

  it.each(['turn-1', undefined])('notifies once for a persistent idle/fork dialog with turn %s', async turn => {
    const run = start(); run.scope.currentBotmuxTurnId = turn;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run.notices()).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toEqual([expect.objectContaining({ permissionPromptStable: true, turnId: turn })]);
    run.setScreen('idle'); await vi.advanceTimersByTimeAsync(2_000);
    run.setScreen(dialog); await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(2);
  });

  it.each(['cliLifetimeNonce', 'cliSpawnGeneration', 'currentBotmuxTurnId', 'currentBotmuxDispatchAttempt', 'webTerminalInputGeneration'])
    ('starts a fresh observation window when %s changes', async key => {
      const run = start();
      await vi.advanceTimersByTimeAsync(4_000);
      run.scope[key] = key === 'currentBotmuxTurnId' ? 'turn-2' : 2;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(run.notices()).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(run.notices()).toHaveLength(1);
    });

  it('does not apply Claude notices to another CLI', async () => {
    const run = start('grok');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(run.notices()).toEqual([]);
  });

  it('captures a static observe backend rather than reusing analyzer text', async () => {
    const run = start();
    run.scope.backend = { captureCurrentScreen() {} };
    let screen = dialog;
    run.scope.snapshotToText = vi.fn(async () => ({ content: screen }));
    await vi.advanceTimersByTimeAsync(4_000);
    screen = 'Running command';
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toEqual([]);
    expect(run.scope.snapshotToText).toHaveBeenCalled();
  });

  it('re-arms after a capture failure instead of permanently silencing a real dialog', async () => {
    const run = start();
    run.scope.backend = { captureCurrentScreen() {} };
    run.scope.snapshotToText = vi.fn().mockRejectedValueOnce(new Error('capture failed'))
      .mockResolvedValue({ content: dialog });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);
  });

  it('flushes queued PTY output and never uses the old permission screen', async () => {
    const renderer = new TerminalRenderer(160, 40);
    try {
      await renderer.writeAndFlush(dialog.replaceAll('\n', '\r\n'));
      renderer.write('\x1b[2J\x1b[HRunning command');
      const scope = { backend: {}, renderer, lastInitConfig: { cliId: 'claude-code' }, lastAnalyzerSnapshot: dialog };
      const capture = loadWorkerFunction<() => Promise<{ screen: string }>>('captureClaudePermissionNoticeScreen', scope);
      expect((await capture()).screen.trim()).toBe('Running command');
    } finally { renderer.dispose(); }
  });

  it.each(['backend', 'renderer', 'cliSpawnGeneration', 'cliLifetimeNonce', 'currentBotmuxTurnId',
    'currentBotmuxDispatchAttempt', 'webTerminalInputGeneration', 'backendScreenRevision', 'cliRestartInProgress'])
    ('rejects a capture completing after %s changes', async key => {
      let finish!: () => void;
      const scope: any = { backend: {}, lastInitConfig: { cliId: 'claude-code' },
        renderer: { rawSnapshot: () => dialog, writeAndFlush: () => new Promise<void>(resolve => { finish = resolve; }) } };
      const capture = loadWorkerFunction<() => Promise<unknown>>('captureClaudePermissionNoticeScreen', scope);
      const result = capture();
      scope[key] = key === 'backend' || key === 'renderer' ? {} : true;
      finish();
      expect(await result).toBeUndefined();
    });

  it('rejects an old capture even when no later sample or output arrived', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const scope = { backend: {}, lastInitConfig: { cliId: 'claude-code' }, SCREEN_UPDATE_INTERVAL_MS: 2_000,
      renderer: { rawSnapshot: () => dialog, writeAndFlush: () => new Promise<void>(resolve => { finish = resolve; }) } };
    const result = loadWorkerFunction<() => Promise<unknown>>('captureClaudePermissionNoticeScreen', scope)();
    await vi.advanceTimersByTimeAsync(4_000);
    finish();
    expect(await result).toBeUndefined();
  });

  it('does not count unknown frames as evidence of a persistent dialog', () => {
    const tracker = new ClaudePermissionNoticeTracker();
    tracker.observe(dialog, 'runtime', 0);
    tracker.observe(undefined, 'runtime', 2_000);
    expect(tracker.observe(dialog, 'runtime', 4_000)).toBeUndefined();
    expect(tracker.observe(dialog, 'runtime', 8_000)).toBeDefined();
  });

  it('requires a new stable window for a replaced question', () => {
    const tracker = new ClaudePermissionNoticeTracker();
    expect(tracker.observe(dialog, 'runtime', 0)).toBeUndefined();
    const edit = dialog.replace('proceed', 'make this edit');
    expect(tracker.observe(edit, 'runtime', 4_000)).toBeUndefined();
    expect(tracker.observe(edit, 'runtime', 8_000)).toContain('make this edit');
  });
});
