/**
 * Unit tests for HerdrBackend.
 *
 * Covers:
 *   - Backend "connection" surface: isAvailable / hasSession / ensureServer
 *     boot polling (no busy-spin; respects an already-running session).
 *   - spawn() in three flavours: fresh agent start, existing-agent reuse, and
 *     external-target adopt — verifies the right `herdr agent {start,get}` /
 *     pane-id wiring runs in each case.
 *   - Message writing: write / sendText / sendSpecialKeys hit `pane
 *     send-text` and `pane send-keys` with the resolved pane target.
 *   - Data + exit callbacks: poll() emits the prefix-delta on changed
 *     `pane read` output, and emits exit once the agent vanishes from
 *     `agent list`.
 *
 * Run:  pnpm vitest run test/herdr-backend.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPtySpawn = vi.mocked(pty.spawn);

// ─── Helpers ───────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  killed = false;
  unref = vi.fn();
  kill = vi.fn(() => { this.killed = true; return true; });
}

function makeFakeChild(): FakeChild { return new FakeChild(); }

class FakePty {
  readonly resize = vi.fn();
  readonly kill = vi.fn();
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((event: { exitCode: number; signal?: number }) => void) | null = null;

  readonly onData = vi.fn((cb: (data: string) => void) => {
    this.dataCb = cb;
    return { dispose: vi.fn() };
  });

  readonly onExit = vi.fn((cb: (event: { exitCode: number; signal?: number }) => void) => {
    this.exitCb = cb;
    return { dispose: vi.fn() };
  });

  emitData(data: string): void { this.dataCb?.(data); }
  emitExit(exitCode = 0, signal?: number): void { this.exitCb?.({ exitCode, signal }); }
}

function makeFakePty(): FakePty { return new FakePty(); }

function findCall(predicate: (args: string[]) => boolean): string[] | undefined {
  for (const call of mockedExecFileSync.mock.calls) {
    const args = (call[1] as string[]) ?? [];
    if (predicate(args)) return args;
  }
  return undefined;
}

function findCallOpts(predicate: (args: string[]) => boolean): any | undefined {
  for (const call of mockedExecFileSync.mock.calls) {
    const args = (call[1] as string[]) ?? [];
    if (predicate(args)) return call[2];
  }
  return undefined;
}

function herdrCall(...needles: string[]): string[] | undefined {
  return findCall(args => needles.every(n => args.includes(n)));
}

/**
 * Route mocked herdr CLI invocations to canned payloads. Anything not matched
 * returns "" (sleep, version probes, fire-and-forget writes).
 */
function setHerdrResponses(handlers: Array<{ match: (args: string[]) => boolean; reply: () => string }>) {
  mockedExecFileSync.mockImplementation(((cmd: any, args: any) => {
    if (cmd !== 'herdr') return '' as any;
    const argv = args as string[];
    for (const h of handlers) {
      if (h.match(argv)) return h.reply() as any;
    }
    return '' as any;
  }) as any);
}

const SESSION = 'bmx-deadbeef';
const EXISTING_SESSION_REPLY = JSON.stringify({ sessions: [{ name: SESSION, running: true }] });
const EMPTY_SESSIONS_REPLY = JSON.stringify({ sessions: [] });
const AGENT_GET_REPLY = (paneId: string) => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: paneId } } });
const AGENT_LIST_REPLY = (paneId: string) => JSON.stringify({ result: { agents: [{ name: 'botmux', pane_id: paneId }] } });
const PANE_READ_REPLY = (text: string) => JSON.stringify({ result: { read: { text } } });

