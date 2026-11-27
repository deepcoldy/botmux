import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWecomCommand, type WecomCommandDeps } from '../src/im/wecom/gateway/command.js';
import { WECOM_GATEWAY_NOT_RETRYABLE_REASONS } from '../src/im/wecom/gateway/exit-status.js';
import { WecomGatewayDesiredStop } from '../src/im/wecom/gateway/desired-stop.js';
import {
  WECOM_DESIRED_STOP_REASONS,
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
  wecomFleetDesiredStatePath,
  type WecomDesiredRecord,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import { wecomConfigId, wecomRoot } from '../src/im/wecom/config/discovery.js';
import { withFileLock } from '../src/utils/file-lock.js';
import { WECOM_FLEET_MEMBER_ENV, WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../src/im/wecom/contract/fleet-member.js';
import { spawnTsEval, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * A supervised gateway that exits with the no-restart code records its
 * connection as `stopped` with the reason — as soon as it knows the reason, and
 * only over the record it runs under — so a later supervisor (restart,
 * autostart, crash recovery) does not start it again, while a person's later
 * intent is never overwritten; a supervised gateway whose connection is
 * recorded `stopped` exits before connecting, checked again once it holds the
 * instance lock. A gateway outside the fleet neither reads nor writes the
 * desired-state file.
 */

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A WeCom server that, like the real one, hands a BotID's connection to the
 *  newest subscriber and tells the previous one it was replaced. */
class FakeWecomServer {
  private live: FakeSocket[] = [];
  readonly sockets: FakeSocket[] = [];
  socket(): FakeSocket {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    return socket;
  }
  subscribed(socket: FakeSocket) {
    for (const previous of this.live.filter(item => item !== socket && !item.closed)) {
      previous.receive({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    }
    this.live = [...this.live.filter(item => !item.closed), socket];
  }
}

class FakeSocket extends EventEmitter {
  closed = false;
  constructor(private readonly server: FakeWecomServer, private readonly authErrcode = 0) {
    super();
  }
  send(data: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(data);
    callback?.();
    const errcode = frame.cmd === 'aibot_subscribe' ? this.authErrcode : 0;
    queueMicrotask(() => {
      this.receive({ headers: frame.headers, errcode });
      if (frame.cmd === 'aibot_subscribe' && errcode === 0) {
        this.server.subscribed(this);
      }
    });
  }
  receive(frame: unknown) {
    if (!this.closed) {
      this.emit('message', Buffer.from(JSON.stringify(frame)));
    }
  }
  terminate() {
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }
}

let seq = 0;

async function connection(options: { managed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-desired-stop-'));
  roots.push(root);
  const port = await reserveWecomCorePort();
  const botId = `desired-stop-${process.pid}-${++seq}`;
  const file = join(root, 'config.json');
  // A credential file, not an env var: a gateway removes its secret env var from
  // this (shared, in-process) environment, which would starve the next run.
  const secretFile = join(root, 'secret');
  writeFileSync(secretFile, 'fake-secret', { mode: 0o600 });
  writeFileSync(file, JSON.stringify({
    botId,
    secretFile,
    coreUrl: `http://127.0.0.1:${port}`,
    allowedUsers: ['alice'],
    stateDir: root,
    ...(options.managed
      ? { managedCore: { botId: 'local_desired_stop', cli: 'codex', backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core') } }
      : {}),
  }));
  return { file, botId, configId: wecomConfigId(file) };
}

const READY = `console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')'); setInterval(()=>{},1000);`;
/** A core that takes 1.5 s to exit once told to stop: the gateway's shutdown is observable. */
const SLOW_TO_STOP = `${READY} process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500));`;

function gatewayDeps(server: FakeWecomServer, spawned: ChildProcess[] = [], core = READY): WecomCommandDeps {
  return {
    socketFactory: () => server.socket() as never,
    coreSpawn: (_command: string, _args: string[], options: SpawnOptions) => {
      const child = spawnTsEval(core, options);
      children.push(child);
      spawned.push(child);
      return child;
    },
  };
}

/** Start a gateway and complete the transport's connect step on its newest socket. */
async function connected(server: FakeWecomServer, file: string, deps: WecomCommandDeps): Promise<{ running: Promise<number>; socket: FakeSocket }> {
  const before = server.sockets.length;
  const running = runWecomCommand(['--config', file], deps);
  await vi.waitFor(() => expect(server.sockets.length).toBeGreaterThan(before), { timeout: 15_000, interval: 20 });
  const socket = server.sockets.at(-1)!;
  await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1), { timeout: 15_000, interval: 20 });
  socket.emit('open');
  return { running, socket };
}

function recordOf(configId: string): WecomDesiredRecord | undefined {
  const snapshot = readWecomFleetDesiredState();
  return snapshot.status === 'ok' ? snapshot.connections.get(configId) : undefined;
}

/** Every run consumes the marker (it is removed from the environment it is read from). */
const supervise = () => vi.stubEnv(WECOM_FLEET_MEMBER_ENV, '1');

describe('WeCom gateway: recording a no-restart stop', () => {
  it('keeps the gateway\'s not-retryable reasons and the recordable stop reasons the same set', () => {
    expect(new Set(WECOM_GATEWAY_NOT_RETRYABLE_REASONS)).toEqual(new Set(WECOM_DESIRED_STOP_REASONS));
  });

  it('records stopped(replaced) as soon as it is replaced, while its core is still stopping, then exits with the no-restart code', async () => {
    supervise();
    const { file, configId } = await connection({ managed: true });
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    const server = new FakeWecomServer();
    const cores: ChildProcess[] = [];
    const { running } = await connected(server, file, gatewayDeps(server, cores, SLOW_TO_STOP));
    await vi.waitFor(() => expect(cores.length).toBe(1));

    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));
    // Killed from here on — or its supervisor replaced — the next generation finds the stop.
    await vi.waitFor(() => expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'replaced' }), { timeout: 5_000, interval: 10 });
    expect(cores[0].exitCode === null && cores[0].signalCode === null).toBe(true);

    expect(await running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'replaced' });
    expect(cores[0].exitCode !== null || cores[0].signalCode !== null).toBe(true);
  }, 20_000);

  it('records the configuration reasons too', async () => {
    supervise();
    const broken = await connection();
    writeFileSync(broken.file, '{ not json');
    const missing = join(tmpdir(), `wecom-desired-missing-${process.pid}-${Date.now()}.json`);

    expect(await runWecomCommand(['--config', broken.file])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    supervise();
    expect(await runWecomCommand(['--config', missing])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);

    expect(recordOf(broken.configId)).toMatchObject({ desired: 'stopped', reason: 'invalid_configuration' });
    expect(recordOf(wecomConfigId(missing))).toMatchObject({ desired: 'stopped', reason: 'not_configured' });
  });

  it('tells a credential variable missing from its environment apart from an invalid configuration', async () => {
    const variable = `DESIRED_STOP_UNSET_SECRET_${process.pid}`;
    delete process.env[variable];
    const fromEnv = await connection();
    const config = JSON.parse(readFileSync(fromEnv.file, 'utf8'));
    delete config.secretFile;
    writeFileSync(fromEnv.file, JSON.stringify({ ...config, secretEnv: variable }));
    const unreadableFile = await connection();
    // A credential file others may read is refused: a broken configuration, not a missing variable.
    chmodSync(join(dirname(unreadableFile.file), 'secret'), 0o644);
    const lines: string[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      lines.push(parts.join(' '));
    });

    try {
      supervise();
      expect(await runWecomCommand(['--config', fromEnv.file])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
      supervise();
      expect(await runWecomCommand(['--config', unreadableFile.file])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
      // Outside the fleet: the historical exit code, and the file is not touched.
      expect(await runWecomCommand(['--config', fromEnv.file])).toBe(1);
    } finally {
      errors.mockRestore();
    }

    expect(recordOf(fromEnv.configId)).toMatchObject({ desired: 'stopped', reason: 'credential_env_missing' });
    expect(recordOf(unreadableFile.configId)).toMatchObject({ desired: 'stopped', reason: 'invalid_configuration' });
    // The supervised run names the variable the fleet's environment lacks.
    expect(lines.some(line => line.includes(variable))).toBe(true);
  });

  it('still exits with the no-restart code when the record cannot be written', async () => {
    supervise();
    const { file } = await connection();
    writeFileSync(file, '{ not json');
    mkdirSync(wecomRoot(), { recursive: true });
    const damaged = '{ "version": 1, "connections": [';
    writeFileSync(wecomFleetDesiredStatePath(), damaged);
    try {
      expect(await runWecomCommand(['--config', file])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
      expect(readFileSync(wecomFleetDesiredStatePath(), 'utf8')).toBe(damaged);
    } finally {
      rmSync(wecomFleetDesiredStatePath(), { force: true });
    }
  });

  it('gives up on a held desired-state lock within its write budget, and still is not restarted', async () => {
    supervise();
    const { file, configId } = await connection();
    writeFileSync(file, '{ not json');
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>(done => {
      held = done;
    });
    const locked = withFileLock(wecomFleetDesiredStatePath(), async () => {
      held();
      await new Promise<void>(done => {
        release = done;
      });
    });
    await holding;
    try {
      const started = Date.now();
      expect(await runWecomCommand(['--config', file])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
      expect(Date.now() - started).toBeLessThan(8_000);
      // Still the record it started under: nobody asked for it to run again.
      expect(recordOf(configId)?.desired).toBe('running');
    } finally {
      release();
      await locked;
    }
  }, 20_000);

  it('neither writes nor reads the file outside the fleet', async () => {
    const { file, configId } = await connection({ managed: true });
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredStopped(configId, 'replaced');
    const before = readFileSync(wecomFleetDesiredStatePath());
    const mtime = statSync(wecomFleetDesiredStatePath()).mtimeMs;
    const server = new FakeWecomServer();

    // Recorded as stopped, yet a terminal run connects as before ...
    const { running } = await connected(server, file, gatewayDeps(server));
    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));
    // ... and its replaced exit keeps the historical code and writes nothing.
    expect(await running).toBe(1);
    expect(readFileSync(wecomFleetDesiredStatePath())).toEqual(before);
    expect(statSync(wecomFleetDesiredStatePath()).mtimeMs).toBe(mtime);
  });
});

describe('WeCom gateway: a supervised start of a stopped connection', () => {
  it.each([
    ['stopped by its gateway (killed after writing, before exiting)', 'replaced'],
    ['stopped by a person', undefined],
  ] as const)('%s: exits with the no-restart code without connecting, starting a core or rewriting the record', async (_label, reason) => {
    supervise();
    const { file, configId } = await connection({ managed: true });
    mkdirSync(wecomRoot(), { recursive: true });
    if (reason) {
      setWecomFleetDesiredStopped(configId, reason);
    } else {
      setWecomFleetDesiredState(configId, 'stopped');
    }
    const record = readFileSync(wecomFleetDesiredStatePath());
    const server = new FakeWecomServer();
    const cores: ChildProcess[] = [];

    expect(await runWecomCommand(['--config', file], gatewayDeps(server, cores))).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);

    expect(server.sockets).toHaveLength(0);
    expect(cores).toHaveLength(0);
    expect(readFileSync(wecomFleetDesiredStatePath())).toEqual(record);
  });

  it('runs when the desired-state file cannot be read', async () => {
    supervise();
    const { file } = await connection();
    mkdirSync(wecomRoot(), { recursive: true });
    writeFileSync(wecomFleetDesiredStatePath(), 'not json');
    const server = new FakeWecomServer();
    try {
      const { running } = await connected(server, file, gatewayDeps(server));
      process.emit('SIGTERM', 'SIGTERM');
      expect(await running).toBe(0);
    } finally {
      rmSync(wecomFleetDesiredStatePath(), { force: true });
    }
  });
});

describe('WeCom gateway desired stop: interleavings', () => {
  it('a local generation change never writes replaced: the old gateway is gone before the new one subscribes', async () => {
    supervise();
    const { file, configId } = await connection();
    const server = new FakeWecomServer();
    const old = await connected(server, file, gatewayDeps(server));
    await vi.waitFor(() => expect(old.socket.listenerCount('message')).toBeGreaterThan(0));
    // The supervisor starts the next generation without waiting for the previous one ...
    supervise();
    const next = runWecomCommand(['--config', file], { ...gatewayDeps(server), supervisedLockWaitMs: 10_000 });
    await new Promise(done => setTimeout(done, 300));
    expect(server.sockets).toHaveLength(1);
    // ... and stops the previous one with SIGTERM.
    process.emit('SIGTERM', 'SIGTERM');
    expect(await old.running).toBe(0);
    await vi.waitFor(() => expect(server.sockets).toHaveLength(2), { timeout: 10_000, interval: 20 });
    server.sockets[1].emit('open');
    await new Promise(done => setTimeout(done, 300));
    process.emit('SIGTERM', 'SIGTERM');

    expect(await next).toBe(0);
    expect(recordOf(configId)).toBeUndefined();
  });

  it('a person\'s stop and the gateway\'s stop, in either order, leave the connection stopped', async () => {
    mkdirSync(wecomRoot(), { recursive: true });
    const a = (await connection()).configId;
    const b = (await connection()).configId;
    setWecomFleetDesiredState(a, 'running');
    setWecomFleetDesiredState(b, 'running');
    const gatewayA = new WecomGatewayDesiredStop(a, { log: () => {} });
    const gatewayB = new WecomGatewayDesiredStop(b, { log: () => {} });
    gatewayA.check();
    gatewayB.check();

    setWecomFleetDesiredState(a, 'stopped');
    gatewayA.record('replaced');
    gatewayB.record('authentication_failed');
    setWecomFleetDesiredState(b, 'stopped');

    // The person's stop came first on a: it stays, without the gateway's reason.
    expect(recordOf(a)).toMatchObject({ desired: 'stopped' });
    expect(recordOf(a)?.reason).toBeUndefined();
    expect(recordOf(b)?.desired).toBe('stopped');
    expect(gatewayA.restartRequested()).toBe(false);
  });

  it('concurrent writers from two processes also end stopped, with a readable file', async () => {
    mkdirSync(wecomRoot(), { recursive: true });
    const { configId } = await connection();
    const desiredModule = new URL('../src/im/wecom/config/fleet-desired-state.js', import.meta.url).href;
    const writer = (call: string) => spawnTsEvalWithRepoImports(
      `const m = await import(${JSON.stringify(desiredModule)}); for (let i = 0; i < 25; i++) { ${call}; }`,
      { env: process.env, stdio: 'ignore' },
    );
    const person = writer(`m.setWecomFleetDesiredState(${JSON.stringify(configId)}, 'stopped')`);
    const gateway = writer(`m.setWecomFleetDesiredStopped(${JSON.stringify(configId)}, 'replaced')`);
    children.push(person, gateway);

    const [[personCode], [gatewayCode]] = await Promise.all([once(person, 'exit'), once(gateway, 'exit')]);

    expect([personCode, gatewayCode]).toEqual([0, 0]);
    expect(readWecomFleetDesiredState().status).toBe('ok');
    expect(recordOf(configId)?.desired).toBe('stopped');
  }, 60_000);

  it('a person\'s start followed by a takeover ends stopped, with the reason', async () => {
    supervise();
    const { file, configId } = await connection();
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    const server = new FakeWecomServer();
    const { running } = await connected(server, file, gatewayDeps(server));
    await new Promise(done => setTimeout(done, 100));

    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));

    expect(await running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'replaced' });
  });

  it('instance_busy stays stopped after the outside instance exits, until someone starts it', async () => {
    supervise();
    const { file, botId, configId } = await connection();
    const botRoot = join(homedir(), '.botmux', 'wecom', createHash('sha256').update(botId).digest('hex'));
    mkdirSync(botRoot, { recursive: true });
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>(done => {
      held = done;
    });
    const outside = withFileLock(join(botRoot, 'instance'), async () => {
      held();
      await new Promise<void>(done => {
        release = done;
      });
    });
    await holding;
    const server = new FakeWecomServer();

    expect(await runWecomCommand(['--config', file], { ...gatewayDeps(server), supervisedLockWaitMs: 300 }))
      .toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'instance_busy' });
    release();
    await outside;

    // The outside instance is gone. A new supervisor would not make it a member,
    // and a supervised start that slips through still stops before connecting.
    const listed = listWecomFleetConnections().find(item => item.configId === configId);
    expect(listed?.desired).toBe('stopped');
    supervise();
    expect(await runWecomCommand(['--config', file], gatewayDeps(server))).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(server.sockets).toHaveLength(0);

    // Someone starts it: it runs again.
    setWecomFleetDesiredState(configId, 'running');
    supervise();
    const { running } = await connected(server, file, gatewayDeps(server));
    process.emit('SIGTERM', 'SIGTERM');
    expect(await running).toBe(0);
  });
});

