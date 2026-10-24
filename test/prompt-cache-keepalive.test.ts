/**
 * Daemon-side prompt-cache keep-alive: session eligibility, the sweep, the
 * worker ack, and the idle-clock restore across a keep-alive's own busy edge.
 *
 * Run: bun run vitest run test/prompt-cache-keepalive.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const globalConfig: { promptCache?: unknown } = {};
const statusline: { contextPercent?: number; contextWindowTokens?: number } = {};

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: () => globalConfig,
}));
vi.mock('../src/services/statusline-snapshot.js', () => ({
  readStatuslineSnapshot: () => ({ ts: Date.now(), ...statusline }),
}));

import {
  notePromptCacheKeepaliveResult,
  notePromptCacheKeepaliveScreenStatus,
  promptCacheKeepaliveIneligibility,
  resetPromptCacheKeepalive,
  resolvedPromptCacheTtl,
  runPromptCacheKeepaliveSweep,
} from '../src/core/prompt-cache-keepalive.js';
import type { DaemonSession } from '../src/core/types.js';

const MIN = 60_000;
const NOON = new Date(2026, 9, 23, 12, 0, 0);

function session(overrides: Record<string, unknown> = {}): DaemonSession {
  return {
    session: { sessionId: 'abcdef12-0000-0000-0000-000000000000' },
    worker: { killed: false },
    workerReady: true,
    initConfig: { cliId: 'claude-code', backendType: 'tmux', locale: 'zh' },
    lastScreenStatus: 'idle',
    idleSinceAt: NOON.getTime() - 55 * MIN,
    ...overrides,
  } as unknown as DaemonSession;
}

function sweep(sessions: DaemonSession[], bot: { promptCache?: unknown } = {}, now = NOON) {
  const send = vi.fn((_ds: DaemonSession, _text: string) => true);
  const sent = runPromptCacheKeepaliveSweep(sessions, {
    bot: bot as never,
    dataDir: '/tmp/unused',
    send,
    log: () => {},
    now,
  });
  return { sent, send };
}

beforeEach(() => {
  globalConfig.promptCache = undefined;
  statusline.contextPercent = 40;
  statusline.contextWindowTokens = 1_000_000;
});

describe('prompt-cache keep-alive sweep', () => {
  it('does nothing while neither layer enables it', () => {
    const { sent, send } = sweep([session()]);
    expect(sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one keep-alive once the global switch is on, and marks it in flight', () => {
    globalConfig.promptCache = { keepalive: { enabled: true } };
    const ds = session();
    const { sent, send } = sweep([ds]);
    expect(sent).toBe(1);
    expect(send.mock.calls[0][1]).toContain('BOTMUX_NOTHING_TO_SEND');
    expect(ds.promptCacheKeepalive).toEqual({ pings: 0, idleSinceAt: NOON.getTime() - 55 * MIN, inFlightSince: NOON.getTime() });
    // A second sweep in the same minute waits for the first one.
    expect(sweep([ds]).sent).toBe(0);
  });

  it('the bot override beats the global default', () => {
    globalConfig.promptCache = { keepalive: { enabled: true } };
    expect(sweep([session()], { promptCache: { keepalive: { enabled: false } } }).sent).toBe(0);
    globalConfig.promptCache = undefined;
    expect(sweep([session()], { promptCache: { keepalive: { enabled: true } } }).sent).toBe(1);
  });

  it('skips small contexts, unreadable contexts and off hours', () => {
    globalConfig.promptCache = { keepalive: { enabled: true, activeHours: '13:00-23:00' } };
    expect(sweep([session()]).sent).toBe(0);
    globalConfig.promptCache = { keepalive: { enabled: true } };
    statusline.contextPercent = 4;
    expect(sweep([session()]).sent).toBe(0);
    statusline.contextPercent = undefined;
    expect(sweep([session()]).sent).toBe(0);
  });

  it('a refused send leaves the session untouched for the next sweep', () => {
    globalConfig.promptCache = { keepalive: { enabled: true } };
    const ds = session();
    runPromptCacheKeepaliveSweep([ds], { bot: {}, dataDir: '/tmp/unused', send: () => false, log: () => {}, now: NOON });
    expect(ds.promptCacheKeepalive).toBeUndefined();
  });
});

describe('eligibility', () => {
  it.each([
    [{ worker: null }, 'no_worker'],
    [{ workerReady: false }, 'no_worker'],
    [{ initConfig: { cliId: 'codex', backendType: 'tmux' } }, 'not_claude_code'],
    [{ initConfig: { cliId: 'claude-code', backendType: 'tmux', adoptMode: true } }, 'adopted'],
    [{ initConfig: { cliId: 'claude-code', backendType: 'tmux', promptInjection: 'none' } }, 'zero_prompt'],
    [{ initConfig: { cliId: 'claude-code', backendType: 'remote-runner' } }, 'remote_backend'],
    [{ initConfig: { cliId: 'claude-code', backendType: 'zmx' } }, 'remote_backend'],
    [{ lastScreenStatus: 'working' }, 'not_idle'],
    [{ backgroundTaskCount: 2 }, 'background_tasks'],
  ])('%j → %s', (overrides, reason) => {
    expect(promptCacheKeepaliveIneligibility(session(overrides))).toBe(reason);
  });

  it('a local claude-code idle session is eligible', () => {
    expect(promptCacheKeepaliveIneligibility(session())).toBeUndefined();
    expect(promptCacheKeepaliveIneligibility(session({ initConfig: { cliId: 'claude-code', backendType: 'pty' } }))).toBeUndefined();
  });
});

describe('ack and idle-clock bookkeeping', () => {
  const idleStart = NOON.getTime() - 55 * MIN;

  it('an accepted keep-alive counts once and restores the idle start on its own idle edge', () => {
    const ds = session({ promptCacheKeepalive: { pings: 0, idleSinceAt: idleStart, inFlightSince: NOON.getTime() } });
    notePromptCacheKeepaliveResult(ds, true);
    expect(ds.promptCacheKeepalive).toMatchObject({ pings: 1, lastPingAt: NOON.getTime() });

    // working edge (the keep-alive turn running): the stretch survives
    ds.lastScreenStatus = 'working';
    ds.idleSinceAt = undefined;
    notePromptCacheKeepaliveScreenStatus(ds, 'idle', NOON.getTime() + 1_000);
    expect(ds.promptCacheKeepalive).toBeDefined();

    // idle edge: the stamp just set to "now" is put back to the stretch start
    ds.lastScreenStatus = 'idle';
    ds.idleSinceAt = NOON.getTime() + 5_000;
    notePromptCacheKeepaliveScreenStatus(ds, 'working', NOON.getTime() + 5_000);
    expect(ds.idleSinceAt).toBe(idleStart);
    expect(ds.promptCacheKeepalive).toEqual({ pings: 1, lastPingAt: NOON.getTime(), idleSinceAt: idleStart });
  });

  it('a refused keep-alive is forgotten so a later sweep can retry', () => {
    const ds = session({ promptCacheKeepalive: { pings: 0, idleSinceAt: idleStart, inFlightSince: NOON.getTime() } });
    notePromptCacheKeepaliveResult(ds, false);
    expect(ds.promptCacheKeepalive).toBeUndefined();
  });

  it('a busy edge that is not a keep-alive ends the stretch', () => {
    const ds = session({ promptCacheKeepalive: { pings: 1, lastPingAt: NOON.getTime(), idleSinceAt: idleStart } });
    ds.lastScreenStatus = 'working';
    notePromptCacheKeepaliveScreenStatus(ds, 'idle', NOON.getTime() + MIN);
    expect(ds.promptCacheKeepalive).toBeUndefined();
  });

  it('a new turn resets the stretch', () => {
    const ds = session({ promptCacheKeepalive: { pings: 2, idleSinceAt: idleStart } });
    resetPromptCacheKeepalive(ds);
    expect(ds.promptCacheKeepalive).toBeUndefined();
  });
});

describe('resolvedPromptCacheTtl', () => {
  it('follows the merged policy', () => {
    expect(resolvedPromptCacheTtl({})).toBeUndefined();
    globalConfig.promptCache = { ttl: '5m' };
    expect(resolvedPromptCacheTtl({})).toBe('5m');
    expect(resolvedPromptCacheTtl({ promptCache: { ttl: '1h' } })).toBe('1h');
  });
});