beforeEach(() => {
  mockedExecFileSync.mockReset();
  mockedSpawn.mockReset();
  mockedPtySpawn.mockReset();
  // Default: every spawn (including the bg `wait agent-status` watcher) gets
  // a fake child whose lifecycle the test fully controls.
  mockedSpawn.mockImplementation((() => makeFakeChild()) as any);
  mockedPtySpawn.mockImplementation((() => makeFakePty()) as any);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Backend connection surface ────────────────────────────────────────────

describe('HerdrBackend connection surface', () => {
  it('isAvailable() returns true when `herdr --version` succeeds', () => {
    mockedExecFileSync.mockImplementation((() => 'herdr 1.0\n') as any);
    expect(HerdrBackend.isAvailable()).toBe(true);
    const versionCall = mockedExecFileSync.mock.calls.find(c => (c[1] as string[]).includes('--version'));
    expect(versionCall).toBeDefined();
  });

  it('isAvailable() returns false when herdr binary is missing', () => {
    mockedExecFileSync.mockImplementation((() => { throw new Error('ENOENT'); }) as any);
    expect(HerdrBackend.isAvailable()).toBe(false);
  });

  it('hasSession() parses `session list --json` and matches running sessions', () => {
    setHerdrResponses([{
      match: a => a[0] === 'session' && a[1] === 'list',
      reply: () => JSON.stringify({ sessions: [{ name: SESSION, running: true }, { name: 'other', running: false }] }),
    }]);
    expect(HerdrBackend.hasSession(SESSION)).toBe(true);
    expect(HerdrBackend.hasSession('other')).toBe(false);
    expect(HerdrBackend.hasSession('missing')).toBe(false);
  });

  // ── Tri-state probe (exists | missing | unknown) ────────────────────────────
  // The restore-time zombie-close decision MUST NOT collapse "list command
  // failed/timed out" into "session is gone" — a transient probe failure would
  // otherwise permanently close a still-alive session. probeSession() keeps the
  // two apart; hasSession() stays the conservative boolean wrapper.
  it('probeSession() reports "exists" for a running session and "missing" for an absent one', () => {
    setHerdrResponses([{
      match: a => a[0] === 'session' && a[1] === 'list',
      reply: () => JSON.stringify({ sessions: [{ name: SESSION, running: true }] }),
    }]);
    expect(HerdrBackend.probeSession(SESSION)).toBe('exists');
    expect(HerdrBackend.probeSession('bmx-absent')).toBe('missing');
  });

  it('probeSession() reports "missing" for a present-but-not-running row (a genuine zombie)', () => {
    setHerdrResponses([{
      match: a => a[0] === 'session' && a[1] === 'list',
      reply: () => JSON.stringify({ sessions: [{ name: SESSION, running: false }] }),
    }]);
    expect(HerdrBackend.probeSession(SESSION)).toBe('missing');
  });

  it('probeSession() reports "unknown" when `session list` fails/times out — NOT "missing"', () => {
    mockedExecFileSync.mockImplementation((() => { throw new Error('ETIMEDOUT'); }) as any);
    expect(HerdrBackend.probeSession(SESSION)).toBe('unknown');
    // hasSession() must stay conservative (false) on unknown so existing
    // boolean callers are unaffected by the new tri-state.
    expect(HerdrBackend.hasSession(SESSION)).toBe(false);
  });

  it('ensureServer skips boot poll when session already exists (no spawn, no sleep)', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    // Session already exists ⇒ this is the reattach path (resolves paneId via
    // `agent get`, no `agent start`).
    const be = new HerdrBackend(SESSION, { isReattach: true });
    be.spawn('claude', [], { cwd: '/tmp', cols: 80, rows: 24, env: {} });
    // Only the bg status watcher should be spawned. No `herdr ... server`, no
    // sleep child_process call.
    const headlessSpawns = mockedSpawn.mock.calls.filter(c => (c[1] as string[]).includes('server'));
    expect(headlessSpawns).toHaveLength(0);
    const sleepCalls = mockedExecFileSync.mock.calls.filter(c => c[0] === 'sleep');
    expect(sleepCalls).toHaveLength(0);
    be.kill();
  });

  it('ensureServer spawns `herdr server` then polls until hasSession returns true', () => {
    // First three session-list probes report empty, fourth reports running.
    let listCount = 0;
    setHerdrResponses([
      {
        match: a => a[0] === 'session' && a[1] === 'list',
        reply: () => {
          listCount++;
          return listCount >= 4 ? EXISTING_SESSION_REPLY : EMPTY_SESSIONS_REPLY;
        },
      },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '1-1' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    // No pre-existing session ⇒ fresh start: boots `herdr server`, then
    // `agent start`s the CLI.
    const be = new HerdrBackend(SESSION, { createSession: true });
    be.spawn('claude', [], { cwd: '/tmp', cols: 80, rows: 24, env: {} });
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeDefined();
    // At least one `sleep` invocation between session-list probes — proves we
    // are not busy-spinning.
    const sleepCalls = mockedExecFileSync.mock.calls.filter(c => c[0] === 'sleep');
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    be.kill();
  });
});

// ─── spawn(): fresh / existing / external ──────────────────────────────────

describe('HerdrBackend.spawn', () => {
  it('fresh session: calls `agent start botmux --cwd <cwd> -- bin args...` and records pane_id', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '2-3' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('hello') },
    ]);
    const be = new HerdrBackend(SESSION);
    be.spawn('claude', ['--resume', 'abc'], { cwd: '/work', cols: 120, rows: 30, env: {} });

    const startCall = herdrCall('agent', 'start', 'botmux', '--cwd', '/work', '--', 'claude', '--resume', 'abc');
    expect(startCall).toBeDefined();
    expect(startCall).toContain('--session');
    expect(startCall![startCall!.indexOf('--session') + 1]).toBe(SESSION);
    be.kill();
  });

  it('per-bot injectEnv is threaded into the herdr server + agent-start env (so the forked CLI inherits it)', () => {
    // Fresh start so ensureServer actually boots a `herdr server`: first
    // session-list probe empty (→ boot), subsequent probes running (→ ready).
    let listCount = 0;
    setHerdrResponses([
      {
        match: a => a[0] === 'session' && a[1] === 'list',
        reply: () => { listCount++; return listCount >= 2 ? EXISTING_SESSION_REPLY : EMPTY_SESSIONS_REPLY; },
      },
      { match: a => a.includes('agent') && a.includes('start'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, { createSession: true });
    be.spawn('claude', [], {
      cwd: '/work', cols: 80, rows: 24,
      env: { BOTMUX_SESSION_ID: 'sess_x' },
      injectEnv: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'glm-key' },
    });

    // The daemon forks the CLI, so the SERVER spawn env is what the CLI inherits.
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeDefined();
    expect(serverSpawn![2].env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(serverSpawn![2].env.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    expect(serverSpawn![2].env.BOTMUX_SESSION_ID).toBe('sess_x'); // base env preserved
    // agent-start call carries it too (defense in depth).
    const startOpts = findCallOpts(a => a.includes('agent') && a.includes('start'));
    expect(startOpts?.env?.ANTHROPIC_AUTH_TOKEN).toBe('glm-key');
    be.kill();
  });

  it('without injectEnv the server env carries only the base env (no provider keys)', () => {
    let listCount = 0;
    setHerdrResponses([
      {
        match: a => a[0] === 'session' && a[1] === 'list',
        reply: () => { listCount++; return listCount >= 2 ? EXISTING_SESSION_REPLY : EMPTY_SESSIONS_REPLY; },
      },
      { match: a => a.includes('agent') && a.includes('start'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, { createSession: true });
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: { BOTMUX_SESSION_ID: 'sess_x' } });
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn![2].env.BOTMUX_SESSION_ID).toBe('sess_x');
    expect(serverSpawn![2].env.ANTHROPIC_BASE_URL).toBeUndefined();
    be.kill();
  });

  it('reattach reuses an existing agent without re-running `agent start`', () => {
    // Reuse is gated on isReattach: only a genuine daemon-restart reattach to a
    // still-alive session adopts the existing `botmux` row. A fresh spawn (incl.
    // the /restart respawn) always `agent start`s — see the restart test below.
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('9-9') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, { isReattach: true });
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    expect(herdrCall('agent', 'start', 'botmux')).toBeUndefined();
    be.kill();
  });

  it('fresh spawn does NOT reuse a residual agent row — always `agent start`s (restart fix)', () => {
    // Regression for the /restart no-op: after destroySession, herdr can
    // resurrect a dead `botmux` row. A non-reattach spawn must ignore it and
    // start the new CLI, or the resume:true respawn silently runs nothing.
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('9-9') },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: 'fresh-1' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, { createSession: true });
    be.spawn('claude', ['--resume', 'x'], { cwd: '/work', cols: 80, rows: 24, env: {} });
    expect(herdrCall('agent', 'start', 'botmux')).toBeDefined();
    be.kill();
  });

  it('external target adopt: uses externalTarget paneId, never spawns server or agent', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('adopted screen') },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    expect(herdrCall('agent', 'start', 'botmux')).toBeUndefined();
    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeUndefined();
    be.kill();
  });

  it('external target adopt throws when the herdr session is not running', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EMPTY_SESSIONS_REPLY },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    expect(() => be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: {} }))
      .toThrow(/is not running/);
  });
});

