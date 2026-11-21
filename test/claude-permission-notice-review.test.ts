import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptSuggestionPublisher, promptSuggestionReportTurn } from '../src/utils/prompt-suggestion-publisher.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dialog = 'Bash command\nDo you want to proceed?\n1. Yes\n2. No\nEsc to cancel';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function start(cliId = 'claude-code') {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let screen = dialog, output = 0;
  const messages: any[] = [];
  const scope: any = {
    renderCols: 160, renderRows: 40, PromptSuggestionPublisher, promptSuggestionReportTurn,
    turnTerminalEmitted: () => false,
    TerminalRenderer: class { rawSnapshot() { return screen; } async writeAndFlush() {} },
    backend: {}, cliSpawnGeneration: 1, cliLifetimeNonce: 1,
    lastInitConfig: { cliId }, effectiveBackendType: 'pty', cliAdapter: {},
    awaitingFirstPrompt: false, currentBotmuxTurnId: 'turn-1', currentBotmuxDispatchAttempt: 1,
    webTerminalInputGeneration: 0, backendScreenRevision: 0,
    ptyOutputGeneration: { snapshot: () => output, isCurrent: (value: number) => value === output },
    lastAnalyzerSnapshot: dialog, SCREEN_UPDATE_INTERVAL_MS: 2_000,
    snapshotWithLatestRuntimeStatus: async () => ({ snapshot: { content: dialog }, status: 'idle' }),
    projectedRuntimeScreenStatus: () => 'idle', observeTraexAutoModelCapacity() {},
    classifyUsageLimitWithNativeEvidence: (_: string, status: string) => ({ status }),
    settleBackgroundTasksFromSiblings() {}, refreshBackgroundWait() {},
    startupInputHeld: () => false, backgroundWaitPayload: () => ({}),
    send: (message: any) => messages.push(message),
  };
  loadWorkerFunction<() => void>('startScreenUpdates', scope)();
  return { scope, messages, notices: () => messages.filter(message => message.kind === 'claude_permission_prompt'),
    screenUpdates: () => messages.filter(message => message.type === 'screen_update'),
    setScreen(value: string) { screen = value; output++; scope.backendScreenRevision++; } };
}

