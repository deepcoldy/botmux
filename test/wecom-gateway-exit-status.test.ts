import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWecomCommand, type WecomCommandDeps } from '../src/im/wecom/gateway/command.js';
import { wecomGatewayExitCode, type WecomGatewayExitReason } from '../src/im/wecom/gateway/exit-status.js';
import { wecomCoreGenerationFile } from '../src/im/wecom/gateway/core-generation.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { fleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import { withFileLock } from '../src/utils/file-lock.js';
import {
  WECOM_FLEET_MEMBER_ENV,
  WECOM_GATEWAY_NO_RESTART_EXIT_CODE,
  wecomFleetMemberName,
} from '../src/im/wecom/contract/fleet-member.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * A supervised gateway (WECOM_FLEET_MEMBER_ENV set) exits with the no-restart
 * code only for failures retrying cannot fix, always after its core stopped.
 * Run from a terminal or the Dashboard it keeps its historical exit codes and
 * its 100 ms instance-lock wait.
 */

const SECRET_ENV = 'EXIT_STATUS_WECOM_SECRET';
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

/** Fake WeCom long connection: acknowledges every frame, the subscription with `authErrcode`. */
class FakeSocket extends EventEmitter {
  sent: Array<{ cmd?: string; headers?: { req_id?: string } }> = [];
  constructor(private readonly authErrcode: number) {
    super();
  }
  send(data: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    callback?.();
    const errcode = frame.cmd === 'aibot_subscribe' ? this.authErrcode : 0;
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode }))));
  }
  terminate() {
    this.emit('close');
  }
  replace() {
    this.emit('message', Buffer.from(JSON.stringify({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } })));
  }
}

let botSeq = 0;

async function gatewayConfig(options: { managed: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-exit-status-'));
  roots.push(root);
  const port = await reserveWecomCorePort();
  const botId = `exit-status-${process.pid}-${++botSeq}`;
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({
    botId,
    secretEnv: SECRET_ENV,
    coreUrl: `http://127.0.0.1:${port}`,
    allowedUsers: ['alice'],
    stateDir: root,
    ...(options.managed
      ? {
        managedCore: {
          botId: 'local_exit_status',
          cli: 'codex',
          backend: 'pty',
          port,
          workingDirectory: root,
          stateDir: join(root, 'core-state'),
        },
      }
      : {}),
  }));
  vi.stubEnv(SECRET_ENV, 'fake-secret');
  return { root, file, botId, port };
}

const READY = `console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')'); console.error('fake-core-stderr'); setInterval(()=>{},1000);`;

interface Harness {
  deps: WecomCommandDeps;
  socket: () => FakeSocket | undefined;
  core: () => ChildProcess | undefined;
  coreEnv: () => NodeJS.ProcessEnv | undefined;
}

function harness(authErrcode = 0): Harness {
  let socket: FakeSocket | undefined;
  let core: ChildProcess | undefined;
  let coreEnv: NodeJS.ProcessEnv | undefined;
  return {
    deps: {
      socketFactory: () => {
        socket = new FakeSocket(authErrcode);
        return socket as never;
      },
      coreSpawn: (_command: string, _args: string[], options: SpawnOptions) => {
        coreEnv = options.env;
        core = spawnTsEval(READY, options);
        children.push(core);
        return core;
      },
    },
    socket: () => socket,
    core: () => core,
    coreEnv: () => coreEnv,
  };
}

/** Start the gateway and complete the transport's connect step. Wrapped: an async function would flatten the run. */
async function connect(h: Harness, file: string): Promise<{ running: Promise<number> }> {
  const running = runWecomCommand(['--config', file], h.deps);
  await vi.waitFor(() => expect(h.socket()?.listenerCount('open')).toBe(1), { timeout: 15_000, interval: 20 });
  h.socket()!.emit('open');
  await vi.waitFor(() => expect(h.socket()!.sent.some(frame => frame.cmd === 'aibot_subscribe')).toBe(true));
  return { running };
}

const exited = (child: ChildProcess | undefined) => !!child && (child.exitCode !== null || child.signalCode !== null);