// ─── Session ownership on destroySession ─────────────────────────────────────

describe('HerdrBackend.destroySession ownership', () => {
  it('managed session: stops the herdr session (botmux owns it)', () => {
    setHerdrResponses([]);
    const be = new HerdrBackend(SESSION);
    be.destroySession();
    expect(herdrCall('session', 'stop', SESSION)).toBeDefined();
  });

  it('adopted external target: detaches only, never stops the user\'s session', () => {
    setHerdrResponses([]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    be.destroySession();
    // The external herdr session belongs to the user — destroySession must not
    // issue `session stop` (mirrors TmuxPipeBackend's ownsSession guard).
    expect(herdrCall('session', 'stop')).toBeUndefined();
  });
});

// ─── Managed web-terminal direct attach ────────────────────────────────────

describe('HerdrBackend web terminal sizing', () => {
  function spawnManagedBackend(): HerdrBackend {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('pane-web') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, { isReattach: true });
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: { PATH: '/usr/bin' } });
    return be;
  }

  it('uses the first resized viewer as owner and pins later viewers to its grid', () => {
    const attach = makeFakePty();
    mockedPtySpawn.mockReturnValue(attach as any);
    const be = spawnManagedBackend();
    const desktop = {};
    const mobile = {};
    const relayed: string[] = [];
    be.onData(data => relayed.push(data));

    expect(be.acquireWebTerminal(desktop)).toBeNull();
    expect(be.resizeWebTerminal(desktop, 150, 42)).toEqual({ cols: 150, rows: 42 });
    expect(mockedPtySpawn).toHaveBeenCalledTimes(1);
    expect(mockedPtySpawn).toHaveBeenCalledWith(
      'herdr',
      ['--session', SESSION, 'agent', 'attach', 'pane-web'],
      expect.objectContaining({ name: 'xterm-256color', cols: 150, rows: 42 }),
    );
    expect(mockedPtySpawn.mock.calls[0]![1]).not.toContain('--takeover');
    expect(attach.onData).toHaveBeenCalledOnce();
    attach.emitData('ignored attach frame');
    expect(relayed).toEqual([]);

    expect(be.acquireWebTerminal(mobile)).toEqual({ cols: 150, rows: 42 });
    expect(be.resizeWebTerminal(mobile, 48, 30)).toBeNull();
    expect(attach.resize).not.toHaveBeenCalled();
    expect(be.isWebTerminalOwner(desktop)).toBe(true);
    expect(be.isWebTerminalOwner(mobile)).toBe(false);

    expect(be.resizeWebTerminal(desktop, 160, 45)).toEqual({ cols: 160, rows: 45 });
    expect(attach.resize).toHaveBeenCalledWith(160, 45);
    be.kill();
  });

  it('promotes without applying a stale follower size and releases the last viewer', () => {
    const attach = makeFakePty();
    const reopenedAttach = makeFakePty();
    mockedPtySpawn.mockReturnValueOnce(attach as any).mockReturnValueOnce(reopenedAttach as any);
    const be = spawnManagedBackend();
    const desktop = {};
    const mobile = {};

    be.acquireWebTerminal(desktop);
    be.resizeWebTerminal(desktop, 150, 42);
    be.acquireWebTerminal(mobile);
    be.resizeWebTerminal(mobile, 48, 30);
    attach.resize.mockClear();

    expect(be.releaseWebTerminal(desktop)).toBe(mobile);
    expect(attach.resize).not.toHaveBeenCalled();
    expect(be.isWebTerminalOwner(mobile)).toBe(true);
    expect(be.resizeWebTerminal(mobile, 52, 32)).toEqual({ cols: 52, rows: 32 });
    expect(attach.resize).toHaveBeenCalledWith(52, 32);

    expect(be.releaseWebTerminal(mobile)).toBeNull();
    expect(attach.kill).toHaveBeenCalledOnce();

    const reopened = {};
    expect(be.acquireWebTerminal(reopened)).toBeNull();
    expect(be.resizeWebTerminal(reopened, 90, 28)).toEqual({ cols: 90, rows: 28 });
    expect(mockedPtySpawn).toHaveBeenCalledTimes(2);
    expect(mockedPtySpawn.mock.calls[1]![2]).toEqual(expect.objectContaining({ cols: 90, rows: 28 }));
    be.kill();
    expect(attach.kill).toHaveBeenCalledOnce();
    expect(reopenedAttach.kill).toHaveBeenCalledOnce();
  });

  it('tracks the real cursor from the managed web attach stream', async () => {
    const attach = makeFakePty();
    mockedPtySpawn.mockReturnValue(attach as any);
    const be = spawnManagedBackend();
    const viewer = {};
    const cursors: Array<{ col: number; row: number }> = [];
    be.onWebTerminalCursor(cursor => cursors.push(cursor));

    be.acquireWebTerminal(viewer);
    be.resizeWebTerminal(viewer, 80, 24);
    attach.emitData('\x1b[5;7H');
    attach.emitData('\x1b[8;9H');

    await vi.waitFor(() => expect(cursors).toEqual([{ col: 8, row: 7 }]));
    expect(be.getWebTerminalCursor()).toEqual({ col: 8, row: 7 });
    be.kill();
  });

  it('cleans an exited attach and retries on the owner next resize', () => {
    const first = makeFakePty();
    const second = makeFakePty();
    mockedPtySpawn.mockReturnValueOnce(first as any).mockReturnValueOnce(second as any);
    const be = spawnManagedBackend();
    const viewer = {};

    be.acquireWebTerminal(viewer);
    be.resizeWebTerminal(viewer, 120, 36);
    first.emitExit(1);
    expect(be.resizeWebTerminal(viewer, 130, 38)).toEqual({ cols: 130, rows: 38 });
    expect(mockedPtySpawn).toHaveBeenCalledTimes(2);
    expect(mockedPtySpawn.mock.calls[1]![2]).toEqual(expect.objectContaining({ cols: 130, rows: 38 }));

    be.kill();
    expect(second.kill).toHaveBeenCalledOnce();
  });

  it('never direct-attaches an external adopted target', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: 'external-pane', paneId: 'external-pane' },
    });
    be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const viewer = {};

    expect(be.acquireWebTerminal(viewer)).toBeNull();
    expect(be.resizeWebTerminal(viewer, 150, 42)).toBeNull();
    expect(be.releaseWebTerminal(viewer)).toBeNull();
    expect(mockedPtySpawn).not.toHaveBeenCalled();
    be.kill();
  });
});

