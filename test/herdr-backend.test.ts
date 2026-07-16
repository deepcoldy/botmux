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
import { PassThrough } from 'node:stream';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execFileSync, spawn } from 'node:child_process';
import { HerdrBackend } from '../src/adapters/backend/herdr-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);

// ─── Helpers ───────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  killed = false;
  stdout = new PassThrough();
  unref = vi.fn();
  kill = vi.fn(() => { this.killed = true; return true; });
}

const fakeChildren: FakeChild[] = [];

function makeFakeChild(): FakeChild {
  const child = new FakeChild();
  fakeChildren.push(child);
  return child;
}


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
  fakeChildren.length = 0;
  // Every spawned process gets a fake child whose lifecycle the test controls.
  mockedSpawn.mockImplementation(() => makeFakeChild());
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Backend connection surface ────────────────────────────────────────────

describe('HerdrBackend connection surface', () => {
  it('isAvailable() requires Herdr 0.7.2 or newer', () => {
    mockedExecFileSync.mockReturnValue('herdr 0.7.2\n');
    expect(HerdrBackend.isAvailable()).toBe(true);
    mockedExecFileSync.mockReturnValue('herdr 0.7.1\n');
    expect(HerdrBackend.isAvailable()).toBe(false);
    const versionCall = mockedExecFileSync.mock.calls.find(c => (c[1] as string[]).includes('--version'));
    expect(versionCall).toBeDefined();
  });

  it('isAvailable() returns false when herdr binary is missing', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
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
  it('streams native terminal frames without pane polling or status waiters', async () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: 'w1:p1' } } }),
      },
    ]);

    const backend = new HerdrBackend(SESSION);
    const seen: string[] = [];
    backend.onData(data => seen.push(data));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('session') && args.includes('observe'));
    const observer = observerIndex >= 0 ? fakeChildren[observerIndex] : undefined;
    try {
      expect(observer).toBeDefined();
      expect(mockedSpawn.mock.calls.some(([, args]) =>
        Array.isArray(args) && args.includes('wait') && args.includes('agent-status'))).toBe(false);

      const first = JSON.stringify({
        type: 'terminal.frame', seq: 1, full: true, encoding: 'ansi', width: 80, height: 24,
        bytes: Buffer.from('\x1b[31mfirst\x1b[0m').toString('base64'),
      });
      const second = JSON.stringify({
        type: 'terminal.frame', seq: 2, full: false, encoding: 'ansi', width: 80, height: 24,
        bytes: Buffer.from(' second').toString('base64'),
      });

      observer!.stdout.write(first.slice(0, 17));
      observer!.stdout.write(`${first.slice(17)}\n${second}\n`);
      await waitForImmediate();
      expect(seen.join('')).toBe('\x1b[31mfirst\x1b[0m second');
      expect(herdrCall('agent', 'read')).toBeUndefined();
      backend.kill();
      expect(observer!.killed).toBe(true);
    } finally {
      if (!observer?.killed) backend.kill();
    }
  });

  it('delivers frames emitted before the first onData listener is registered', async () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: 'w1:p1' } } }),
      },
    ]);

    const backend = new HerdrBackend(SESSION);
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    fakeChildren[observerIndex]!.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 1, full: true, encoding: 'ansi', width: 80, height: 24,
      bytes: Buffer.from('early baseline').toString('base64'),
    })}\n`);
    await waitForImmediate();

    const seen: string[] = [];
    backend.onData(data => seen.push(data));
    expect(seen).toEqual(['early baseline']);
    backend.kill();
  });

  it('decodes one UTF-8 character split across consecutive terminal frames', async () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      {
        match: a => a.includes('agent') && a.includes('start'),
        reply: () => JSON.stringify({ result: { agent: { name: 'botmux', pane_id: 'w1:p1' } } }),
      },
    ]);

    const backend = new HerdrBackend(SESSION);
    const seen: string[] = [];
    backend.onData(data => seen.push(data));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    const observer = fakeChildren[observerIndex]!;
    const bytes = Buffer.from('你');

    observer.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 1, full: true, encoding: 'ansi', width: 80, height: 24,
      bytes: bytes.subarray(0, 2).toString('base64'),
    })}\n`);
    observer.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 2, full: false, encoding: 'ansi', width: 80, height: 24,
      bytes: bytes.subarray(2).toString('base64'),
    })}\n`);
    await waitForImmediate();

    expect(seen.join('')).toBe('你');
    expect(seen.join('')).not.toContain('�');
    backend.kill();
  });

  it('restarts a disconnected observer and forwards its full rebaseline before new deltas', async () => {
    vi.useFakeTimers();
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('w1:p1') },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    const exits: Array<[number | null, string | null]> = [];
    backend.onData(data => seen.push(data));
    backend.onExit((code, signal) => exits.push([code, signal]));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const firstObserverIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    const firstObserver = fakeChildren[firstObserverIndex]!;

    firstObserver.emit('exit', 1, null);
    expect(firstObserver.killed).toBe(true);
    firstObserver.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 99, full: false, encoding: 'ansi', width: 80, height: 24,
      bytes: Buffer.from('stale observer').toString('base64'),
    })}\n`);
    vi.advanceTimersByTime(500);

    const observerCalls = mockedSpawn.mock.calls.filter(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    expect(observerCalls).toHaveLength(2);
    const restartedObserver = fakeChildren.at(-1)!;
    restartedObserver.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 1, full: true, encoding: 'ansi', width: 80, height: 24,
      bytes: Buffer.from('reconnected baseline').toString('base64'),
    })}\n`);
    restartedObserver.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 2, full: false, encoding: 'ansi', width: 80, height: 24,
      bytes: Buffer.from(' delta').toString('base64'),
    })}\n`);
    await vi.runAllTicks();

    expect(seen.join('')).toBe('reconnected baseline delta');
    expect(exits).toEqual([]);
    backend.kill();
  });
  it('kill cancels a pending observer restart', () => {
    vi.useFakeTimers();
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
      { match: a => a.includes('agent') && a.includes('list'), reply: () => AGENT_LIST_REPLY('w1:p1') },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    backend.onExit((code, signal) => exits.push([code, signal]));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    fakeChildren[observerIndex]!.emit('exit', 1, null);

    backend.kill();
    vi.advanceTimersByTime(500);

    const observerCalls = mockedSpawn.mock.calls.filter(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    expect(observerCalls).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  it('reattach forwards the observer full frame before ordered incremental frames', async () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    backend.onData(data => seen.push(data));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });

    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('session') && args.includes('observe'));
    const observer = observerIndex >= 0 ? fakeChildren[observerIndex] : undefined;
    try {
      expect(observer).toBeDefined();
      for (const frame of [
        { seq: 1, full: true, text: 'reattached screen' },
        { seq: 2, full: false, text: ' delta' },
        { seq: 2, full: false, text: ' duplicate' },
        { seq: 1, full: false, text: ' stale' },
        { seq: 3, full: false, text: ' done' },
      ]) {
        observer!.stdout.write(`${JSON.stringify({
          type: 'terminal.frame', seq: frame.seq, full: frame.full, encoding: 'ansi', width: 80, height: 24,
          bytes: Buffer.from(frame.text).toString('base64'),
        })}\n`);
      }
      await waitForImmediate();
      expect(seen.join('')).toBe('reattached screen delta done');
      expect(herdrCall('agent', 'read')).toBeUndefined();
      backend.kill();
      expect(observer!.killed).toBe(true);
    } finally {
      if (!observer?.killed) backend.kill();
    }
  });

  it('terminal.closed emits onExit when the observed agent disappeared', async () => {
    let agentAlive = true;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
      {
        match: a => a.includes('agent') && a.includes('list'),
        reply: () => agentAlive ? AGENT_LIST_REPLY('w1:p1') : JSON.stringify({ result: { agents: [] } }),
      },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    backend.onExit((code, signal) => exits.push([code, signal]));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    const observer = fakeChildren[observerIndex]!;

    agentAlive = false;
    observer.stdout.write(`${JSON.stringify({ type: 'terminal.closed', reason: 'pane exited' })}\n`);
    await waitForImmediate();
    expect(exits).toEqual([[0, null]]);
  });

  it('terminal.closed preserves an explicit agent exit code', async () => {
    let agentRunning = true;
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
      {
        match: a => a.includes('agent') && a.includes('list'),
        reply: () => agentRunning
          ? AGENT_LIST_REPLY('w1:p1')
          : JSON.stringify({ result: { agents: [{ name: 'botmux', pane_id: 'w1:p1', running: false, status: 'exited', exit_code: 7 }] } }),
      },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const exits: Array<[number | null, string | null]> = [];
    backend.onExit((code, signal) => exits.push([code, signal]));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const observerIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));

    agentRunning = false;
    fakeChildren[observerIndex]!.stdout.write(`${JSON.stringify({ type: 'terminal.closed' })}\n`);
    await waitForImmediate();
    expect(exits).toEqual([[7, null]]);
  });


  it('resize replaces the observer and forwards its full rebaseline frame', async () => {
    setHerdrResponses([
      { match: a => a[0] === 'session' && a[1] === 'list', reply: () => EXISTING_SESSION_REPLY },
      { match: a => a.includes('agent') && a.includes('get'), reply: () => AGENT_GET_REPLY('w1:p1') },
    ]);

    const backend = new HerdrBackend(SESSION, { isReattach: true });
    const seen: string[] = [];
    backend.onData(data => seen.push(data));
    backend.spawn('claude', [], { cwd: '/work', cols: 80, rows: 24, env: {} });
    const firstIndex = mockedSpawn.mock.calls.findIndex(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    const firstObserver = fakeChildren[firstIndex]!;

    backend.resize(120, 40);
    expect(firstObserver.killed).toBe(true);
    const observerCalls = mockedSpawn.mock.calls.filter(([, args]) =>
      Array.isArray(args) && args.includes('terminal') && args.includes('observe'));
    const resizedArgs = observerCalls.at(-1)?.[1];
    expect(resizedArgs).toContain('120');
    expect(resizedArgs).toContain('40');
    const resizedObserver = fakeChildren.at(-1)!;
    resizedObserver.stdout.write(`${JSON.stringify({
      type: 'terminal.frame', seq: 1, full: true, encoding: 'ansi', width: 120, height: 40,
      bytes: Buffer.from('resized baseline').toString('base64'),
    })}\n`);
    await waitForImmediate();
    expect(seen).toEqual(['resized baseline']);
    backend.kill();
  });
});
