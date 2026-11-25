import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  killHcTerminal,
  listBotmuxHcTerminals,
  probeHcTerminal,
  type HcTarget,
} from '../src/adapters/backend/hc/cli-ops.js';
import {
  ensureHcCore,
  hcControlEnv,
  hcCoreAddress,
  hcCorePaths,
  queryHcCoreStatus,
  type HcCorePaths,
  type HcCoreStatus,
} from '../src/adapters/backend/hc/core.js';
import { prepareHcSyncCore } from '../src/adapters/backend/hc/sync-rpc.js';
import {
  HC_MIN_VERSION,
  compareHcVersion,
  parseHcSemver,
  resetHcAvailabilityCache,
} from '../src/setup/ensure-hc.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const realHc = process.env.BOTMUX_HC_TEST_BIN;

function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return new Promise(done => child.on('close', code => done({ code, stdout, stderr })));
}

describe.skipIf(!realHc)('hc core and CLI operations against the real binary', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let paths: HcCorePaths;

  beforeAll(() => {
    if (!process.env.BOTMUX_HC_BIN) throw new Error('the hc test fence did not set BOTMUX_HC_BIN');
    root = mkdtempSync(join(tmpdir(), 'bm-hc-real-'));
    env = {
      ...process.env,
      SESSION_DATA_DIR: join(root, 'botmux', 'data'),
      XDG_STATE_HOME: join(root, 'state'),
    };
    paths = hcCorePaths(env);
    resetHcAvailabilityCache();
  });

  afterAll(() => {
    if (env?.BOTMUX_HC_BIN) hc(['server', 'stop']);
    resetHcAvailabilityCache();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function hc(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(env.BOTMUX_HC_BIN!, args, {
      env: hcControlEnv(env),
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function newName(): string {
    return `bmx-${randomBytes(4).toString('hex')}`;
  }

  function runTerminal(name: string, labels: Record<string, string>, argv: string[]): string {
    const result = hc([
      '--json', 'run', '--bg', '--name', name,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '--no-parent', '--no-notify', '--', ...argv,
    ]);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).address;
  }

  async function waitFinished(name: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = hc(['--json', 'get', name]);
      if (result.status === 0 && JSON.parse(result.stdout).state === 'finished') return;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error(`${name} did not finish`);
  }

  function targetFor(name: string): HcTarget {
    return { backendType: 'hc', sessionName: name, hcSession: paths.session, socket: paths.socket };
  }

  function ownedBy(sessionId: string): Record<string, string> {
    return { botmux: '1', botmux_sid: sessionId };
  }

  it('starts one core for concurrent callers, from the control env', async () => {
    const [first, second] = await Promise.all([ensureHcCore({ env }), ensureHcCore({ env })]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ socket: paths.socket, session: paths.session, started: true });
    expect(compareHcVersion(parseHcSemver(first.version)!, HC_MIN_VERSION)).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(paths.configHome, 'herdr-core', 'config.toml'))).toBe(true);
    await expect(queryHcCoreStatus(paths.socket)).resolves.toMatchObject({ state: 'running', pid: first.pid });

    // `hc exec` runs with the core's environment on both Linux and macOS.
    const result = hc(['exec', '--', '/usr/bin/env']);
    expect(result.status, result.stderr).toBe(0);
    const coreEnv = new Map(result.stdout.split('\n').filter(entry => entry.includes('='))
      .map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    expect(coreEnv.get('HC_SOCKET')).toBe(paths.socket);
    expect(coreEnv.get('XDG_CONFIG_HOME')).toBe(paths.configHome);
    expect(coreEnv.get('XDG_STATE_HOME')).toBe(paths.stateHome);
    expect([...coreEnv.keys()].filter(key =>
      key.startsWith('BOTMUX') || key === 'SESSION_DATA_DIR' || key === 'HC_TERMINAL_ID',
    )).toEqual([]);

    await expect(ensureHcCore({ env })).resolves.toMatchObject({ pid: first.pid, started: false });
  });

  it.runIf(process.platform === 'darwin')('preserves a file obstructing the macOS socket before sync startup', () => {
    const blocked = hcCorePaths({ ...env, SESSION_DATA_DIR: join(root, 'data'), XDG_RUNTIME_DIR: undefined });
    mkdirSync(join(root, 'hc'));
    writeFileSync(blocked.socket, 'keep this file');

    expect(() => prepareHcSyncCore(hcCoreAddress(blocked), env)).toThrow(/非 socket/);
    expect(readFileSync(blocked.socket, 'utf8')).toBe('keep this file');
  });

  it('lets several processes start the core at once and agree on it', async () => {
    const stopped = hc(['--json', 'server', 'stop']);
    expect(stopped.status, stopped.stderr).toBe(0);
    await expect(queryHcCoreStatus(paths.socket)).resolves.toMatchObject({ state: 'absent' });

    const coreUrl = pathToFileURL(resolve('src/adapters/backend/hc/core.ts')).href;
    const children = Array.from({ length: 3 }, () => spawnTsEvalWithRepoImports(`
      import { ensureHcCore } from ${JSON.stringify(coreUrl)};
      process.stdout.write(JSON.stringify(await ensureHcCore()));
    `, { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    const results = await Promise.all(children.map(collect));

    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const statuses = results.map(result => JSON.parse(result.stdout) as HcCoreStatus);
    expect(new Set(statuses.map(status => status.pid)).size).toBe(1);
    expect(statuses.some(status => status.started)).toBe(true);
    await expect(queryHcCoreStatus(paths.socket)).resolves.toMatchObject({ state: 'running', pid: statuses[0].pid });
  }, 90_000);

  it('probes live, finished and unknown names', async () => {
    const live = newName();
    const finished = newName();
    runTerminal(live, ownedBy('sid-live'), ['sleep', '600']);
    runTerminal(finished, ownedBy('sid-finished'), ['true']);
    await waitFinished(finished);

    expect(probeHcTerminal(targetFor(live), { env })).toBe('exists');
    expect(probeHcTerminal(targetFor(finished), { env })).toBe('missing');
    expect(probeHcTerminal(targetFor(newName()), { env })).toBe('missing');
  });

  it('refuses to kill a terminal of another session', () => {
    const name = newName();
    runTerminal(name, ownedBy('sid-owner'), ['sleep', '600']);

    expect(killHcTerminal(targetFor(name), 'sid-intruder', { env })).toMatchObject({
      result: 'mismatch',
      owner: 'sid-owner',
    });
    expect(probeHcTerminal(targetFor(name), { env })).toBe('exists');
  });

  it('kills and removes this session\'s terminals, live or finished', async () => {
    const live = newName();
    const finished = newName();
    const liveAddress = runTerminal(live, ownedBy('sid-a'), ['sh', '-c', 'trap "" HUP TERM; while :; do sleep 1; done']);
    const finishedAddress = runTerminal(finished, ownedBy('sid-b'), ['true']);
    await waitFinished(finished);

    expect(killHcTerminal(targetFor(live), 'sid-a', { env })).toEqual({ result: 'killed', address: liveAddress });
    expect(killHcTerminal(targetFor(finished), 'sid-b', { env })).toEqual({ result: 'removed', address: finishedAddress });
    expect(hc(['--json', 'get', live]).status).not.toBe(0);
    expect(hc(['--json', 'get', finished]).status).not.toBe(0);
    expect(killHcTerminal(targetFor(live), 'sid-a', { env })).toEqual({ result: 'missing' });
  });

  it('lists only botmux terminals, finished ones included', async () => {
    const labelled = newName();
    const done = newName();
    const plain = newName();
    runTerminal(labelled, ownedBy('sid-list'), ['sleep', '600']);
    runTerminal(done, ownedBy('sid-done'), ['sh', '-c', 'exit 7']);
    runTerminal(plain, {}, ['sleep', '600']);
    await waitFinished(done);

    const listing = listBotmuxHcTerminals(undefined, { env });

    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const byName = new Map(listing.terminals.map(entry => [entry.name, entry]));
    expect(byName.get(labelled)).toMatchObject({ sessionId: 'sid-list', state: 'live' });
    expect(byName.get(done)).toMatchObject({ sessionId: 'sid-done', state: 'finished', exitCode: 7 });
    expect(byName.has(plain)).toBe(false);
  });
});

describe.skipIf(!realHc)('one botmux core per socket against the real binary', () => {
  let base: string;
  let envA: NodeJS.ProcessEnv;
  let pidA: number | undefined;

  function socketOf(pid: number): string | undefined {
    try {
      const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(item => item.startsWith('HC_SOCKET='));
      return entry?.slice('HC_SOCKET='.length);
    } catch {
      return undefined;
    }
  }

  beforeAll(() => {
    if (!process.env.BOTMUX_HC_BIN || !process.env.XDG_RUNTIME_DIR) throw new Error('the hc test fence did not run');
    // Its own runtime dir: were the state dir not pinned, the second core would
    // take over this socket instead of the one the other tests share.
    base = mkdtempSync(join(process.env.XDG_RUNTIME_DIR, 'one-'));
    mkdirSync(join(base, 'run'));
    envA = {
      ...process.env,
      XDG_RUNTIME_DIR: join(base, 'run'),
      HOME: join(base, 'a'),
      XDG_STATE_HOME: join(base, 'a', 'state'),
      SESSION_DATA_DIR: join(base, 'a', 'data'),
    };
    resetHcAvailabilityCache();
  });

  afterAll(() => {
    if (envA?.BOTMUX_HC_BIN) {
      spawnSync(envA.BOTMUX_HC_BIN, ['server', 'stop'], { env: hcControlEnv(envA), cwd: base, stdio: 'ignore', timeout: 20_000 });
    }
    if (pidA !== undefined && socketOf(pidA) === hcCorePaths(envA).socket) process.kill(pidA, 'SIGKILL');
    resetHcAvailabilityCache();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('keeps a core started from another daemon\'s HOME, XDG_STATE_HOME and data root off a running core\'s socket', async () => {
    const first = await ensureHcCore({ env: envA });
    pidA = first.pid;
    const envB: NodeJS.ProcessEnv = {
      ...envA,
      HOME: join(base, 'b'),
      XDG_STATE_HOME: join(base, 'b', 'state'),
      SESSION_DATA_DIR: join(base, 'b', 'data'),
    };
    expect(hcCorePaths(envB).socket).toBe(first.socket);

    const second = spawnSync(envB.BOTMUX_HC_BIN!, ['serve'], {
      env: hcControlEnv(envB),
      cwd: base,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });

    expect(second.signal, second.stderr).toBeNull();
    expect(second.status, second.stderr).toBe(0);
    await expect(queryHcCoreStatus(first.socket)).resolves.toMatchObject({ state: 'running', pid: first.pid });
  }, 60_000);
});
