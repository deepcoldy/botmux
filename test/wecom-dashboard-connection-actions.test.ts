/**
 * The Dashboard as a client of the fleet for WeCom connections: it starts,
 * stops and restarts them only by running `botmux wecom <action> <id> --json`,
 * answers before that command finishes, allows one action per connection at a
 * time, and shows a failed action until the next action or a state change. Also
 * the two Dashboard-side choices around a new connection: where its managed
 * core's port comes from, and which environment the configuration page shows.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WecomDashboardManager } from '../src/dashboard/wecom/manager.js';
import {
  parseWecomLifecycleOutput,
  runWecomLifecycleCli,
  WECOM_LIFECYCLE_CLI_TIMEOUT_MS,
  type WecomLifecycleOutcome,
} from '../src/dashboard/wecom/lifecycle-cli.js';
import { allocateWecomCorePort, hostEphemeralPortRange, WECOM_CORE_PORT_RANGE } from '../src/dashboard/wecom/onboarding.js';
import { WecomDashboardConfig, wecomFleetMemberEnvironment } from '../src/dashboard/wecom/config.js';
import { registerWecomConfig, wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { setWecomFleetDesiredState, setWecomFleetDesiredStopped } from '../src/im/wecom/config/fleet-desired-state.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import type { FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import type { FleetProcState, FleetState } from '../src/core/fleet-supervisor-policy.js';
import { FLEET_MEMBER_START_WAIT_MS, FLEET_MEMBER_STOP_WAIT_MS } from '../src/core/fleet-runtime.js';
import { WECOM_LIFECYCLE_LOCK_WAIT_MS, WECOM_START_SETTLE_MS } from '../src/im/wecom/contract/lifecycle-budgets.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise(done => server.close(done));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('reading the result of `botmux wecom <action> --json`', () => {
  it('takes the last line as the result and keeps the fields the Dashboard shows', () => {
    const line = JSON.stringify({
      ok: false, reason: 'gateway_exited', configId: 'x', member: 'wecom-x', message: 'detail', desired: 'stopped', stopReason: 'replaced',
    });
    expect(parseWecomLifecycleOutput({ stdout: `… waiting\n${line}\n`, stderr: '', code: 1 })).toEqual({
      ok: false, reason: 'gateway_exited', message: 'detail', desired: 'stopped', stopReason: 'replaced',
    });
    expect(parseWecomLifecycleOutput({ stdout: JSON.stringify({ ok: true, state: 'started', message: 'm', desired: 'running' }), stderr: '', code: 0 }))
      .toEqual({ ok: true, state: 'started', message: 'm', desired: 'running' });
  });

  it('tells a command that printed no result apart from one that failed without one', () => {
    expect(parseWecomLifecycleOutput({ stdout: 'help text', stderr: '', code: 0 })).toMatchObject({ ok: false, reason: 'cli_output_invalid' });
    const failed = parseWecomLifecycleOutput({ stdout: '', stderr: 'line 1\nfixture-crash', code: 1 });
    expect(failed).toMatchObject({ ok: false, reason: 'cli_failed' });
    expect(failed.message).toContain('fixture-crash');
  });

  it('does not accept a result line whose ok is not a boolean', () => {
    expect(parseWecomLifecycleOutput({ stdout: JSON.stringify({ ok: 'true', message: 'm' }), stderr: '', code: 0 }))
      .toMatchObject({ ok: false, reason: 'cli_output_invalid' });
  });

  it('does not pass on a reason or stop reason it does not recognise', () => {
    const outcome = parseWecomLifecycleOutput({
      stdout: JSON.stringify({ ok: false, reason: '<script>', message: 'm', stopReason: 'made-up' }), stderr: '', code: 1,
    });
    expect(outcome.reason).toBe('cli_failed');
    expect(outcome.stopReason).toBeUndefined();
  });
});

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  return child;
}

describe('running the command', () => {
  it('runs exactly `wecom <action> <configId> --json`, attached, without the Dashboard\'s H5 credentials', async () => {
    const child = fakeChild();
    const spawn = vi.fn((_command: string, _args: string[], _options: any) => child);
    const id = 'c'.repeat(64);
    const running = runWecomLifecycleCli('restart', id, {
      spawn: spawn as any,
      env: { PATH: '/usr/bin', BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'fixture-h5-secret' },
    });
    child.stdout!.write(`${JSON.stringify({ ok: true, state: 'restarted', message: 'done' })}\n`);
    setImmediate(() => child.emit('close', 0));
    expect(await running).toEqual({ ok: true, state: 'restarted', message: 'done' });
    const [, args, options] = spawn.mock.calls[0];
    expect(args.slice(-4)).toEqual(['wecom', 'restart', id, '--json']);
    expect(options.env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBeUndefined();
    expect(options.env.PATH).toBe('/usr/bin');
    expect(options.detached).not.toBe(true);
  });

  it('tells the caller the command\'s pid as soon as it is spawned, before it answers', async () => {
    const child = fakeChild();
    Object.assign(child, { pid: 4242 });
    const pids: number[] = [];
    const running = runWecomLifecycleCli('start', 'c'.repeat(64), { spawn: (() => child) as any, onSpawn: pid => pids.push(pid) });
    expect(pids).toEqual([4242]);
    child.stdout!.write(`${JSON.stringify({ ok: true, state: 'started', message: 'm' })}\n`);
    setImmediate(() => child.emit('close', 0));
    await running;
    expect(pids).toEqual([4242]);
  });

  // Mutation: decoding each output chunk on its own (String(chunk)) garbles a character split between two chunks and turns this red.
  it('reads characters that arrive split across output chunks, and the result line after much more output than it keeps', async () => {
    const inChunks = (stream: PassThrough, text: string, size: number) => {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += size) stream.write(bytes.subarray(i, i + size));
      stream.end();
    };
    const closeAfter = (child: ReturnType<typeof fakeChild>, stream: 'stdout' | 'stderr', code: number) => {
      child[stream]!.once('end', () => child.emit('close', code));
      child[stream]!.resume();
    };
    const message = '企业微信连接已启动，配置已生效';
    const started = fakeChild();
    const running = runWecomLifecycleCli('start', 'c'.repeat(64), { spawn: (() => started) as any });
    started.stdout!.write(Buffer.from('等待中…\n'.repeat(40_000)));
    closeAfter(started, 'stdout', 0);
    inChunks(started.stdout as PassThrough, `${JSON.stringify({ ok: true, state: 'started', message })}\n`, 5);
    expect(await running).toEqual({ ok: true, state: 'started', message });

    const failed = fakeChild();
    const failing = runWecomLifecycleCli('start', 'c'.repeat(64), { spawn: (() => failed) as any });
    closeAfter(failed, 'stderr', 1);
    inChunks(failed.stderr as PassThrough, '启动失败：端口被占用\n', 2);
    expect(await failing).toMatchObject({ ok: false, reason: 'cli_failed', message: '启动失败：端口被占用' });
  });

  it('reports a command that cannot be run', async () => {
    const thrown = await runWecomLifecycleCli('start', 'c'.repeat(64), { spawn: (() => { throw new Error('ENOENT fixture'); }) as any });
    expect(thrown).toMatchObject({ ok: false, reason: 'cli_unavailable' });
    const child = fakeChild();
    const failing = runWecomLifecycleCli('start', 'c'.repeat(64), { spawn: (() => child) as any });
    child.emit('error', new Error('spawn fixture failed'));
    expect(await failing).toMatchObject({ ok: false, reason: 'cli_unavailable' });
  });

  it('kills a command that outlives its time limit and says so', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const running = runWecomLifecycleCli('stop', 'c'.repeat(64), { spawn: (() => child) as any, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await running).toMatchObject({ ok: false, reason: 'cli_timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('gives the command more time than its own worst case: waiting for the fleet lock, then a whole restart', () => {
    expect(WECOM_LIFECYCLE_CLI_TIMEOUT_MS).toBeGreaterThan(
      WECOM_LIFECYCLE_LOCK_WAIT_MS + FLEET_MEMBER_STOP_WAIT_MS + FLEET_MEMBER_START_WAIT_MS + WECOM_START_SETTLE_MS,
    );
  });
});

const SUPERVISOR_PID = 400;

function managerFixture(options: { configs?: number; sameBot?: boolean; secretEnv?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-dashboard-actions-'));
  roots.push(root);
  const files: string[] = [];
  for (let index = 0; index < (options.configs ?? 1); index++) {
    const file = index === 0 ? join(root, 'config.json') : join(root, `custom-${index}`, 'config.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({
      botId: options.sameBot ? 'shared-bot' : `bot-${index}`,
      ...(options.secretEnv ? { secretEnv: options.secretEnv } : { secretFile: join(root, 'unused-secret') }),
      coreUrl: 'http://127.0.0.1:19123',
      allowedUsers: ['u'],
    }));
    files.push(file);
  }
  const identities = new Map<number, string>([[SUPERVISOR_PID, 'supervisor-birth']]);
  /** Alive, but their birth identity cannot be read (unverifiable). */
  const hidden = new Set<number>();
  const runtime: FleetProcessIdentityRuntime = {
    readIdentity: pid => (hidden.has(pid) ? undefined : identities.get(pid)),
    readCommandLine: pid => (pid === SUPERVISOR_PID ? 'fixture-supervisor' : undefined),
    readPidNamespace: () => undefined,
    pidExists: pid => identities.has(pid),
  };
  let rows: FleetProcState[] = [];
  let supervisor = true;
  const readFleetState = vi.fn((): FleetState | null => ({
    supervisorPid: supervisor ? SUPERVISOR_PID : 0,
    supervisorStartedAt: 't',
    supervisorProcessStart: 'supervisor-birth',
    supervisorCommand: 'fixture-supervisor',
    procs: rows,
  }));
  const runs: Array<{ action: string; id: string; finish: (outcome: WecomLifecycleOutcome) => void }> = [];
  const runLifecycle = vi.fn((action: string, id: string, hooks?: { onSpawn?: (pid: number) => void }) => {
    const outcome = deferred<WecomLifecycleOutcome>();
    runs.push({ action, id, finish: outcome.resolve });
    hooks?.onSpawn?.(9000 + runs.length);
    return outcome.promise;
  });
  const manager = new WecomDashboardManager({ root, runtime, readFleetState, runLifecycle: runLifecycle as any, now: () => 1_000 });
  const ids = files.map(file => wecomConfigId(file));
  const row = (id: string, fields: Partial<FleetProcState>): FleetProcState => ({
    name: wecomFleetMemberName(id), appId: '', pid: 0, generation: 1, status: 'stopped', restarts: 0, lastExitCode: null, startedAt: 't', ...fields,
  });
  return {
    root, files, ids, identities, hidden, manager, runs, runLifecycle, readFleetState,
    setRows: (next: FleetProcState[]) => { rows = next; },
    setSupervisor: (live: boolean) => { supervisor = live; },
    row,
    /** A member online in the fleet, its pid alive with that birth. */
    online: (id: string, pid = 300) => {
      identities.set(pid, `birth-${pid}`);
      return row(id, { status: 'online', pid, processStart: `birth-${pid}` });
    },
    desire: (id: string, state: 'running' | 'stopped') => setWecomFleetDesiredState(id, state, { root }),
  };
}

