import { describe, expect, it } from 'vitest';
import {
  botmuxSessionArgvMarker,
  parsePidLines,
  reapStaleCodexThreadWriter,
  type StaleWriterReaperDeps,
} from '../src/services/codex-stale-writer-reaper.js';

const THREAD = '01a1bf6c-17cd-7862-b1ab-7e64eab530ce';
const SESSION = '7dde7682-61df-44fb-931f-cdffb7823881';
const OTHER_SESSION = '1f49392e-9e40-4669-91ea-9c95fcf7cb93';

function codexArgv(sessionId: string): string {
  return `/opt/codex -c shell_environment_policy.set.${botmuxSessionArgvMarker(sessionId)} resume --no-alt-screen ${THREAD}`;
}

/** A tiny fake host: processes with argv, which ones hold the lock, and how
 *  each reacts to signals. Time only advances through wait(). */
function fakeHost(procs: Record<number, { argv?: string; dies?: 'TERM' | 'KILL' | 'never' }>, opts: {
  lock?: boolean; holders?: number[] | undefined;
} = {}) {
  let clock = 0;
  const alive = new Set(Object.keys(procs).map(Number));
  const signals: Array<[number, NodeJS.Signals]> = [];
  const deps: StaleWriterReaperDeps = {
    lockExists: () => opts.lock ?? true,
    listLockHolders: () => (opts.holders === undefined && 'holders' in opts)
      ? undefined
      : (opts.holders ?? [...alive]).filter(pid => alive.has(pid)),
    readArgv: pid => procs[pid]?.argv,
    signal: (pid, sig) => {
      signals.push([pid, sig]);
      const rule = procs[pid]?.dies ?? 'TERM';
      if (rule === 'TERM' || (rule === 'KILL' && sig === 'SIGKILL')) alive.delete(pid);
    },
    provablyGone: pid => !alive.has(pid),
    now: () => clock,
    wait: async ms => { clock += ms; },
  };
  return { deps, signals, alive };
}

const base = { codexHome: '/h/.codex', threadId: THREAD, sessionId: SESSION, pollMs: 50 };

describe('reapStaleCodexThreadWriter', () => {
  it('retires a stale Codex of the same session that still holds the thread', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(SESSION) } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, deps: host.deps });
    expect(outcome).toEqual({ kind: 'reaped', pids: [4242], forced: false });
    expect(host.signals).toEqual([[4242, 'SIGTERM']]);
    expect(host.alive.has(4242)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(SESSION), dies: 'KILL' } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, termGraceMs: 500, deps: host.deps });
    expect(outcome).toEqual({ kind: 'reaped', pids: [4242], forced: true });
    expect(host.signals).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  });

  it('reports stuck when the holder survives SIGKILL', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(SESSION), dies: 'never' } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, termGraceMs: 200, killGraceMs: 200, deps: host.deps });
    expect(outcome).toEqual({ kind: 'stuck', pids: [4242] });
  });

  it('never signals a holder that belongs to the user or another session', async () => {
    const host = fakeHost({
      100: { argv: '/Applications/Codex.app/Contents/MacOS/codex app-server' },
      200: { argv: codexArgv(OTHER_SESSION) },
      300: { argv: undefined },
    });
    const outcome = await reapStaleCodexThreadWriter({ ...base, deps: host.deps });
    expect(outcome).toEqual({ kind: 'foreign', pids: [100, 200, 300], reaped: [] });
    expect(host.signals).toEqual([]);
  });

  it('retires its own stale copy but still reports a foreign co-holder', async () => {
    const host = fakeHost({ 100: { argv: 'codex' }, 4242: { argv: codexArgv(SESSION) } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, deps: host.deps });
    expect(outcome).toEqual({ kind: 'foreign', pids: [100], reaped: [4242] });
    expect(host.signals).toEqual([[4242, 'SIGTERM']]);
  });

  it('does nothing without a lock file, without holders, or when holders cannot be listed', async () => {
    const noLock = fakeHost({ 4242: { argv: codexArgv(SESSION) } }, { lock: false });
    expect(await reapStaleCodexThreadWriter({ ...base, deps: noLock.deps })).toEqual({ kind: 'no-lock' });
    const free = fakeHost({ 4242: { argv: codexArgv(SESSION) } }, { holders: [] });
    expect(await reapStaleCodexThreadWriter({ ...base, deps: free.deps })).toEqual({ kind: 'free' });
    const blind = fakeHost({ 4242: { argv: codexArgv(SESSION) } }, { holders: undefined });
    expect(await reapStaleCodexThreadWriter({ ...base, deps: blind.deps })).toEqual({ kind: 'unavailable' });
    expect([...noLock.signals, ...free.signals, ...blind.signals]).toEqual([]);
  });

  it('never signals an excluded pid (the worker itself)', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(SESSION) } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, excludePids: [4242], deps: host.deps });
    expect(outcome).toEqual({ kind: 'free' });
    expect(host.signals).toEqual([]);
  });

  it('does not treat a session id prefix as ownership', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(`${SESSION}0`) } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, deps: host.deps });
    expect(outcome.kind).toBe('foreign');
    expect(host.signals).toEqual([]);
  });

  it('rejects a thread id that is not a uuid (no path traversal into other locks)', async () => {
    const host = fakeHost({ 4242: { argv: codexArgv(SESSION) } });
    const outcome = await reapStaleCodexThreadWriter({ ...base, threadId: '../.coordination', deps: host.deps });
    expect(outcome).toEqual({ kind: 'no-lock' });
    expect(host.signals).toEqual([]);
  });
});

describe('parsePidLines', () => {
  it('reads lsof -t output', () => {
    expect(parsePidLines('123\n456\n\n')).toEqual([123, 456]);
    expect(parsePidLines('')).toEqual([]);
  });
});