describe('WeCom gateway exit codes', () => {
  const reasons: WecomGatewayExitReason[] = [
    'stopped', 'usage', 'not_configured', 'invalid_configuration', 'credential_env_missing', 'replaced', 'authentication_failed',
    'instance_busy', 'failed',
  ];
  const noRestart = new Set<WecomGatewayExitReason>([
    'not_configured', 'invalid_configuration', 'credential_env_missing', 'replaced', 'authentication_failed', 'instance_busy',
  ]);

  it.each(reasons)('maps %s to the no-restart code only under supervision', reason => {
    const supervised = wecomGatewayExitCode(reason, true);
    const terminal = wecomGatewayExitCode(reason, false);
    expect(terminal).not.toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    if (noRestart.has(reason)) {
      expect(supervised).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    } else {
      expect(supervised).toBe(terminal);
    }
  });

  it('exits no-restart after stopping its core when the connection is replaced (supervised)', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file } = await gatewayConfig({ managed: true });
    const h = harness();
    const { running } = await connect(h, file);
    await vi.waitFor(() => expect(h.core()).toBeDefined());

    h.socket()!.replace();
    const code = await running;

    expect(code).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(exited(h.core())).toBe(true);
  });

  it('exits no-restart after stopping its core when authentication is rejected (supervised)', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file } = await gatewayConfig({ managed: true });
    const h = harness(40014);

    const code = await (await connect(h, file)).running;

    expect(code).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(exited(h.core())).toBe(true);
  });

  it('exits retryably when its core dies unexpectedly (supervised)', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file } = await gatewayConfig({ managed: true });
    const h = harness();
    const { running } = await connect(h, file);

    h.core()!.kill('SIGKILL');
    const code = await running;

    expect(code).not.toBe(0);
    expect(code).not.toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
  });

  it('keeps its historical exit code for a replaced connection when not supervised', async () => {
    const { file } = await gatewayConfig({ managed: true });
    const h = harness();
    const { running } = await connect(h, file);

    h.socket()!.replace();
    const code = await running;

    expect(code).toBe(1);
    expect(exited(h.core())).toBe(true);
  });

  it('removes the fleet marker from its own environment and never passes it to the core', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file } = await gatewayConfig({ managed: true });
    const h = harness();
    const { running } = await connect(h, file);

    expect(process.env[WECOM_FLEET_MEMBER_ENV]).toBeUndefined();
    expect(h.coreEnv()).toBeDefined();
    expect(h.coreEnv()![WECOM_FLEET_MEMBER_ENV]).toBeUndefined();

    h.socket()!.replace();
    await running;
  });

  it('writes the core output to per-connection log files', async () => {
    const { file } = await gatewayConfig({ managed: true });
    const h = harness();
    const { running } = await connect(h, file);
    h.socket()!.replace();
    await running;

    const base = join(homedir(), '.botmux', 'logs', `${wecomFleetMemberName(wecomConfigId(file))}-core`);
    expect(readFileSync(`${base}-out.log`, 'utf8')).toContain('[core-only] listening on');
    expect(readFileSync(`${base}-err.log`, 'utf8')).toContain('fake-core-stderr');
  });

  describe('configuration that retrying cannot fix', () => {
    it.each([
      ['an unparsable configuration file', (file: string) => writeFileSync(file, '{ not json')],
      ['a missing credential', () => vi.stubEnv(SECRET_ENV, '')],
    ])('%s: no-restart when supervised, 1 otherwise, never a core', async (_label, breakIt) => {
      for (const supervised of [true, false]) {
        if (supervised) {
          vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
        }
        const { file } = await gatewayConfig({ managed: true });
        breakIt(file);
        const h = harness();

        const code = await runWecomCommand(['--config', file], h.deps);

        expect(code).toBe(supervised ? WECOM_GATEWAY_NO_RESTART_EXIT_CODE : 1);
        expect(h.core()).toBeUndefined();
        vi.unstubAllEnvs();
      }
    });

    it('a missing configuration file: no-restart when supervised, 2 otherwise', async () => {
      const missing = join(tmpdir(), `wecom-missing-${process.pid}-${Date.now()}.json`);
      vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
      expect(await runWecomCommand(['--config', missing])).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
      vi.unstubAllEnvs();
      expect(await runWecomCommand(['--config', missing])).toBe(2);
    });
  });

  it('exits retryably, without spawning a core, when a previous core cannot be proven safe to reclaim', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file, botId, port } = await gatewayConfig({ managed: true });
    const botRoot = join(homedir(), '.botmux', 'wecom', createHash('sha256').update(botId).digest('hex'));
    mkdirSync(botRoot, { recursive: true });
    const configId = wecomConfigId(file);
    // The recording gateway is still alive (this process), so its core must not be touched.
    const self = { pid: process.pid, processStart: fleetProcessIdentityRuntime.readIdentity(process.pid)! };
    writeFileSync(wecomCoreGenerationFile(botRoot, configId), JSON.stringify({
      version: 1, configId, gateway: self, core: self, coreBotId: 'local_exit_status', port, stateDir: '/nonexistent', spawnedAt: 1,
    }));
    const h = harness();

    const code = await runWecomCommand(['--config', file], h.deps);

    expect(code).not.toBe(0);
    expect(code).not.toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(h.core()).toBeUndefined();
    expect(existsSync(wecomCoreGenerationFile(botRoot, configId))).toBe(true);
  });
});

describe('WeCom gateway instance lock', () => {
  async function holdLock(botId: string, holdMs: number): Promise<{ released: Promise<void> }> {
    const botRoot = join(homedir(), '.botmux', 'wecom', createHash('sha256').update(botId).digest('hex'));
    mkdirSync(botRoot, { recursive: true });
    let acquired!: () => void;
    const held = new Promise<void>(done => {
      acquired = done;
    });
    const released = withFileLock(join(botRoot, 'instance'), async () => {
      acquired();
      await new Promise(done => setTimeout(done, holdMs));
    });
    await held;
    return { released };
  }

  it('waits for a previous generation to release the lock when supervised', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file, botId } = await gatewayConfig({ managed: false });
    const { released } = await holdLock(botId, 600);
    const h = harness();

    const { running } = await connect({ ...h, deps: { ...h.deps, supervisedLockWaitMs: 5_000 } }, file);
    await released;
    h.socket()!.replace();

    expect(await running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
  });

  it('gives up with the no-restart code when the holder outlasts the wait (supervised)', async () => {
    vi.stubEnv(WECOM_FLEET_MEMBER_ENV, 'wecom-member');
    const { file, botId } = await gatewayConfig({ managed: false });
    const { released } = await holdLock(botId, 1_500);
    const h = harness();

    const code = await runWecomCommand(['--config', file], { ...h.deps, supervisedLockWaitMs: 300 });

    expect(code).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);
    expect(h.socket()).toBeUndefined();
    await released;
  });

  it('keeps the short wait and exit code 1 when not supervised', async () => {
    const { file, botId } = await gatewayConfig({ managed: false });
    const { released } = await holdLock(botId, 1_500);
    const h = harness();
    const started = Date.now();

    const code = await runWecomCommand(['--config', file], { ...h.deps, supervisedLockWaitMs: 60_000 });

    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.socket()).toBeUndefined();
    await released;
  });
});
