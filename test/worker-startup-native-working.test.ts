/** Startup publication must expose active native work without admitting queued input. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

afterEach(() => vi.useRealTimers());

/** Execute the production screen timer with controlled terminal evidence and clock. */
function start(options: { cli?: string; authoritative?: boolean; busy?: boolean; screen?: string; argv?: boolean } = {}) {
  vi.useFakeTimers();
  let screen = options.screen ?? 'Running command first';
  let changed = true;
  let snapshots = 0;
  const messages: Array<Record<string, unknown>> = [];
  const scope: Record<string, unknown> = {
    renderCols: 160, renderRows: 40,
    TerminalRenderer: class {
      rawSnapshot() { return screen; }
      snapshot() { snapshots++; const result = { content: screen, changed }; changed = false; return result; }
    },
    awaitingFirstPrompt: true, isPromptReady: false,
    backend: {}, cliSpawnGeneration: 1,
    lastInitConfig: { cliId: options.cli ?? 'antigravity', cliSessionId: 'native-resumed' },
    lastSpawnEffectiveCliSessionId: undefined, sessionId: 'startup-session',
    cliAdapter: { busyPattern: /Running command/, isSessionBusy: () => options.busy ?? true },
    backendScreenEvidenceIsAuthoritativeForMutation: () => options.authoritative ?? true,
    busyProbeRegion: (text: string) => text,
    inspectAidenCodexUpdateDialogOnScreen() {}, observeTraexAutoModelCapacity() {},
    spawnArgvNeedsWorkingSeed: options.argv ?? false,
    projectedRuntimeScreenStatus: () => 'working',
    currentBotmuxTurnId: 'existing-turn', currentBotmuxDispatchAttempt: undefined,
    send: (message: Record<string, unknown>) => messages.push(message), log() {},
    SCREEN_UPDATE_INTERVAL_MS: 100, setInterval,
  };
  loadWorkerFunction<() => void>('startScreenUpdates', scope)();
  return { scope, messages, snapshots: () => snapshots, nextFrame(text: string) { screen = text; changed = true; } };
}

describe('native work during initial prompt admission', () => {
  it('publishes current and changing work frames while keeping the prompt gate closed', () => {
    const run = start();
    vi.advanceTimersByTime(100);
    expect(run.messages).toEqual([expect.objectContaining({ type: 'screen_update', status: 'working', content: 'Running command first' })]);
    vi.advanceTimersByTime(100);
    expect(run.messages).toHaveLength(1);
    run.nextFrame('Running command second');
    vi.advanceTimersByTime(100);
    expect(run.messages).toHaveLength(2);
    expect(run.messages[1]?.content).toBe('Running command second');
    run.nextFrame('> empty composer');
    vi.advanceTimersByTime(100);
    expect(run.messages).toHaveLength(2);
    expect(run.scope.awaitingFirstPrompt).toBe(true);
    expect(run.scope.isPromptReady).toBe(false);
    expect(run.messages.every(message => message.type === 'screen_update')).toBe(true);
  });

  it.each([
    { authoritative: false }, { busy: false }, { screen: 'Starting up' },
    { screen: '> empty composer' }, { cli: 'claude-code' },
  ])('does not infer native work without both authoritative live and native evidence: %j', options => {
    const run = start(options);
    vi.advanceTimersByTime(300);
    expect(run.messages).toEqual([]);
    expect(run.scope.awaitingFirstPrompt).toBe(true);
  });

  it('retains the existing single initial publication for argv-delivered prompts', () => {
    const run = start({ cli: 'grok', argv: true, screen: 'model response' });
    vi.advanceTimersByTime(100);
    run.nextFrame('another response');
    vi.advanceTimersByTime(100);
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]?.status).toBe('working');
    expect(run.snapshots()).toBe(1);
  });
});
