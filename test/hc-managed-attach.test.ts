/**
 * hc managed attach (`botmux list` Enter and the Dashboard's local attach
 * command): only a live terminal whose labels name the session is attached, by
 * its address, on the core the row recorded; a missing core is never started.
 *
 * Run:  BOTMUX_HC_TEST_BIN=<herdr-core> npx vitest run --project unit test/hc-managed-attach.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import {
  ensureHcCore,
  hcControlEnv,
  hcCoreAddress,
  hcCorePaths,
  type HcCoreAddress,
} from '../src/adapters/backend/hc/core.js';
import type { HcTerminalRecord } from '../src/adapters/backend/hc/types.js';
import {
  lookupHcTerminal,
  prepareManagedHcAttach,
  runManagedHcAttach,
  type HcTerminalLookup,
} from '../src/cli/hc-managed-attach.js';
import { resetHcAvailabilityCache } from '../src/setup/ensure-hc.js';

const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const NAME = 'bmx-0a1b2c3d';

function record(overrides: Partial<HcTerminalRecord> = {}): HcTerminalRecord {
  return {
    address: 't7',
    name: NAME,
    labels: { botmux: '1', botmux_sid: SID },
    argv: ['claude'],
    cwd: '/tmp',
    keep: false,
    state: 'live',
    pid: 4242,
    exit_code: null,
    signal: null,
    reason: null,
    created_ms: 0,
    finished_ms: null,
    screen: 'exact',
    ...overrides,
  } as HcTerminalRecord;
}

describe('prepareManagedHcAttach', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let target: HcTarget;

  beforeAll(() => {
    dir = mkdtempSync('/tmp/bmhca-');
    mkdirSync(join(dir, 'bin'));
    const bin = join(dir, 'bin', 'herdr-core');
    writeFileSync(bin, "#!/bin/sh\necho 'hc 0.1.19'\n", { mode: 0o755 });
    env = { ...process.env, BOTMUX_HC_BIN: bin };
    target = { backendType: 'hc', sessionName: NAME, hcSession: 'botmux', socket: join(dir, 'herdr-core', 'botmux.sock') };
  });

  afterAll(() => {
    resetHcAvailabilityCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function lookupReturning(result: HcTerminalLookup) {
    return vi.fn(async (_socket: string, _name: string) => result);
  }

  it('plans an attach to the owned live terminal by address, pinned to the recorded core', async () => {
    const lookup = lookupReturning({ state: 'found', record: record() });
    const plan = await prepareManagedHcAttach(target, SID, { env, lookup });

    expect(lookup).toHaveBeenCalledWith(target.socket, NAME);
    expect(plan).toMatchObject({ ok: true, bin: env.BOTMUX_HC_BIN, address: 't7' });
    if (!plan.ok) return;
    expect(plan.env.HC_SESSION).toBe('botmux');
    expect(plan.env.HC_SOCKET).toBe(target.socket);
    // hc starts a core only after creating its state dir.
    expect(() => mkdirSync(plan.env.XDG_STATE_HOME!, { recursive: true })).toThrow();
  });

  it('refuses a terminal whose labels belong to another session', async () => {
    const other = '0a1b2c3d-0000-4000-8000-000000000000';
    const plan = await prepareManagedHcAttach(target, SID, {
      env,
      lookup: lookupReturning({ state: 'found', record: record({ labels: { botmux: '1', botmux_sid: other } }) }),
    });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.message).toContain('所有权标签');
  });

  it('refuses a terminal without the botmux label even when the sid label matches', async () => {
    const plan = await prepareManagedHcAttach(target, SID, {
      env,
      lookup: lookupReturning({ state: 'found', record: record({ labels: { botmux_sid: SID } }) }),
    });
    expect(plan.ok).toBe(false);
  });

  it('refuses a finished terminal', async () => {
    const plan = await prepareManagedHcAttach(target, SID, {
      env,
      lookup: lookupReturning({ state: 'found', record: record({ state: 'finished', pid: null }) }),
    });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.message).toContain('已结束');
  });

  it.each([
    ['another name', { name: 'bmx-ffffffff' }],
    ['a path-like address', { address: '../t7' }],
    ['no address', { address: undefined as unknown as string }],
  ])('refuses a record with %s', async (_label, overrides) => {
    const plan = await prepareManagedHcAttach(target, SID, {
      env,
      lookup: lookupReturning({ state: 'found', record: record(overrides) }),
    });
    expect(plan.ok).toBe(false);
  });

  it.each([
    [{ state: 'missing' } as HcTerminalLookup, '已不存在'],
    [{ state: 'absent', reason: 'ECONNREFUSED' } as HcTerminalLookup, '不会替它启动'],
    [{ state: 'unknown', reason: 'timeout' } as HcTerminalLookup, 'timeout'],
  ])('refuses when the lookup reports %o', async (result, text) => {
    const plan = await prepareManagedHcAttach(target, SID, { env, lookup: lookupReturning(result) });
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.message).toContain(text);
  });

  it('refuses without asking any core when no usable hc binary is found', async () => {
    const lookup = lookupReturning({ state: 'found', record: record() });
    const plan = await prepareManagedHcAttach(target, SID, {
      env: { ...env, BOTMUX_HC_BIN: join(dir, 'missing-herdr-core') },
      lookup,
    });
    expect(plan.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses without asking any core when the recorded runtime dir is gone', async () => {
    const lookup = lookupReturning({ state: 'found', record: record() });
    const plan = await prepareManagedHcAttach(
      { ...target, socket: join(dir, 'gone', 'herdr-core', 'botmux.sock') },
      SID,
      { env, lookup },
    );
    expect(plan.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'gone'))).toBe(false);
  });

  it('refuses a row without a recorded socket or complete session id', async () => {
    const lookup = lookupReturning({ state: 'found', record: record() });
    expect((await prepareManagedHcAttach({ ...target, socket: '' }, SID, { env, lookup })).ok).toBe(false);
    expect((await prepareManagedHcAttach(target, '', { env, lookup })).ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('runManagedHcAttach', () => {
  const plan = {
    ok: true as const, bin: '/opt/hc/herdr-core', address: 't7', env: { HC_SESSION: 'botmux' }, sessionId: SID,
    target: { backendType: 'hc' as const, sessionName: NAME, hcSession: 'botmux', socket: '/run/hc/botmux.sock' },
  };
  const platform = 'linux' as const;

  it('attaches to the planned address with the planned env', async () => {
    const attach = vi.fn(() => ({ status: 0 }));
    await expect(runManagedHcAttach(plan, { attach, platform })).resolves.toEqual({ ok: true });
    expect(attach).toHaveBeenCalledWith('/opt/hc/herdr-core', 't7', plan.env);
  });

  it('reports a failed or unstartable attach', async () => {
    await expect(runManagedHcAttach(plan, { platform, attach: () => ({ status: 1 }) })).resolves.toMatchObject({ ok: false });
    await expect(runManagedHcAttach(plan, { platform, attach: () => ({ status: null, error: new Error('EACCES') }) })).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('EACCES'),
    });
  });
});

const realHc = process.env.BOTMUX_HC_TEST_BIN;

describe.skipIf(!realHc)('prepareManagedHcAttach against the real binary', () => {
  let root: string;
  let home: HcCoreAddress;

  beforeAll(async () => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    root = mkdtempSync(join(tmpdir(), 'bm-hc-attach-'));
    resetHcAvailabilityCache();
    home = hcCoreAddress(hcCorePaths(process.env));
    await ensureHcCore();
  }, 60_000);

  afterAll(() => {
    if (home) hc(home, ['server', 'stop']);
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => resetHcAvailabilityCache());

  function hc(core: HcCoreAddress, args: string[], env = hcControlEnv(process.env, hcCorePaths(process.env, { core }))) {
    const result = spawnSync(process.env.BOTMUX_HC_BIN!, args, { env, cwd: root, encoding: 'utf8', timeout: 20_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function runTerminal(name: string, sessionId: string, argv: string[], core = home): void {
    const result = hc(core, [
      '--json', 'run', '--bg', '--name', name,
      '--label', 'botmux=1', '--label', `botmux_sid=${sessionId}`,
      '--no-parent', '--no-notify', '--', ...argv,
    ]);
    expect(result.status, result.stderr).toBe(0);
  }

  function get(name: string, core = home): { address: string; name: string; state: string; pid: number } {
    const result = hc(core, ['--json', 'get', name]);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  const on = (sessionName: string): HcTarget => ({ backendType: 'hc', sessionName, ...home });

  it('plans the owned terminal\'s address, and the planned env reaches the core holding it', async () => {
    const sid = randomUUID();
    const name = `bmx-${sid.slice(0, 8)}`;
    runTerminal(name, sid, ['sleep', '600']);

    const plan = await prepareManagedHcAttach(on(name), sid);

    expect(plan).toMatchObject({ ok: true, address: get(name).address });
    if (!plan.ok) return;
    const seen = hc(home, ['--json', 'get', plan.address], plan.env);
    expect(seen.status, seen.stderr).toBe(0);
    expect(JSON.parse(seen.stdout).name).toBe(name);
  });

  it.runIf(process.platform === 'darwin')('checks the pinned socket and keeps it when the original path switches cores', async () => {
    const origin = { hcSession: 'origin', socket: join(dirname(home.socket), 'origin.sock') };
    const foreign = { hcSession: 'foreign', socket: join(dirname(home.socket), 'foreign.sock') };
    const parked = join(dirname(home.socket), 'parked.sock');
    try {
      await ensureHcCore({ core: origin });
      await ensureHcCore({ core: foreign });
      runTerminal(NAME, SID, ['sleep', '600'], origin);
      runTerminal(NAME, randomUUID(), ['sleep', '600'], foreign);
      const original = get(NAME, origin);
      expect(get(NAME, foreign)).toMatchObject({ address: original.address });
      const plan = await prepareManagedHcAttach({ backendType: 'hc', sessionName: NAME, ...origin }, SID);
      if (!plan.ok) throw new Error(plan.message);

      function replaceSocket(): () => void {
        renameSync(origin.socket, parked);
        linkSync(foreign.socket, origin.socket);
        return () => {
          rmSync(origin.socket);
          renameSync(parked, origin.socket);
        };
      }

      let restore = replaceSocket();
      const reject = vi.fn(() => ({ status: 0 }));
      try {
        await expect(runManagedHcAttach(plan, { attach: reject })).resolves.toMatchObject({ ok: false });
        expect(reject).not.toHaveBeenCalled();
      } finally {
        restore();
      }

      const attach = vi.fn((_bin: string, address: string, env: NodeJS.ProcessEnv) => {
        restore = replaceSocket();
        try {
          const reached = hc(origin, ['--json', 'get', address], env);
          expect(reached.status, reached.stderr).toBe(0);
          expect(JSON.parse(reached.stdout).pid).toBe(original.pid);
          return { status: 0 };
        } finally {
          restore();
        }
      });
      await expect(runManagedHcAttach(plan, { attach })).resolves.toEqual({ ok: true });
      expect(attach).toHaveBeenCalledOnce();
      expect(existsSync(attach.mock.calls[0]![2].HC_SOCKET!)).toBe(false);
    } finally {
      hc(origin, ['server', 'stop']);
      hc(foreign, ['server', 'stop']);
    }
  }, 60_000);

  it('the planned env cannot start a core when the recorded one stops before hc connects', async () => {
    const sid = randomUUID();
    const name = `bmx-${sid.slice(0, 8)}`;
    const stopping: HcCoreAddress = { hcSession: 'stopping', socket: join(dirname(home.socket), 'stopping.sock') };
    await ensureHcCore({ core: stopping });
    const run = hc(stopping, [
      '--json', 'run', '--bg', '--name', name, '--label', 'botmux=1', '--label', `botmux_sid=${sid}`,
      '--no-parent', '--no-notify', '--', 'sleep', '600',
    ]);
    expect(run.status, run.stderr).toBe(0);
    const plan = await prepareManagedHcAttach({ backendType: 'hc', sessionName: name, ...stopping }, sid);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const stopped = hc(stopping, ['server', 'stop']);
    expect(stopped.status, stopped.stderr).toBe(0);

    const tried = hc(stopping, ['--json', 'ls'], plan.env);
    const answering = (await lookupHcTerminal(stopping.socket, name)).state !== 'absent';
    if (answering) hc(stopping, ['server', 'stop']);

    expect(tried.status).not.toBe(0);
    expect(answering).toBe(false);
  });

  it('refuses a same-named terminal another session holds and leaves it running', async () => {
    const sid = randomUUID();
    const holder = `${sid.slice(0, 8)}-0000-4000-8000-000000000000`;
    const name = `bmx-${sid.slice(0, 8)}`;
    runTerminal(name, holder, ['sleep', '600']);

    const plan = await prepareManagedHcAttach(on(name), sid);

    expect(plan).toMatchObject({ ok: false, message: expect.stringContaining('所有权标签') });
    expect(get(name).state).toBe('live');
  });

  it('refuses a finished terminal and a name the core does not hold', async () => {
    const sid = randomUUID();
    const name = `bmx-${sid.slice(0, 8)}`;
    runTerminal(name, sid, ['true']);
    const deadline = Date.now() + 10_000;
    while (get(name).state !== 'finished') {
      if (Date.now() > deadline) throw new Error(`${name} did not finish`);
      await new Promise(done => setTimeout(done, 100));
    }

    expect(await prepareManagedHcAttach(on(name), sid)).toMatchObject({ ok: false, message: expect.stringContaining('已结束') });
    const absentSid = randomUUID();
    expect(await prepareManagedHcAttach(on(`bmx-${absentSid.slice(0, 8)}`), absentSid))
      .toMatchObject({ ok: false, message: expect.stringContaining('已不存在') });
  });

  it('refuses when nothing serves the recorded socket, and starts no core there', async () => {
    const socket = join(dirname(home.socket), 'nocore.sock');
    const sid = randomUUID();

    expect(await lookupHcTerminal(socket, `bmx-${sid.slice(0, 8)}`)).toMatchObject({ state: 'absent' });
    const plan = await prepareManagedHcAttach(
      { backendType: 'hc', sessionName: `bmx-${sid.slice(0, 8)}`, hcSession: 'nocore', socket },
      sid,
    );

    expect(plan).toMatchObject({ ok: false, message: expect.stringContaining('不会替它启动') });
    expect(existsSync(socket)).toBe(false);
  });
});