// ─── Env propagation ───────────────────────────────────────────────────────

describe('HerdrBackend env propagation', () => {
  // Regression: worker.ts hands us a redacted+injected env (BOTMUX_* added,
  // bare LARK_APP_SECRET deleted). If we don't thread that env through the
  // herdr daemon spawn AND the agent-start call, the CLI inside herdr sees
  // raw process.env: missing BOTMUX_* (botmux send/ask exits 2) AND leaks
  // LARK_APP_SECRET. Both are blocking bugs from PR #81 review.
  const cliEnv = {
    BOTMUX_SESSION_ID: 'sess-1',
    BOTMUX_CHAT_ID: 'chat-1',
    BOTMUX_LARK_APP_ID: 'app-1',
    BOTMUX_ROOT_MESSAGE_ID: 'msg-1',
    PATH: '/usr/bin',
    // Intentionally NOT including LARK_APP_SECRET — redactChildEnv would
    // have already dropped it before reaching the backend.
  };

  it('fresh server boot: spawns `herdr server` with the worker-supplied env', () => {
    let listCount = 0;
    setHerdrResponses([
      {
        match: a => a[0] === 'session' && a[1] === 'list',
        reply: () => { listCount++; return listCount >= 2 ? EXISTING_SESSION_REPLY : EMPTY_SESSIONS_REPLY; },
      },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '2-3' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);

    const be = new HerdrBackend(SESSION);
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: cliEnv });

    const serverSpawn = mockedSpawn.mock.calls.find(c => (c[1] as string[]).includes('server'));
    expect(serverSpawn).toBeDefined();
    const serverOpts = serverSpawn![2] as { env?: Record<string, string> };
    expect(serverOpts.env).toBeDefined();
    expect(serverOpts.env!.BOTMUX_SESSION_ID).toBe('sess-1');
    expect(serverOpts.env!.BOTMUX_LARK_APP_ID).toBe('app-1');
    // Ensure we didn't accidentally pass through the test runner's env
    // (which would re-introduce whatever the parent shell exported).
    expect('LARK_APP_SECRET' in serverOpts.env!).toBe(false);
    be.kill();
  });

  it('agent start: passes the worker-supplied env to execFileSync', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '2-3' } } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);

    const be = new HerdrBackend(SESSION);
    be.spawn('claude', ['--resume', 'abc'], { cwd: '/work', cols: 80, rows: 24, env: cliEnv });

    const opts = findCallOpts(a => a.includes('agent') && a.includes('start'));
    expect(opts).toBeDefined();
    expect(opts!.env).toBeDefined();
    expect(opts!.env.BOTMUX_SESSION_ID).toBe('sess-1');
    expect(opts!.env.BOTMUX_CHAT_ID).toBe('chat-1');
    be.kill();
  });

  it('external target adopt: skips env injection (user owns the running CLI)', () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    const be = new HerdrBackend(SESSION, {
      externalTarget: { sessionName: SESSION, target: '1-1', paneId: '1-1' },
    });
    be.spawn('', [], { cwd: '/work', cols: 80, rows: 24, env: cliEnv });
    // Adopt path doesn't run `herdr server` or `agent start`, so there's
    // no env to assert — just verify no agent-start was issued.
    expect(herdrCall('agent', 'start', 'botmux')).toBeUndefined();
    be.kill();
  });
});