const ok = (state: string): WecomLifecycleOutcome => ({ ok: true, state, message: '' });

describe('the Dashboard\'s actions on a WeCom connection', () => {
  it('answers at once with the action in progress, and runs one action per connection at a time', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    const view = await f.manager.start(id);
    expect(view).toMatchObject({ gateway: 'starting', operation: { action: 'start' }, canStart: false, canStop: false, canRestart: false });
    expect(f.runLifecycle).toHaveBeenCalledExactlyOnceWith('start', id);
    await expect(f.manager.start(id)).rejects.toThrow('wecom_operation_in_progress');
    await expect(f.manager.stop(id)).rejects.toThrow('wecom_operation_in_progress');
    expect(f.runLifecycle).toHaveBeenCalledTimes(1);
    f.desire(id, 'running');
    f.setRows([f.online(id)]);
    f.runs[0].finish(ok('started'));
    await vi.waitFor(async () => expect((await f.manager.list())[0].operation).toBeUndefined());
    expect((await f.manager.list())[0]).toMatchObject({ ownership: 'fleet', canStop: true, canRestart: true });
  });

  it('shows a failed action, reason and message, until the connection\'s state changes', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    await f.manager.start(id);
    f.desire(id, 'running');
    f.setRows([f.row(id, { status: 'errored', lastExitCode: 1 })]);
    f.runs[0].finish({ ok: false, reason: 'gateway_exited', message: 'fixture-gateway-exited' });
    await vi.waitFor(async () => expect((await f.manager.list())[0].lastFailure).toMatchObject({
      action: 'start', reason: 'gateway_exited', message: 'fixture-gateway-exited',
    }));
    expect((await f.manager.list())[0].lastFailure).toBeDefined();
    f.setRows([f.row(id, { status: 'launching', lastExitCode: 1, restarts: 1 })]);
    expect((await f.manager.list())[0].lastFailure).toBeUndefined();
  });

  it('drops a failed action\'s display when the next action begins', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    await f.manager.start(id);
    f.runs[0].finish({ ok: false, reason: 'timeout', message: 'fixture-timeout' });
    await vi.waitFor(async () => expect((await f.manager.list())[0].lastFailure).toBeDefined());
    const again = await f.manager.start(id);
    expect(again.lastFailure).toBeUndefined();
  });

  it('does not show "fleet not running" as a failed start: the connection shows it is set to run and why it is not', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.setSupervisor(false);
    const { settled } = f.manager.begin('start', id);
    f.desire(id, 'running');
    f.runs[0].finish({ ok: false, reason: 'fleet_down', message: 'fleet 未在运行', desired: 'running' });
    await settled;
    const row = (await f.manager.list())[0];
    expect(row.lastFailure).toBeUndefined();
    expect(row).toMatchObject({ desired: 'running', notRunning: { cause: 'fleet_down' }, canStart: true });
  });

  it('refuses an action the state does not offer, and an unknown connection, without running anything', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    await expect(f.manager.stop(id)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');
    await expect(f.manager.restart(id)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');
    await expect(f.manager.start('f'.repeat(64))).rejects.toThrow('wecom_connection_not_found');
    expect(f.runLifecycle).not.toHaveBeenCalled();
  });

  it('runs the wizard\'s rollback stop even when the state would not offer one, and waits for a running action first', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    await f.manager.start(id);
    let idle = false;
    void f.manager.idle(id).then(() => {
      idle = true;
    });
    await new Promise(done => setTimeout(done, 10));
    expect(idle).toBe(false);
    f.runs[0].finish(ok('started'));
    await vi.waitFor(() => expect(idle).toBe(true));
    f.manager.begin('stop', id, { force: true });
    expect(f.runLifecycle).toHaveBeenLastCalledWith('stop', id);
  });

  it('hands the command\'s pid to whoever began the action and asked for it', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    const pids: number[] = [];
    f.manager.begin('start', id, { onSpawn: pid => pids.push(pid) });
    expect(pids).toEqual([9001]);
  });

  it('names the credential variable a connection stopped for, never anything else about it', async () => {
    const f = managerFixture({ secretEnv: 'WECOM_FIXTURE_SECRET' });
    const [id] = f.ids;
    setWecomFleetDesiredStopped(id, 'credential_env_missing', { root: f.root });
    const row = (await f.manager.list())[0];
    expect(row).toMatchObject({ stopReason: 'credential_env_missing', credentialEnv: 'WECOM_FIXTURE_SECRET', canStart: true });
    expect(row.message).toContain('WECOM_FIXTURE_SECRET');
  });

  it('shows a failure noted for the connection until the next action begins', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.manager.noteFailure(id, { action: 'stop', reason: 'fleet_busy', message: 'fixture-owed-stop' });
    f.desire(id, 'running');
    expect((await f.manager.list())[0].lastFailure).toMatchObject({ action: 'stop', reason: 'fleet_busy', message: 'fixture-owed-stop' });
    await f.manager.start(id);
    expect((await f.manager.list())[0].lastFailure).toBeUndefined();
  });

  it('keeps a second configuration of the same bot from starting while the first runs it', async () => {
    const f = managerFixture({ configs: 2, sameBot: true });
    await registerWecomConfig(f.files[1], f.root);
    const [first, second] = f.ids;
    f.desire(first, 'running');
    f.setRows([f.online(first)]);
    const rows = await f.manager.list();
    expect(rows.find(row => row.id === second)).toMatchObject({ ownership: 'external', canStart: false });
    await expect(f.manager.start(second)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');
    expect(f.runLifecycle).not.toHaveBeenCalled();
  });

  it('does not take an online member row whose pid now belongs to another process for a running gateway', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.desire(id, 'running');
    const row = f.online(id);
    f.identities.set(row.pid, 'a-recycled-birth');
    f.setRows([row]);
    expect((await f.manager.list())[0]).toMatchObject({ gateway: 'stopped', notRunning: { cause: 'exited' } });
  });

  it('with no WeCom configuration file lists nothing and reads no fleet state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-dashboard-actions-empty-'));
    roots.push(root);
    const readFleetState = vi.fn(() => null);
    const manager = new WecomDashboardManager({ root, readFleetState, runLifecycle: vi.fn() as any });
    expect(await manager.list()).toEqual([]);
    expect(readFleetState).not.toHaveBeenCalled();
  });
});

