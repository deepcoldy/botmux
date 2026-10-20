/**
 * PR #507 restart races. The pure decisions they feed are executed in
 * restart-followup-policy.test.ts; the #1863 merge guard / receipt ownership is
 * executed against a real worker in worker-restart-merge-attempt.test.ts and
 * through the extracted upgrade/restart functions in
 * worker-codex-session-upgrade.test.ts. This file executes the shared drain
 * helper and the fatal-error receipt path, and keeps one structural tripwire
 * for the duplicate-side-effect race that has no behavioural seam.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker restart — drain reliable terminal before ambiguous emit', () => {
  function drainHarness(reliableTurnTerminal: boolean | undefined) {
    const calls: string[] = [];
    const scope: Record<string, unknown> = {
      cliAdapter: { reliableTurnTerminal },
      bridgeJsonlPath: '/session/bridge.jsonl',
      codexBridgeFallbackActive: () => true,
      bridgeDrainAndMaybeEmit: () => { calls.push('claude transcript'); },
      codexBridgeDrainAndMaybeEmit: (opts: unknown) => { calls.push(`codex bridge ${JSON.stringify(opts)}`); },
      log: vi.fn(),
    };
    const drain = loadWorkerFunction<() => void>('drainReliableTerminalBeforeInterrupt', scope);
    return { calls, drain, scope };
  }

  it('drains only reliable-terminal CLIs, transcript first and Codex without an idle signal', () => {
    const unreliable = drainHarness(undefined);
    unreliable.drain();
    expect(unreliable.calls).toEqual([]);

    const reliable = drainHarness(true);
    reliable.drain();
    expect(reliable.calls).toEqual(['claude transcript', 'codex bridge {"signalIdle":false}']);
  });

  it('skips inactive bridges and keeps draining when one bridge throws', () => {
    const h = drainHarness(true);
    h.scope.bridgeJsonlPath = undefined;
    h.drain();
    expect(h.calls).toEqual(['codex bridge {"signalIdle":false}']);

    const failing = drainHarness(true);
    failing.scope.bridgeDrainAndMaybeEmit = () => { throw new Error('torn jsonl'); };
    expect(() => failing.drain()).not.toThrow();
    expect(failing.calls).toEqual(['codex bridge {"signalIdle":false}']);
  });

  // 源码结构护栏(K3)：restart IPC 分支与 CLI onExit 回调都在 worker.ts 巨型闭包里，
  // 没有可执行的 seam。PR #507 P1：restart 分支绕过 drain 直接 emit 'ambiguous'，
  // 把「kill 前刚完成、watcher 未消费」的 durable turn 误标 ambiguous → 同 key 可重派 →
  // 外部副作用执行两次。这里只钉「两条 ambiguous 路径都先调用共享 drain helper」。
  it('both durable-ambiguous paths call the shared drain helper before emitting', () => {
    const restartStart = workerSource.indexOf("case 'restart':");
    const restartCase = workerSource.slice(restartStart, workerSource.indexOf("case 'expire_durable_turn':", restartStart));
    const settleCall = restartCase.slice(restartCase.indexOf('settleDurableTurnForRestart({'));
    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(settleCall.slice(0, settleCall.indexOf('emitAmbiguous'))).toContain('drainReliableTerminalBeforeInterrupt()');

    const exitAmbiguous = workerSource.search(/'ambiguous',\s*'cli_exit'/);
    expect(exitAmbiguous).toBeGreaterThan(0);
    expect(workerSource.slice(exitAmbiguous - 800, exitAmbiguous)).toContain('drainReliableTerminalBeforeInterrupt()');
  });
});

describe('worker fatal error — correlated restart receipts', () => {
  it('fails both the owning and a pending folded restart attempt before reporting the error', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const scope: Record<string, unknown> = {
      fatalWorkerErrorPending: false,
      currentBotmuxTurnId: 'om_turn',
      currentBotmuxDispatchAttempt: 2,
      activeRestartAttemptId: 'owner-attempt',
      pendingLaunchConvergence: { attemptId: 'folded-attempt', requested: {} },
      sendAndFlush: vi.fn(async (msg: Record<string, unknown>) => { sent.push(msg); }),
      log: vi.fn(),
      process: { exit: vi.fn() },
    };
    const fatal = loadWorkerFunction<(err: unknown) => Promise<void>>('sendFatalWorkerErrorAndExit', scope);

    await fatal(new Error('spawn exploded'));

    expect(sent).toEqual([
      { type: 'restart_result', attemptId: 'folded-attempt', status: 'failed', category: 'spawn_failed' },
      { type: 'restart_result', attemptId: 'owner-attempt', status: 'failed', category: 'spawn_failed' },
      { type: 'error', message: 'spawn exploded', turnId: 'om_turn', dispatchAttempt: 2 },
    ]);
    expect(scope.pendingLaunchConvergence).toBeUndefined();
    expect(scope.activeRestartAttemptId).toBeUndefined();
    expect((scope.process as { exit: ReturnType<typeof vi.fn> }).exit).toHaveBeenCalledWith(1);

    // A second fatal path in the same generation reports nothing more.
    await fatal(new Error('again'));
    expect(sent).toHaveLength(3);
  });
});