// ─── Message writing ───────────────────────────────────────────────────────

describe('HerdrBackend message writing', () => {
  function spawnBackend(paneId = '1-1'): HerdrBackend {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY(paneId) },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);
    // isReattach so the mocked `agent get` row resolves paneId without needing
    // an `agent start` reply (reuse is now gated on the reattach path).
    const be = new HerdrBackend(SESSION, { isReattach: true });
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    mockedExecFileSync.mockClear();
    // re-install the response handlers since mockClear wipes them
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY(paneId) },
    ]);
    return be;
  }

  it('write() / sendText() invoke `pane send-text` on the resolved pane id', () => {
    const be = spawnBackend('5-5');
    be.sendText('飞书消息');

    const call = herdrCall('pane', 'send-text', '5-5', '飞书消息');
    expect(call).toBeDefined();
    expect(call!.slice(0, 2)).toEqual(['--session', SESSION]);
    be.kill();
  });

  it('sendSpecialKeys() invokes `pane send-keys` with each key', () => {
    const be = spawnBackend('5-5');
    be.sendSpecialKeys('Enter', 'C-c');

    const call = herdrCall('pane', 'send-keys', '5-5', 'Enter', 'C-c');
    expect(call).toBeDefined();
    be.kill();
  });

  it('write() is a no-op after kill()', () => {
    const be = spawnBackend('5-5');
    be.kill();
    mockedExecFileSync.mockClear();
    be.sendText('after-exit');
    const call = herdrCall('pane', 'send-text');
    expect(call).toBeUndefined();
  });
});