describe('what the Dashboard reads for each connection', () => {
  it('lets a connection of one bot start while another bot\'s connection runs, and shows it unaffected', async () => {
    const f = managerFixture({ configs: 2 });
    await registerWecomConfig(f.files[1], f.root);
    const [running, idle] = f.ids;
    f.desire(running, 'running');
    f.setRows([f.online(running)]);
    const rows = await f.manager.list();
    expect(rows.find(row => row.id === running)).toMatchObject({ ownership: 'fleet', canStop: true });
    expect(rows.find(row => row.id === idle)).toMatchObject({ gateway: 'stopped', ownership: 'none', canStart: true, canStop: false });
    await f.manager.start(idle);
    expect(f.runLifecycle).toHaveBeenCalledExactlyOnceWith('start', idle);
  });

  it('counts another configuration\'s runtime record of the same bot as that bot running', async () => {
    const f = managerFixture({ configs: 2, sameBot: true });
    await registerWecomConfig(f.files[1], f.root);
    const [first, second] = f.ids;
    f.identities.set(600, 'birth-600');
    const bot = wecomBotRoot('shared-bot', f.root);
    mkdirSync(bot, { recursive: true });
    writeFileSync(join(bot, 'runtime.json'), JSON.stringify({
      version: 1, configId: second, pid: 600, processStart: 'birth-600', instanceId: 'i', connection: 'connected', phase: 'running', updatedAt: 1_000,
    }));
    expect((await f.manager.list()).find(row => row.id === first)).toMatchObject({ ownership: 'external', canStart: false });
  });

  it('treats an online member row without a birth identity as unverifiable', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.desire(id, 'running');
    f.identities.set(300, 'birth-300');
    f.setRows([f.row(id, { status: 'online', pid: 300 })]);
    expect((await f.manager.list())[0]).toMatchObject({ gateway: 'unknown', ownership: 'unknown', canStart: false, canStop: false });
  });

  it('cannot tell whether the bot runs when another configuration\'s member row carries no birth identity', async () => {
    const f = managerFixture({ configs: 2, sameBot: true });
    await registerWecomConfig(f.files[1], f.root);
    const [first, second] = f.ids;
    f.identities.set(600, 'birth-600');
    f.setRows([f.row(second, { status: 'online', pid: 600 })]);
    expect((await f.manager.list()).find(row => row.id === first))
      .toMatchObject({ gateway: 'unknown', ownership: 'unknown', canStart: false, canStop: false });
    await expect(f.manager.start(first)).rejects.toThrow('wecom_gateway_not_owned_or_unknown');
    expect(f.runLifecycle).not.toHaveBeenCalled();
  });

  it('tells a supervisor whose identity cannot be verified from one that is not running', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.desire(id, 'running');
    f.hidden.add(SUPERVISOR_PID);
    expect((await f.manager.list())[0].notRunning).toEqual({ cause: 'fleet_unknown' });
    f.hidden.delete(SUPERVISOR_PID);
    f.setSupervisor(false);
    expect((await f.manager.list())[0].notRunning).toEqual({ cause: 'fleet_down' });
  });

  it('reads an older Dashboard\'s job file for the connection, and only one written for that connection', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    f.identities.set(500, 'birth-500');
    mkdirSync(join(f.root, 'dashboard-jobs'), { recursive: true });
    const job = join(f.root, 'dashboard-jobs', `${id}.json`);
    writeFileSync(job, JSON.stringify({ version: 1, configId: 'b'.repeat(64), pid: 500, processStart: 'birth-500' }));
    expect((await f.manager.list())[0]).toMatchObject({ gateway: 'stopped', canStart: true });
    expect((await f.manager.list())[0].notice).toBeUndefined();
    writeFileSync(job, JSON.stringify({ version: 1, configId: id, pid: 500, processStart: 'birth-500' }));
    expect((await f.manager.list())[0]).toMatchObject({ notice: 'legacy_gateway', canStart: false, canStop: false });
  });

  it('marks every connection unavailable when the registry cannot be read', async () => {
    const f = managerFixture();
    writeFileSync(join(f.root, 'config-registry.json'), '{broken');
    expect((await f.manager.list())[0]).toMatchObject({ notice: 'registry_unavailable', canStart: false });
  });

  // The same reading as `botmux wecom start` (and as the lock itself, which a
  // gateway takes over once its recorded pid is gone).
  it('treats a single-active lock that records only a pid as unverifiable while that pid exists, as free once it does not', async () => {
    const f = managerFixture();
    const bot = wecomBotRoot('bot-0', f.root);
    mkdirSync(bot, { recursive: true });
    writeFileSync(join(bot, 'instance.lock'), JSON.stringify({ pid: 700 }));
    f.identities.set(700, 'birth-700');
    expect((await f.manager.list())[0]).toMatchObject({ gateway: 'unknown', canStart: false });
    f.identities.delete(700);
    expect((await f.manager.list())[0]).toMatchObject({ gateway: 'stopped', ownership: 'none', canStart: true });
  });

  it('drops a failed action\'s display when only the recorded intent changes', async () => {
    const f = managerFixture();
    const [id] = f.ids;
    await f.manager.start(id);
    f.runs[0].finish({ ok: false, reason: 'desired_state_busy', message: 'fixture-busy' });
    await vi.waitFor(async () => expect((await f.manager.list())[0].lastFailure).toBeDefined());
    f.desire(id, 'stopped');
    expect((await f.manager.list())[0].lastFailure).toBeUndefined();
  });
});

