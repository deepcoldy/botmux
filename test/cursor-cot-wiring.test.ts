import { describe, expect, it, vi } from 'vitest';

import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * Cursor CoT reader start-up, driven through the real worker functions.
 *
 * cursor-cot.test.ts covers the service module; these run the worker-side
 * decisions (when a reader counts as started, where the chatId comes from)
 * against an injected scope instead of importing the whole worker.
 */
describe('ensureCursorCotReader', () => {
  function harness(startResults: boolean[]) {
    const scope: Record<string, unknown> = {
      cursorCotReaderChatId: undefined,
      startCursorCot: vi.fn(() => startResults.shift() ?? false),
      log: vi.fn(),
    };
    const ensure = loadWorkerFunction<(chatId: string) => void>('ensureCursorCotReader', scope);
    return { scope, ensure };
  }

  it('marks the reader chat only after start succeeds, so a failed start is retried', () => {
    // A missing/unresolved store must not make later attempts short-circuit.
    const { scope, ensure } = harness([false, true]);
    ensure('chat-1');
    expect(scope.cursorCotReaderChatId).toBeUndefined();
    ensure('chat-1');
    expect(scope.cursorCotReaderChatId).toBe('chat-1');
    expect(scope.startCursorCot).toHaveBeenCalledTimes(2);
  });

  it('does not start a second reader for the chat it already reads', () => {
    const { scope, ensure } = harness([true]);
    ensure('chat-1');
    ensure('chat-1');
    expect(scope.startCursorCot).toHaveBeenCalledTimes(1);
  });
});

describe('armCursorCotForTurn', () => {
  function harness(overrides: Record<string, unknown>) {
    const scope: Record<string, unknown> = {
      lastInitConfig: { cliId: 'cursor' },
      lastSpawnEffectiveCliSessionId: undefined,
      backend: null,
      findLaunchedCliPid: vi.fn(() => undefined),
      findCursorChatIdByPid: vi.fn(() => undefined),
      ensureCursorCotReader: vi.fn(),
      ...overrides,
    };
    const arm = loadWorkerFunction<() => void>('armCursorCotForTurn', scope);
    return { scope, arm };
  }

  it('uses the observed native session id when spawn already resolved it', () => {
    const { scope, arm } = harness({ lastSpawnEffectiveCliSessionId: 'chat-observed' });
    arm();
    expect(scope.ensureCursorCotReader).toHaveBeenCalledWith('chat-observed');
    expect(scope.findCursorChatIdByPid).not.toHaveBeenCalled();
  });

  it('falls back to the live cursor process when spawn observation has not resolved (queued / Goal turns)', () => {
    const { scope, arm } = harness({
      backend: { cliPid: 100 },
      findLaunchedCliPid: vi.fn(() => 200),
      findCursorChatIdByPid: vi.fn((pid: number) => (pid === 200 ? 'chat-from-pid' : undefined)),
    });
    arm();
    expect(scope.findLaunchedCliPid).toHaveBeenCalledWith(100, 'cursor');
    expect(scope.ensureCursorCotReader).toHaveBeenCalledWith('chat-from-pid');
  });

  it('does nothing for other CLIs', () => {
    const { scope, arm } = harness({ lastInitConfig: { cliId: 'codex' }, lastSpawnEffectiveCliSessionId: 'chat-x' });
    arm();
    expect(scope.ensureCursorCotReader).not.toHaveBeenCalled();
  });
});