// ─── Callbacks: onData delta + onExit ──────────────────────────────────────

describe('HerdrBackend callbacks', () => {
  it('onData fires with the prefix-delta when pane recent output grows', () => {
    let paneText = 'hello';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    vi.useFakeTimers();
    // Use an isReattach backend so the baseline is captured at spawn
    // (lastText = current pane content) — that mirrors the worker.ts
    // reattach contract, where the initial screen is seeded separately and
    // the data stream emits only deltas.
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    const snapshots: string[] = [];
    be.onData(d => seen.push(d));
    be.onSnapshot(frame => snapshots.push(frame));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    // Reattach captures the current screen as baseline → no immediate emit.
    expect(seen).toEqual([]);

    paneText = 'hello world';
    vi.advanceTimersByTime(600); // > POLL_INTERVAL_MS (500ms)
    expect(seen).toEqual([' world']);
    expect(snapshots).toEqual(['hello world']);

    paneText = 'hello world!';
    vi.advanceTimersByTime(600);
    expect(seen).toEqual([' world', '!']);
    expect(snapshots).toEqual(['hello world', 'hello world!']);

    be.kill();
  });

  it('onData fresh-spawn baseline: lastText starts empty so listeners see initial output', () => {
    // Counterpart to the reattach test: a fresh spawn keeps lastText='' so
    // listeners attached *before* spawn don't miss output the agent emitted
    // between agent-start and the first poll tick (the herdr-backend's
    // missing-initial-output bug we hit in the e2e run).
    let paneText = '';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => '' },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: '1-1' } } }),
      },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    vi.useFakeTimers();
    const be = new HerdrBackend(SESSION);
    const seen: string[] = [];
    be.onData(d => seen.push(d));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    paneText = 'HELLO_HERDR\n';
    vi.advanceTimersByTime(600);
    expect(seen.join('')).toBe('HELLO_HERDR\n');

    be.kill();
  });

  it('onExit fires when the agent disappears from `agent list`', () => {
    let agentAlive = true;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      {
        match: a => a.includes('agent') && a.includes('list'),
        reply: () => agentAlive
          ? AGENT_LIST_REPLY('1-1')
          : JSON.stringify({ result: { agents: [] } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);

    vi.useFakeTimers();
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    agentAlive = false;
    vi.advanceTimersByTime(600);
    expect(exits).toEqual([[0, null]]);
  });

  it('onExit fires when the agent stays in list with running:false (v0.6.6 tombstone)', () => {
    // herdr v0.6.6+ does NOT drop exited agents from `agent list` — they
    // stick around with running:false / status:"exited". Without this
    // detection the worker never sees the CLI exit → claude_exit never
    // fires → session hangs (the bug deepcoldy reported in PR #81).
    let agentRunning = true;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      {
        match: a => a.includes('agent') && a.includes('list'),
        reply: () => agentRunning
          ? AGENT_LIST_REPLY('1-1')
          : JSON.stringify({ result: { agents: [{ name: 'botmux', pane_id: '1-1', running: false, status: 'exited', exit_code: 7 }] } }),
      },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('') },
    ]);

    vi.useFakeTimers();
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    agentRunning = false;
    vi.advanceTimersByTime(600);
    // exit_code surfaces from the tombstone row so callers can distinguish
    // clean exits from crashes (mirrors the PTY backend's exit code path).
    expect(exits).toEqual([[7, null]]);
  });

  it('status watcher: one wait child per settled status (done/blocked/idle), first exit wins', () => {
    // Capture every fake `wait agent-status` child + its --status arg so the
    // test can drive a specific watcher's exit and verify the cohort
    // behaviour (first-to-fire reads, the rest get SIGTERM'd).
    const waitChildren: Array<{ status: string; child: FakeChild }> = [];
    mockedSpawn.mockImplementation(((_cmd: any, args: any) => {
      const child = makeFakeChild();
      const argv = args as string[];
      if (argv.includes('wait') && argv.includes('agent-status')) {
        const statusIdx = argv.indexOf('--status');
        waitChildren.push({ status: argv[statusIdx + 1]!, child });
      }
      return child;
    }) as any);

    let paneText = 'baseline';
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY(paneText) },
    ]);

    // Reattach so the baseline is captured at spawn — keeps the assertion
    // focused on "watcher exit triggers delta", not on the initial screen.
    const be = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    be.onData(d => seen.push(d));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    // Cohort = one watcher per settled status.
    const cohort = waitChildren.slice();
    expect(cohort.map(w => w.status).sort()).toEqual(['blocked', 'done', 'idle']);

    // Simulate the agent transitioning to `done` mid-turn — that watcher wins.
    paneText = 'baseline result';
    const doneWatcher = cohort.find(w => w.status === 'done')!;
    doneWatcher.child.emit('exit', 0, null);

    // The win triggered a read+emit.
    expect(seen).toEqual([' result']);

    // The two losing siblings got killed and a fresh cohort got armed.
    for (const w of cohort) {
      if (w !== doneWatcher) expect(w.child.killed).toBe(true);
    }
    const nextCohort = waitChildren.slice(cohort.length);
    expect(nextCohort.map(w => w.status).sort()).toEqual(['blocked', 'done', 'idle']);

    be.kill();
    // kill() tears down the live cohort.
    for (const w of nextCohort) expect(w.child.killed).toBe(true);
  });

  it('status watcher: instant non-zero exit on a vanished agent emits onExit and does NOT re-arm (storm guard)', () => {
    // Regression for the re-arm storm: on herdr v0.6.6 a `herdr wait
    // agent-status` against a dead pane returns code 1 IMMEDIATELY. The old
    // code re-armed synchronously on any non-0 code → a tight spawn loop that
    // starved the poll timer and the session hung. The fix: an instant
    // non-zero return triggers a liveness check; a vanished agent (empty
    // `agent list`) emits onExit instead of re-arming.
    const waitChildren: Array<{ status: string; child: FakeChild }> = [];
    mockedSpawn.mockImplementation(((_cmd: any, args: any) => {
      const child = makeFakeChild();
      const argv = args as string[];
      if (argv.includes('wait') && argv.includes('agent-status')) {
        const statusIdx = argv.indexOf('--status');
        waitChildren.push({ status: argv[statusIdx + 1]!, child });
      }
      return child;
    }) as any);

    // Agent present at spawn, then GONE (empty list) once it has exited.
    let agentGone = false;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('1-1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => agentGone ? JSON.stringify({ result: { agents: [] } }) : AGENT_LIST_REPLY('1-1') },
      { match: a => a.includes('read') && (a.includes('agent') || a.includes('pane')), reply: () => PANE_READ_REPLY('x') },
    ]);

    const be = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((code, signal) => exits.push([code, signal]));
    be.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    const cohort = waitChildren.slice();
    expect(cohort.length).toBe(3);

    // The agent has now exited; the next `wait` returns code 1 instantly.
    agentGone = true;
    cohort.find(w => w.status === 'done')!.child.emit('exit', 1, null);

    // onExit fired (storm guard saw the empty agent list)...
    expect(exits.length).toBe(1);
    // ...and NO fresh cohort was armed synchronously (the bug spun new ones).
    const nextCohort = waitChildren.slice(cohort.length);
    expect(nextCohort.length).toBe(0);

    be.kill();
  });
});