// 非文本断言：从真实 capture 函数移除输入代次守卫，只在内存执行变异并断言行为。
function capture(scope: any): () => Promise<unknown> {
  if (!process.env.BOTMUX_NOTICE_REVIEW_MUTATION) return loadWorkerFunction('captureClaudePermissionNoticeScreen', scope);
  const source = ts.createSourceFile('worker.ts', readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let code = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureClaudePermissionNoticeScreen')!.getText(source);
  const guard = 'input !== webTerminalInputGeneration || ';
  if (!code.includes(guard)) throw Error('Missing targeted input guard');
  code = code.replace(guard, '');
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const proxy = new Proxy(scope, { has: (_, key) => key !== Symbol.unscopables,
    get: (value, key) => key in value ? value[key] : (globalThis as any)[key] });
  return new Function('scope', `with(scope) { ${js}; return captureClaudePermissionNoticeScreen; }`)(proxy);
}

describe('independent Claude permission notice review', () => {
  it('does not repeat an already reported dialog after a selection-navigation key', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);
    run.scope.webTerminalInputGeneration++;
    run.setScreen(dialog.replace('1. Yes', '❯ 1. Yes'));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);
  });

  it('does not re-arm a delivered dialog merely because one capture fails', async () => {
    const run = start();
    run.scope.backend = { captureCurrentScreen() {} };
    run.scope.snapshotToText = vi.fn(async () => ({ content: dialog }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);
    run.scope.snapshotToText.mockRejectedValueOnce(Error('synthetic read failure'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.notices()).toHaveLength(1);
  });

  it('serializes permission reads and rejects a delayed frame after auto-clear', async () => {
    const run = start();
    run.scope.backend = { captureCurrentScreen() {} };
    const pending: Array<(value: { content: string }) => void> = [];
    run.scope.snapshotToText = vi.fn(() => new Promise(resolve => { pending.push(resolve); }));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending).toHaveLength(1);
    run.setScreen('Running command');
    await vi.advanceTimersByTimeAsync(3_000);
    pending[0]({ content: dialog }); await flush();
    expect(run.notices()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(pending).toHaveLength(2);
    pending[1]({ content: 'Running command' }); await flush();
    expect(run.notices()).toHaveLength(0);
  });

  it('requires a complete fresh wait after a real disappearance and reappearance', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);
    run.setScreen('Running command'); await vi.advanceTimersByTimeAsync(2_000);
    run.setScreen(dialog); await vi.advanceTimersByTimeAsync(4_000);
    expect(run.notices()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.notices()).toHaveLength(2);
  });

  it('rejects a capture when input arrives before the queued renderer flush completes', async () => {
    let finish!: () => void;
    const scope = { backend: {}, renderer: { rawSnapshot: () => dialog,
      writeAndFlush: () => new Promise<void>(resolve => { finish = resolve; }) },
      webTerminalInputGeneration: 0, lastInitConfig: { cliId: 'claude-code' } };
    const pending = capture(scope)();
    scope.webTerminalInputGeneration++;
    finish();
    expect(await pending).toBeUndefined();
  });

  it('re-arms an identical dialog only when a turn change has new output evidence', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);

    run.scope.currentBotmuxTurnId = 'turn-2';
    run.scope.currentBotmuxDispatchAttempt = 2;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);

    run.setScreen(dialog);
    run.scope.currentBotmuxDispatchAttempt = 3;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(2);
    expect(run.notices()[1]).toEqual(expect.objectContaining({ turnId: 'turn-2', dispatchAttempt: 3 }));
  });

  it('eventually re-arms a same-turn replacement without repeating on navigation', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);

    run.setScreen(dialog);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);

    run.scope.webTerminalInputGeneration++;
    run.setScreen(dialog.replace('1. Yes', '❯ 1. Yes'));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(run.notices()).toHaveLength(1);

    run.setScreen(dialog);
    await vi.advanceTimersByTimeAsync(34_000);
    expect(run.notices()).toHaveLength(2);
  });

  it('does not repeatedly notify an unchanged dialog on output-only redraws', async () => {
    const run = start();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.notices()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      run.setScreen(dialog);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(run.notices()).toHaveLength(1);
  });

  it('keeps a non-Claude CLI moving through slow overlapping general snapshots', async () => {
    const run = start('grok');
    const pending: Array<(value: any) => void> = [];
    run.scope.snapshotWithLatestRuntimeStatus = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pending).toHaveLength(2);

    pending[0]({ snapshot: { content: 'grok frame one', changed: true }, status: 'idle' }); await flush();
    pending[1]({ snapshot: { content: 'grok frame two', changed: true }, status: 'idle' }); await flush();
    expect(run.screenUpdates().map(message => message.content)).toEqual(['grok frame one', 'grok frame two']);
  });

  it('does not let a discarded older snapshot poison the cached frame used by a later status change', async () => {
    const run = start('grok');
    let projectedStatus = 'idle';
    let resolveOld!: (value: any) => void;
    let filteredCalls = 0;
    run.scope.lastPtyActivityAtMs = 1;
    run.scope.projectedRuntimeScreenStatus = () => projectedStatus;
    run.scope.isScreenSelfDriven = () => false;
    run.scope.shouldCaptureScreen = ({ ptyActivity, lastCapturedPtyActivity }: any) => ptyActivity !== lastCapturedPtyActivity;
    run.scope.snapshotWithLatestRuntimeStatus = loadWorkerFunction('snapshotWithLatestRuntimeStatus', run.scope);
    run.scope.snapshotToText = vi.fn(async (_backend: any, _cols: any, _rows: any, options: any) => {
      if (!options.filter) return { content: 'CURRENT-RAW' };
      filteredCalls++;
      if (filteredCalls === 1) return new Promise(resolve => { resolveOld = resolve; });
      return { content: 'NEW', ansi: 'NEW', cols: 80, rows: 24 };
    });

    run.setScreen('OLD');
    await vi.advanceTimersByTimeAsync(2_000);
    run.scope.lastPtyActivityAtMs = 2;
    run.setScreen('NEW');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.screenUpdates().map(message => [message.content, message.status])).toEqual([['NEW', 'idle']]);

    resolveOld({ content: 'OLD', ansi: 'OLD', cols: 80, rows: 24 }); await flush();
    projectedStatus = 'working';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.screenUpdates().map(message => [message.content, message.status])).toEqual([
      ['NEW', 'idle'], ['NEW', 'working'],
    ]);
  });

  it('does not invalidate an in-flight capture when a status-only tick completes first', async () => {
    const run = start('grok');
    let projectedStatus = 'idle';
    let resolveCapture!: (value: any) => void;
    run.scope.lastPtyActivityAtMs = 1;
    run.scope.projectedRuntimeScreenStatus = () => projectedStatus;
    run.scope.isScreenSelfDriven = () => false;
    run.scope.shouldCaptureScreen = ({ ptyActivity, lastCapturedPtyActivity }: any) => ptyActivity !== lastCapturedPtyActivity;
    run.scope.snapshotWithLatestRuntimeStatus = loadWorkerFunction('snapshotWithLatestRuntimeStatus', run.scope);
    run.scope.snapshotToText = vi.fn(async (_backend: any, _cols: any, _rows: any, options: any) => {
      if (!options.filter) return { content: 'CURRENT-RAW' };
      return new Promise(resolve => { resolveCapture = resolve; });
    });

    await vi.advanceTimersByTimeAsync(2_000);
    projectedStatus = 'working';
    await vi.advanceTimersByTimeAsync(2_000);
    resolveCapture({ content: 'SLOW-FRESH', ansi: 'SLOW-FRESH', cols: 80, rows: 24 });
    await flush();
    expect(run.screenUpdates().map(message => [message.content, message.status])).toContainEqual(['SLOW-FRESH', 'working']);
  });

  it('bounds a stalled general capture to one timeout retry and recovers on new activity', async () => {
    const run = start('grok');
    const pending: Array<(value: any) => void> = [];
    run.scope.lastPtyActivityAtMs = 1;
    run.scope.isScreenSelfDriven = () => false;
    run.scope.shouldCaptureScreen = ({ ptyActivity, lastCapturedPtyActivity }: any) => ptyActivity !== lastCapturedPtyActivity;
    run.scope.snapshotWithLatestRuntimeStatus = loadWorkerFunction('snapshotWithLatestRuntimeStatus', run.scope);
    run.scope.snapshotToText = vi.fn(async (_backend: any, _cols: any, _rows: any, options: any) => {
      if (!options.filter) return { content: 'CURRENT-RAW' };
      return new Promise(resolve => pending.push(resolve));
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pending).toHaveLength(2);

    run.scope.lastPtyActivityAtMs = 2;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pending).toHaveLength(3);
    pending[2]({ content: 'RECOVERED', ansi: 'RECOVERED', cols: 80, rows: 24 });
    await flush();
    expect(run.screenUpdates().map(message => message.content)).toContain('RECOVERED');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pending).toHaveLength(3);
  });

  it('fences a non-Claude CLI general snapshot at a turn transition', async () => {
    const run = start('grok');
    const pending: Array<(value: any) => void> = [];
    run.scope.snapshotWithLatestRuntimeStatus = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    await vi.advanceTimersByTimeAsync(2_000);
    run.scope.currentBotmuxTurnId = 'turn-2';
    run.scope.currentBotmuxDispatchAttempt = 2;
    pending[0]({ snapshot: { content: 'old turn frame', changed: true }, status: 'idle' }); await flush();
    expect(run.screenUpdates()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    pending[1]({ snapshot: { content: 'new turn frame', changed: true }, status: 'idle' }); await flush();
    expect(run.screenUpdates()).toEqual([expect.objectContaining({
      content: 'new turn frame', turnId: 'turn-2', dispatchAttempt: 2,
    })]);
  });
});
