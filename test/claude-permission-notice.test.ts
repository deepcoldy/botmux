import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudePermissionNoticeTracker } from '../src/services/claude-action-prompt.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { PromptSuggestionPublisher, promptSuggestionReportTurn } from '../src/utils/prompt-suggestion-publisher.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dialog = 'Bash command\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

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
  it('recovers from a permanently pending permission read without blocking ordinary screens', async () => {
    const run = start();
    const read = vi.fn().mockImplementationOnce(() => new Promise<void>(() => {})).mockResolvedValue(undefined);
    run.scope.renderer.writeAndFlush = read;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.messages.some(message => message.type === 'screen_update')).toBe(true);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(run.notices()).toHaveLength(1);
  });

  it('ignores an expired read that returns after a replacement has observed the dialog', async () => {
    const run = start();
    let release!: () => void;
    run.scope.renderer.writeAndFlush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }))
      .mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.notices()).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.notices()).toHaveLength(1);
  });

  it.each(['pty', 'observe'])('keeps ordinary updates and eventually reports a dialog when %s permission captures take longer than a tick', async backend => {
    const run = start();
    let pending = 0, peakPending = 0;
    const read = () => new Promise<void>(resolve => {
      pending++; peakPending = Math.max(peakPending, pending);
      setTimeout(() => { pending--; resolve(); }, 2_500);
    });
    if (backend === 'pty') run.scope.renderer.writeAndFlush = read;
    else {
      run.scope.backend = { captureCurrentScreen() {} };
      run.scope.snapshotToText = async () => { await read(); return { content: dialog }; };
    }
    await vi.advanceTimersByTimeAsync(12_000);
    expect(run.messages.filter(message => message.type === 'screen_update').length).toBeGreaterThan(0);
    expect(run.notices()).toHaveLength(1);
    expect(peakPending).toBe(1);
  });

  it.each(['turn', 'attempt'])('does not publish a previous snapshot under a changed %s after a permission read', async kind => {
    const run = start();
    run.scope.currentBotmuxDispatchAttempt = 1;
    let finish!: () => void;
    run.scope.renderer.writeAndFlush = () => new Promise<void>(resolve => { finish = resolve; });
    await vi.advanceTimersByTimeAsync(2_000);
    if (kind === 'turn') run.scope.currentBotmuxTurnId = 'turn-2';
    else run.scope.currentBotmuxDispatchAttempt = 2;
    finish();
    await vi.advanceTimersByTimeAsync(0);
    const stale = run.messages.filter(message => message.type === 'screen_update' && message.content === dialog
      && (kind === 'turn' ? message.turnId === 'turn-2' : message.dispatchAttempt === 2));
    expect(stale).toEqual([]);
    expect(run.notices()).toEqual([]);
  });

  it.each(['turn', 'attempt'])('does not repeat a still-visible fork dialog after an unrelated %s changes', async kind => {
    const run = start();
    run.scope.currentBotmuxTurnId = undefined;
    run.scope.currentBotmuxDispatchAttempt = undefined;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);
    if (kind === 'turn') run.scope.currentBotmuxTurnId = 'new-main-turn';
    else run.scope.currentBotmuxDispatchAttempt = 2;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);
  });

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

  it('accepts a slow renderer flush whose fresh read still belongs to the unchanged screen', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const scope = { backend: {}, lastInitConfig: { cliId: 'claude-code' }, SCREEN_UPDATE_INTERVAL_MS: 2_000,
      renderer: { rawSnapshot: () => dialog, writeAndFlush: () => new Promise<void>(resolve => { finish = resolve; }) } };
    const result = loadWorkerFunction<() => Promise<unknown>>('captureClaudePermissionNoticeScreen', scope)();
    await vi.advanceTimersByTimeAsync(4_000);
    finish();
    expect(await result).toMatchObject({ screen: dialog });
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

  it('keeps no-output dedup across turns, re-arms a new CLI lifetime, and ignores navigation', () => {
    const tracker = new ClaudePermissionNoticeTracker();
    const emittedAt: number[] = [];
    const observe = (runtime: string, observation: string, turn: string, episode: string, now: number) => {
      if (tracker.observe(dialog, runtime, now, observation, episode, turn)) emittedAt.push(now);
    };

    observe('physical-a', 'background', 'background', '0', 0);
    observe('physical-a', 'background', 'background', '0', 2_000);
    observe('physical-a', 'background', 'background', '0', 4_000);
    observe('physical-a', 'main', 'main', '0', 6_000);
    observe('physical-a', 'main', 'main', '0', 8_000);
    observe('physical-a', 'main', 'main', '0', 10_000);
    expect(emittedAt).toEqual([4_000]);

    observe('physical-b', 'main', 'main', '0', 12_000);
    observe('physical-b', 'main', 'main', '0', 14_000);
    observe('physical-b', 'main', 'main', '0', 16_000);
    expect(emittedAt).toEqual([4_000, 16_000]);

    observe('physical-b', 'main-input', 'main', '1', 18_000);
    observe('physical-b', 'main-input', 'main', '1', 20_000);
    observe('physical-b', 'main-input', 'main', '1', 22_000);
    expect(emittedAt).toEqual([4_000, 16_000]);
  });

  it('throttles a same-turn replacement candidate without hiding it after navigation', () => {
    const tracker = new ClaudePermissionNoticeTracker();
    const emittedAt: number[] = [];
    const observe = (observation: string, episode: string, now: number) => {
      if (tracker.observe(dialog, 'physical', now, observation, episode, 'turn')) emittedAt.push(now);
    };

    observe('turn-input-0', '0', 0);
    observe('turn-input-0', '0', 2_000);
    observe('turn-input-0', '0', 4_000);
    observe('turn-input-0', '1', 6_000);
    observe('turn-input-0', '1', 8_000);
    observe('turn-input-0', '1', 10_000);
    expect(emittedAt).toEqual([4_000]);

    observe('turn-input-1', '2', 12_000);
    observe('turn-input-1', '2', 14_000);
    observe('turn-input-1', '2', 16_000);
    observe('turn-input-1', '3', 18_000);
    observe('turn-input-1', '3', 20_000);
    observe('turn-input-1', '3', 22_000);
    expect(emittedAt).toEqual([4_000]);

    observe('turn-input-1', '3', 34_000);
    observe('turn-input-1', '3', 36_000);
    observe('turn-input-1', '3', 38_000);
    expect(emittedAt).toEqual([4_000, 38_000]);
  });

  it('does not repeatedly re-arm an unchanged dialog on output-only redraws', () => {
    const tracker = new ClaudePermissionNoticeTracker();
    const emittedAt: number[] = [];
    for (let now = 0; now <= 22_000; now += 2_000) {
      if (tracker.observe(dialog, 'physical', now, 'turn-input', String(now), 'turn')) emittedAt.push(now);
    }
    expect(emittedAt).toEqual([4_000]);
  });

  it.each([{ replacementEpisode: '1' }, { replacementEpisode: undefined }])(
    're-arms an identical replacement with changed or missing episode evidence (%s)', ({ replacementEpisode }) => {
      const tracker = new ClaudePermissionNoticeTracker();
      const emittedAt: number[] = [];
      const observe = (observation: string, turn: string, episode: string | undefined, now: number) => {
        if (tracker.observe(dialog, 'physical', now, observation, episode, turn)) emittedAt.push(now);
      };

      observe('background', 'background', '0', 0);
      observe('background', 'background', '0', 2_000);
      observe('background', 'background', '0', 4_000);
      observe('main', 'main', replacementEpisode, 6_000);
      observe('main', 'main', replacementEpisode, 8_000);
      observe('main', 'main', replacementEpisode, 10_000);
      expect(emittedAt).toEqual([4_000, 10_000]);
    });
});