describe('choosing a new connection\'s managed core port', () => {
  it('wraps around to the start of the range after its end', async () => {
    const first = WECOM_CORE_PORT_RANGE.first;
    const free = [first, first + 1, first + 2];
    const taken = new Set(Array.from({ length: WECOM_CORE_PORT_RANGE.last - first + 1 }, (_, index) => first + index).filter(port => !free.includes(port)));
    const port = await allocateWecomCorePort({ ephemeral: { first: 1, last: 1 }, taken, canBind: async candidate => candidate === first, random: () => 0.99 });
    expect(port).toBe(first);
  });

  const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index);

  it('picks a port outside the host\'s ephemeral range and not used by another connection', async () => {
    const port = await allocateWecomCorePort({
      ephemeral: { first: WECOM_CORE_PORT_RANGE.first, last: WECOM_CORE_PORT_RANGE.last - 10 },
      taken: new Set([WECOM_CORE_PORT_RANGE.last - 9]),
      canBind: async () => true,
      random: () => 0,
    });
    expect(port).toBe(WECOM_CORE_PORT_RANGE.last - 8);
  });

  it('skips ports it cannot bind and gives up when none can be bound', async () => {
    const tried: number[] = [];
    const port = await allocateWecomCorePort({
      ephemeral: { first: 1, last: 1 },
      taken: new Set(),
      canBind: async candidate => {
        tried.push(candidate);
        return tried.length > 2;
      },
      random: () => 0,
    });
    expect(port).toBe(tried[2]);
    await expect(allocateWecomCorePort({ ephemeral: { first: 1, last: 1 }, taken: new Set(), canBind: async () => false, maxAttempts: 5 }))
      .rejects.toThrow('wecom_core_port_unavailable');
  });

  it('treats a port held on every interface as taken even though loopback alone would bind', async () => {
    let held = 0;
    for (const candidate of range(WECOM_CORE_PORT_RANGE.first + 4000, WECOM_CORE_PORT_RANGE.last - 1)) {
      const server = createServer();
      const listening = await new Promise<boolean>(done => {
        server.once('error', () => done(false));
        server.listen(candidate, '0.0.0.0', () => done(true));
      });
      if (listening) {
        servers.push(server);
        held = candidate;
        break;
      }
    }
    expect(held).toBeGreaterThan(0);
    const taken = new Set(range(WECOM_CORE_PORT_RANGE.first, WECOM_CORE_PORT_RANGE.last).filter(port => port !== held && port !== held + 1));
    const port = await allocateWecomCorePort({ ephemeral: { first: 1, last: 1 }, taken, random: () => 0 });
    expect(port).toBe(held + 1);
  });

  it('keeps its range clear of the default ephemeral ranges, and reads the range Linux is configured with', () => {
    const overlaps = (other: { first: number; last: number }) =>
      WECOM_CORE_PORT_RANGE.first <= other.last && other.first <= WECOM_CORE_PORT_RANGE.last;
    expect(overlaps(hostEphemeralPortRange('darwin'))).toBe(false);
    expect(overlaps(hostEphemeralPortRange('linux', () => { throw new Error('no /proc'); }))).toBe(false);
    expect(hostEphemeralPortRange('linux', () => '15000\t61000\n')).toEqual({ first: 15000, last: 61000 });
  });
});