describe('WeCom gateway desired stop: the record a gateway runs under', () => {
  const at = (iso: string) => () => new Date(iso);

  it('writes only over the record it read; a start since then stands, and the next generation settles it', async () => {
    mkdirSync(wecomRoot(), { recursive: true });
    const { configId } = await connection();
    setWecomFleetDesiredState(configId, 'running', { now: at('2026-11-18T00:00:00.000Z') });
    const first = new WecomGatewayDesiredStop(configId, { log: () => {} });
    expect(first.check()).toBeUndefined();

    // A person starts the connection again after this run read its record ...
    setWecomFleetDesiredState(configId, 'running', { now: at('2026-11-18T00:00:01.000Z') });
    first.record('invalid_configuration');

    // ... so the start stands, and this run asks to be restarted into it.
    expect(recordOf(configId)).toEqual({ desired: 'running', updatedAt: '2026-11-18T00:00:01.000Z' });
    expect(first.restartRequested()).toBe(true);

    // The next generation runs under the newer record; the failure persists, so it records it there.
    const next = new WecomGatewayDesiredStop(configId, { log: () => {} });
    expect(next.check()).toBeUndefined();
    next.record('invalid_configuration');
    expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'invalid_configuration' });
    expect(next.restartRequested()).toBe(false);
  });

  it('a person\'s start while the replaced gateway shuts down stands: the gateway exits retryably', async () => {
    supervise();
    const { file, configId } = await connection({ managed: true });
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    const server = new FakeWecomServer();
    const cores: ChildProcess[] = [];
    const { running } = await connected(server, file, gatewayDeps(server, cores, SLOW_TO_STOP));
    await vi.waitFor(() => expect(cores.length).toBe(1));
    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));
    await vi.waitFor(() => expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'replaced' }), { timeout: 5_000, interval: 10 });

    // `botmux wecom start` while the core is still stopping.
    setWecomFleetDesiredState(configId, 'running');

    expect(await running).toBe(1);
    expect(recordOf(configId)?.desired).toBe('running');
    expect(recordOf(configId)?.reason).toBeUndefined();
  }, 20_000);

  it('a person\'s stop the supervisor has not carried out yet stays a plain stop when the gateway is then replaced', async () => {
    supervise();
    const { file, configId } = await connection();
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    const server = new FakeWecomServer();
    const { running } = await connected(server, file, gatewayDeps(server));
    await new Promise(done => setTimeout(done, 100));

    setWecomFleetDesiredState(configId, 'stopped');
    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));

    expect(await running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(recordOf(configId)?.desired).toBe('stopped');
    expect(recordOf(configId)?.reason).toBeUndefined();
  });

  it('a start of a connection already running does not turn its next replacement into a restart', async () => {
    supervise();
    const { file, configId } = await connection();
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running', { now: at('2026-11-18T00:00:00.000Z') });
    const server = new FakeWecomServer();
    const { running } = await connected(server, file, gatewayDeps(server));

    // `botmux wecom start` of the running connection rewrites `running` ...
    setWecomFleetDesiredState(configId, 'running', { now: at('2026-11-18T00:00:05.000Z') });
    // ... and the gateway, still connected, goes through two dispatch ticks.
    await new Promise(done => setTimeout(done, 4_500));
    server.socket().send(JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 'other-client' } }));

    expect(await running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(recordOf(configId)).toMatchObject({ desired: 'stopped', reason: 'replaced' });
  }, 20_000);

  it('a stop recorded while it waited for the instance lock ends it before connecting or starting a core', async () => {
    supervise();
    const { file, botId, configId } = await connection({ managed: true });
    mkdirSync(wecomRoot(), { recursive: true });
    setWecomFleetDesiredState(configId, 'running');
    const botRoot = join(homedir(), '.botmux', 'wecom', createHash('sha256').update(botId).digest('hex'));
    mkdirSync(botRoot, { recursive: true });
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>(done => {
      held = done;
    });
    // The previous generation, still shutting down, holds the lock.
    const previous = withFileLock(join(botRoot, 'instance'), async () => {
      held();
      await new Promise<void>(done => {
        release = done;
      });
    });
    await holding;
    const server = new FakeWecomServer();
    const cores: ChildProcess[] = [];
    const run = runWecomCommand(['--config', file], { ...gatewayDeps(server, cores), supervisedLockWaitMs: 10_000 });
    await new Promise(done => setTimeout(done, 300));

    // It records its own stop and releases the lock.
    setWecomFleetDesiredStopped(configId, 'replaced');
    const record = readFileSync(wecomFleetDesiredStatePath());
    release();
    await previous;

    const outcome = await Promise.race([run, new Promise(done => setTimeout(() => done('still running'), 3_000))]);
    if (outcome === 'still running') {
      process.emit('SIGTERM', 'SIGTERM');
      await run;
    }
    expect(outcome).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(server.sockets).toHaveLength(0);
    expect(cores).toHaveLength(0);
    expect(readFileSync(wecomFleetDesiredStatePath())).toEqual(record);
  }, 20_000);
});
