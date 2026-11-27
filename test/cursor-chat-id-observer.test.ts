import { describe, expect, it, vi } from 'vitest';
import { findLaunchedCliPid } from '../src/core/session-discovery.js';
import { shouldObserveCursorChatId, shouldPersistObservedCursorChatId } from '../src/services/cursor-resume-policy.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Runs the REAL observeCursorCliSessionId and currentCursorObservedPid from
// src/worker.ts against a synthetic process table. Measured on a live Linux
// host: the tmux pane is the session-scope supervisor `sh -c "$@"; status=$?;
// exit "$status" botmux-session-scope …`, which stays Cursor's parent instead of
// exec'ing into it, and Cursor 2026.11.19 runs as `node` with comm `MainThread`
// (argv[0] is still .../cursor-agent). Only Cursor holds the chat's store.db.

const PANE = 100;
const CURSOR = 101;
const CHAT = 'c0ffee00-1111-4222-8333-444455556666';

interface Proc { comm: string; cmdline: string[]; children: number[]; chatId?: string }

function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    setTimeout: (fn: () => void) => { queue.push(fn); return 0; },
    runNext: () => { queue.shift()?.(); },
    runAll: (max = 200) => { for (let n = 0; queue.length && n < max; n++) queue.shift()!(); },
    pending: () => queue.length,
  };
}

function harness(opts: {
  procs: Record<number, Proc>;
  backend: { getChildPid: () => number | null; cliPid?: number };
}) {
  const scheduler = makeScheduler();
  const persistCliSessionId = vi.fn();
  const scope: Record<string, unknown> = {
    lastInitConfig: { cliId: 'cursor' },
    lastSpawnEffectiveResume: false,
    lastSpawnEffectiveCliSessionId: undefined,
    codexAdoptPendingPid: undefined,
    cliSpawnGeneration: 1,
    backend: opts.backend,
    shouldObserveCursorChatId,
    shouldPersistObservedCursorChatId,
    findLaunchedCliPid: (pid: number, cliId: Parameters<typeof findLaunchedCliPid>[1]) => findLaunchedCliPid(pid, cliId, 6, {
      childrenOf: p => opts.procs[p]?.children ?? [],
      commOf: p => opts.procs[p]?.comm,
      cmdlineOf: p => opts.procs[p]?.cmdline ?? [],
      isZombie: () => false,
    }),
    findCursorChatIdByPid: (pid: number) => opts.procs[pid]?.chatId,
    persistCliSessionId,
    ensureCursorCotReader: vi.fn(),
    codexBridgeFallbackActive: () => false,
    codexBridgeNotifyCliSessionId: vi.fn(),
    log: vi.fn(),
    setTimeout: scheduler.setTimeout,
  };
  scope.currentCursorObservedPid = loadWorkerFunction('currentCursorObservedPid', scope);
  const observe = loadWorkerFunction<(pid: number, label?: string) => void>('observeCursorCliSessionId', scope);
  return { observe, scheduler, persistCliSessionId, scope };
}

const scopedCursorTree = (): Record<number, Proc> => ({
  [PANE]: { comm: 'sh', cmdline: ['/bin/sh', '-c', '"$@"; status=$?; exit "$status"', 'botmux-session-scope'], children: [CURSOR] },
  [CURSOR]: {
    comm: 'MainThread',
    cmdline: ['/home/u/.local/share/cursor-agent/versions/2026.11.19-f005e9d/cursor-agent', '--use-system-ca', 'index.js'],
    children: [],
    chatId: CHAT,
  },
});

describe('observeCursorCliSessionId behind botmux launch layers', () => {
  it('persists the chat id once launch-layer resolution rewires cliPid past the session-scope sh', () => {
    const backend: { getChildPid: () => number; cliPid?: number } = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs: scopedCursorTree(), backend });

    observe(PANE);
    scheduler.runNext(); // the scope payload is not resolved yet
    expect(persistCliSessionId).not.toHaveBeenCalled();
    backend.cliPid = CURSOR; // what applyResolvedCliPid does for the session-scope layer
    scheduler.runAll();

    expect(persistCliSessionId).toHaveBeenCalledWith(CHAT);
  });

  it('keeps polling on a backend whose getChildPid aliases the rewired cliPid (Herdr/ZMX shape)', () => {
    const backend: { getChildPid: () => number; cliPid?: number } = { getChildPid: () => backend.cliPid ?? PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs: scopedCursorTree(), backend });

    observe(PANE);
    scheduler.runNext();
    backend.cliPid = CURSOR;
    scheduler.runAll();

    expect(persistCliSessionId).toHaveBeenCalledWith(CHAT);
  });

  it.each([
    ['native comm', 'cursor-agent-local', ['/opt/cursor-agent-local', '--authless']],
    ['Linux-truncated comm', 'cursor-agent-lo', ['/opt/cursor-agent-local', '--authless']],
    ['MainThread executable argv', 'MainThread', ['/opt/cursor-agent-local', '--authless']],
  ])('persists Agent Local chat id below a persistent wrapper using %s', (_label, comm, cmdline) => {
    const procs: Record<number, Proc> = {
      [PANE]: { comm: 'sh', cmdline: ['sh'], children: [CURSOR] },
      [CURSOR]: { comm, cmdline, children: [], chatId: CHAT },
    };
    const backend = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs, backend });

    observe(PANE);
    scheduler.runAll();

    expect(persistCliSessionId).toHaveBeenCalledWith(CHAT);
  });

  it('keeps an already-identified Agent Local main pid when its Electron helper shares the identity', () => {
    const procs: Record<number, Proc> = {
      [PANE]: {
        comm: 'MainThread',
        cmdline: ['/opt/cursor-agent-local', '--authless'],
        children: [CURSOR],
        chatId: CHAT,
      },
      [CURSOR]: {
        comm: 'MainThread',
        cmdline: ['/opt/cursor-agent-local', '--type=gpu-process'],
        children: [],
      },
    };
    const backend = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs, backend });

    observe(PANE);
    scheduler.runAll();

    expect(persistCliSessionId).toHaveBeenCalledWith(CHAT);
  });

  it('does not bind a MainThread wrapper merely naming Agent Local in a program argument', () => {
    const procs: Record<number, Proc> = {
      [PANE]: { comm: 'sh', cmdline: ['sh'], children: [CURSOR] },
      [CURSOR]: {
        comm: 'MainThread',
        cmdline: ['node', '/srv/unrelated.js', '/opt/cursor-agent-local'],
        children: [],
        chatId: CHAT,
      },
    };
    const backend = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs, backend });

    observe(PANE);
    scheduler.runAll();

    expect(persistCliSessionId).not.toHaveBeenCalled();
  });

  it('stops once a later spawn supersedes this one', () => {
    const backend: { getChildPid: () => number; cliPid?: number } = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId, scope } = harness({ procs: scopedCursorTree(), backend });

    observe(PANE);
    scheduler.runNext();
    scope.cliSpawnGeneration = 2;
    backend.cliPid = CURSOR;
    scheduler.runAll();

    expect(persistCliSessionId).not.toHaveBeenCalled();
    expect(scheduler.pending()).toBe(0);
  });

  it('still persists when the pane is Cursor itself (no launch layer)', () => {
    const procs = { [PANE]: { ...scopedCursorTree()[CURSOR] } };
    const backend = { getChildPid: () => PANE };
    const { observe, scheduler, persistCliSessionId } = harness({ procs, backend });

    observe(PANE);
    scheduler.runAll();

    expect(persistCliSessionId).toHaveBeenCalledWith(CHAT);
  });
});