describe('the environment the configuration page shows for a WeCom connection', () => {
  it('is the fleet member\'s: the Dashboard-only H5 family left out, `.env` keys the supervisor adds put in, the base winning', () => {
    const env = wecomFleetMemberEnvironment(
      { PATH: '/usr/bin', NO_PROXY: 'from-base', BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET: 'fixture-h5-secret' },
      'HTTPS_PROXY=http://proxy.invalid:3128\nNO_PROXY=from-dotenv\nFIXTURE_UNLISTED_SECRET=nope\n',
    );
    expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(env.NO_PROXY).toBe('from-base');
    expect(env.FIXTURE_UNLISTED_SECRET).toBeUndefined();
    expect(env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBeUndefined();
  });

  it('is built on that environment rather than the Dashboard\'s own', () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-dashboard-env-'));
    roots.push(root);
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      botId: 'env-bot',
      secretFile: join(root, 'unused-secret'),
      coreUrl: 'http://127.0.0.1:19400',
      allowedUsers: ['u'],
      managedCore: { cli: 'codex', backend: 'pty', workingDirectory: root, port: 19400, stateDir: join(root, 'core'), botId: 'local_wecom_env' },
    }));
    const configuration = new WecomDashboardConfig(root, () => ({ PATH: process.env.PATH, FIXTURE_ONLY_IN_MEMBER_ENV: 'member-value' }));
    expect(JSON.stringify(configuration.environment(wecomConfigId(file)))).toContain('FIXTURE_ONLY_IN_MEMBER_ENV');
  });
});
