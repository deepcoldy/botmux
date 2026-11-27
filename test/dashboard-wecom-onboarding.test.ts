import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomOnboardingManager, preflightWecomOnboarding, type WecomOnboardingOptions } from '../src/dashboard/wecom/onboarding.js';
import { commitWecomConfiguration, parseWecomConfig, readWecomCredentialFile } from '../src/im/wecom/config/config.js';
import { readWecomConfigPaths } from '../src/im/wecom/config/discovery.js';
import { setWecomFleetDesiredState } from '../src/im/wecom/config/fleet-desired-state.js';
import { spawnTsEval } from './helpers/ts-runner.js';
const actor = {
  userId: 'local-owner', authSessionId: 'session-a'
};
const roots: string[] = [];
const commands: ChildProcess[] = [];
afterEach(() => {
  for (const command of commands.splice(0)) {
    if (command.exitCode === null && command.signalCode === null) {
      command.kill('SIGKILL');
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, {
      recursive: true, force: true
    });
  vi.useRealTimers();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {
    promise, resolve
  };
};
/**
 * The wizard's connections manager: `begin('start')` runs `start(id)` (resolves → the
 * fleet started it, rejects → the command reported a failure), `begin('stop')` runs `stop(id)`.
 * `beforeStart` runs first, as in the real manager, and may throw. `list` is what the
 * connection list would show; the wizard asks for its own connection's row.
 */
function connections(start: (id: string) => unknown = vi.fn(async () => undefined), extra: {
  stop?: (id: string) => unknown;
  list?: () => Promise<any[]>;
} = {}): NonNullable<WecomOnboardingOptions['manager']> {
  const stop = extra.stop ?? (async () => undefined);
  const list = extra.list ?? (async () => []);
  return {
    connection: async (id: string) => (await list()).find(row => row.id === id),
    idle: async () => {},
    begin: (action: string, id: string, options: { beforeStart?: () => void } = {}) => {
      options.beforeStart?.();
      const settled = Promise.resolve()
        .then(() => (action === 'stop' ? stop(id) : start(id)))
        .then(
          (result: any) => result && typeof result === 'object' && 'ok' in result
            ? result
            : { ok: true, state: action === 'stop' ? 'stopped' : 'started', message: '' },
          (error: unknown) => ({ ok: false, reason: 'cli_failed', message: error instanceof Error ? error.message : String(error) }),
        );
      return { view: {} as any, settled };
    },
  } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
}
async function settle(service: WecomOnboardingManager, id: string, status: string) {
  await vi.waitFor(() => expect(service.get(id, actor)?.status).toBe(status), {timeout: 10_000, interval: 15});
  await new Promise(done => setImmediate(done));
}
function fixture(extra: Partial<WecomOnboardingOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-onboarding-'));
  roots.push(root);
  const authorize = vi.fn(async () => ({
    authUrl: 'https://work.weixin.qq.com/auth-safe', expiresAt: Date.now() + 60000, waitForCredentials: vi.fn(async () => ({
      botId: 'bot-id-new', secret: 'server-only-secret'
    })), cancel: vi.fn()
  }));
  const pair = vi.fn(async (options: any) => {
    options.beforeConnect?.();
    options.onChallenge('BOTMUX-123456');
    return {
      userid: 'real-user', verifiedAt: new Date().toISOString()
    };
  });
  const start = vi.fn(async (_id: string) => undefined);
  const options: WecomOnboardingOptions = {
    root, preflight: async () => ({
      appName: '显示名称', cliId: 'codex', workingDir: root, backend: 'pty', port: 19345, dirMode: 'fixed', mode: 'qr'
    }), authorize, pair, manager: connections(start), waitForReady: async () => {
    }, ...extra
  };
  const service = new WecomOnboardingManager(options);
  return {
    root, authorize, pair, start, options, service
  };
}
describe('Wecom onboarding private receipt and exact activation', () => {
  it('pairs the callback owner before an atomic config/credential save, registers only this bot and exposes no private proof', async () => {
    const f = fixture(), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'completed');
    const snapshot = f.service.get(job.id, actor)!;
    expect(snapshot).toMatchObject({
      platform: 'wecom', status: 'completed', saved: true, externalBotCreated: true, liveStarted: true
    });
    const paths = readWecomConfigPaths(f.root).filter(path => path.endsWith('/config.json') && path !== join(f.root, 'config.json'));
    expect(paths).toHaveLength(1);
    const config = parseWecomConfig(JSON.parse(readFileSync(paths[0], 'utf8')));
    expect(config.allowedUsers).toEqual(['real-user']);
    expect(readWecomCredentialFile(config.secretFile!)).toBe('server-only-secret');
    expect(config.displayName).toBe('显示名称');
    const publicJson = JSON.stringify(snapshot);
    for (const privateValue of ['server-only-secret', 'real-user', 'session-a', 'bot-id-new'])
      expect(publicJson).not.toContain(privateValue);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.service.get(job.id, {
      ...actor, authSessionId: 'session-b'
    })).toBeUndefined();
    expect(f.service.list({
      ...actor, userId: 'another'
    })).toEqual([]);
  });
  it('keeps a saved bot on start failure and retries the same connection without a new QR or owner socket', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('failure with secret')).mockResolvedValue({}), f = fixture({
      manager: connections(start)
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'failed');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'failed', saved: true, retryable: true, error: 'wecom_start_pending'
    });
    await f.service.action(job.id, 'retry', actor);
    await settle(f.service, job.id, 'completed');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'completed', saved: true
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.pair).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('persists the created credential receipt across process restart, retry never creates another platform bot', async () => {
    const f = fixture({
      pair: vi.fn(async () => {
        throw new Error('temporary');
      })
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'failed');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'failed', saved: false, externalBotCreated: true
    });
    const recovered = new WecomOnboardingManager({
      ...f.options, pair: async () => ({
        userid: 'recovered-owner', verifiedAt: new Date().toISOString()
      })
    });
    await recovered.action(job.id, 'retry', actor);
    await settle(recovered, job.id, 'completed');
    expect(recovered.get(job.id, actor)).toMatchObject({
      status: 'completed', saved: true
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });
  it('a cancelled pairing cannot save or start when its old result arrives later', async () => {
    const proof = deferred<{
      userid: string;
      verifiedAt: string;
    }>(), f = fixture({
      pair: async (options) => {
        options.onChallenge('CURRENT-CODE');
        return proof.promise;
      }
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'needs_pairing');
    expect(f.service.get(job.id, actor)?.status).toBe('needs_pairing');
    await f.service.action(job.id, 'cancel', actor);
    proof.resolve({
      userid: 'late-user', verifiedAt: new Date().toISOString()
    });
    await settle(f.service, job.id, 'cancelled');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'cancelled', saved: false
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(readWecomConfigPaths(f.root)).toEqual([join(f.root, 'config.json')]);
  });
  it('reconciles a committed config after index failure and restarts from the same credential generation', async () => {
    const register = vi.fn().mockRejectedValueOnce(new Error('index unavailable')).mockImplementation(async (file, root) => {
      const mod = await import('../src/im/wecom/config/discovery.js');
      return mod.registerWecomConfig(file, root);
    });
    const f = fixture({
      register
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'failed');
    const before = f.service.get(job.id, actor)!;
    expect(before).toMatchObject({
      status: 'failed', saved: true
    });
    await f.service.action(job.id, 'retry', actor);
    await settle(f.service, job.id, 'completed');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'completed', connectionId: before.connectionId
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.pair).toHaveBeenCalledTimes(1);
  });
  it('accepts a post-rename durability error only when the exact planned proof and secret are visible', async () => {
    const commit: typeof commitWecomConfiguration = async (options) => {
      await commitWecomConfiguration(options);
      throw new Error('directory fsync');
    };
    const f = fixture({
      commit
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'completed');
    expect(f.service.get(job.id, actor)).toMatchObject({
      status: 'completed', saved: true
    });
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('refuses to start if human edits a saved configuration while startup is awaiting retry', async () => {
    const start = vi.fn().mockRejectedValue(new Error('not yet')), f = fixture({
      manager: connections(start)
    }), job = await f.service.start({}, actor);
    await settle(f.service, job.id, 'failed');
    const path = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!;
    const before = readFileSync(path, 'utf8');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, before.replace('显示名称', 'human edit'));
    await f.service.action(job.id, 'retry', actor);
    await settle(f.service, job.id, 'failed');
    expect(start).toHaveBeenCalledTimes(1);
    expect(f.service.get(job.id, actor)?.status).toBe('failed');
  });
  it('checks the job again inside the config lock before any secret generation is written', async () => {
    const blocker = deferred<void>(), entered = deferred<void>();
    let service!: WecomOnboardingManager;
    let id = '';
    const f = fixture({
      commit: async (options) => {
        entered.resolve();
        await blocker.promise;
        return commitWecomConfiguration(options);
      }
    });
    service = f.service;
    id = (await service.start({}, actor)).id;
    await entered.promise;
    await service.action(id, 'cancel', actor);
    blocker.resolve();
    await settle(service, id, 'cancelled');
    expect(service.get(id, actor)).toMatchObject({
      status: 'cancelled', saved: false
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(readdirSync(join(f.root, 'onboarding')).filter(file => file.endsWith('.secret'))).toHaveLength(1);
  });
  it('checks local inputs before producing any platform QR', async () => {
    await expect(preflightWecomOnboarding({
      cliId: 'definitely-unknown-cli'
    })).rejects.toThrow('definitely-unknown-cli');
  });
});
it('expires a created draft with a controlled clock and never admits its late owner proof', async () => {
  let now = 1000;
  const proof = deferred<{
    userid: string;
    verifiedAt: string;
  }>();
  const f = fixture({
    now: () => now, pair: async () => proof.promise
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'verifying');
  now = job.resumeUntil + 1;
  expect(f.service.get(job.id, actor)).toMatchObject({
    status: 'failed', error: 'wecom_onboarding_expired', retryable: false
  });
  proof.resolve({
    userid: 'late-expired-user', verifiedAt: new Date(now).toISOString()
  });
  await settle(f.service, job.id, 'failed');
  expect(f.start).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(readdirSync(join(f.root, 'onboarding')).filter(file => file.endsWith('.secret'))).toEqual([]));
  await expect(f.service.action(job.id, 'retry', actor)).rejects.toThrow('wecom_onboarding_expired');
});
it('cancels a QR authorization that arrives after local cancellation without polling it', async () => {
  const auth = deferred<any>(), cancel = vi.fn(), waitForCredentials = vi.fn();
  const f = fixture({
    authorize: async () => auth.promise
  }), job = await f.service.start({}, actor);
  await f.service.action(job.id, 'cancel', actor);
  auth.resolve({
    authUrl: 'https://work.weixin.qq.com/safe', expiresAt: Date.now() + 60000, waitForCredentials, cancel
  });
  await settle(f.service, job.id, 'cancelled');
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(waitForCredentials).not.toHaveBeenCalled();
  expect(f.service.get(job.id, actor)?.status).toBe('cancelled');
});
it('a cancel after the start was requested stops that connection by its id and keeps its configuration', async () => {
  const ready = deferred<void>(), start = vi.fn(async (_id: string) => undefined), stop = vi.fn(async (_id: string) => undefined);
  const f = fixture({
    manager: connections(start, { stop }), waitForReady: async () => ready.promise
  }), job = await f.service.start({}, actor);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const connectionId = f.service.get(job.id, actor)!.connectionId!;
  expect(start).toHaveBeenCalledWith(connectionId);
  await f.service.action(job.id, 'cancel', actor);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(connectionId));
  ready.resolve();
  await settle(f.service, job.id, 'cancelled');
  expect(readWecomConfigPaths(f.root).filter(path => path !== join(f.root, 'config.json'))).toHaveLength(1);
});
it('a cancel before the start was requested stops nothing', async () => {
  const proof = deferred<{ userid: string; verifiedAt: string }>(), stop = vi.fn(async (_id: string) => undefined);
  const f = fixture({
    manager: connections(undefined, { stop }),
    pair: async (options) => {
      options.onChallenge('CURRENT-CODE');
      return proof.promise;
    },
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'needs_pairing');
  await f.service.action(job.id, 'cancel', actor);
  proof.resolve({ userid: 'late-user', verifiedAt: new Date().toISOString() });
  await settle(f.service, job.id, 'cancelled');
  await new Promise(done => setTimeout(done, 50));
  expect(stop).not.toHaveBeenCalled();
  // Nor does the next Dashboard start.
  new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop }) });
  await new Promise(done => setTimeout(done, 50));
  expect(stop).not.toHaveBeenCalled();
});
it('a cancel after the configuration was saved but before any start stops nothing', async () => {
  const register = vi.fn().mockRejectedValueOnce(new Error('index unavailable'));
  const stop = vi.fn(async (_id: string) => undefined);
  const f = fixture({ register, manager: connections(undefined, { stop }) }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  expect(f.service.get(job.id, actor)).toMatchObject({ saved: true });
  await f.service.action(job.id, 'cancel', actor);
  await new Promise(done => setTimeout(done, 50));
  expect(stop).not.toHaveBeenCalled();
});
it('a Dashboard restarted mid-wizard still stops, on cancel, the connection the earlier process asked to start', async () => {
  const ready = deferred<void>(), start = vi.fn(async (_id: string) => undefined);
  const f = fixture({ manager: connections(start), waitForReady: async () => ready.promise }), job = await f.service.start({}, actor);
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  const connectionId = f.service.get(job.id, actor)!.connectionId!;
  const stop = vi.fn(async (_id: string) => undefined);
  const restarted = new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop }) });
  expect(restarted.get(job.id, actor)).toMatchObject({ status: 'failed', error: 'wecom_onboarding_interrupted', saved: true, retryable: true });
  await restarted.action(job.id, 'cancel', actor);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(connectionId));
  ready.resolve();
});
it('a wizard that gives up waiting keeps the connection set to run and does not stop it', async () => {
  const stop = vi.fn(async (_id: string) => undefined);
  const f = fixture({
    manager: connections(undefined, { stop }),
    waitForReady: async () => {
      throw new Error('wecom_connection_not_ready');
    },
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  expect(f.service.get(job.id, actor)).toMatchObject({ status: 'failed', error: 'wecom_start_pending', saved: true, retryable: true });
  expect(stop).not.toHaveBeenCalled();
});
it('reports a fleet that is not running as "saved, set to run, comes online after botmux start"', async () => {
  const start = vi.fn(async () => ({ ok: false, reason: 'fleet_down', message: 'fleet 未在运行' }));
  const f = fixture({ manager: connections(start) }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  const snapshot = f.service.get(job.id, actor)!;
  expect(snapshot).toMatchObject({ error: 'wecom_start_pending', saved: true, retryable: true });
  expect(snapshot.message).toContain('botmux start');
});
it('shows the command\'s own reason when the fleet could not start the connection', async () => {
  const start = vi.fn(async () => ({ ok: false, reason: 'gateway_exited', message: 'fixture-gateway-exited-detail' }));
  const f = fixture({ manager: connections(start) }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  expect(f.service.get(job.id, actor)!.message).toContain('fixture-gateway-exited-detail');
});
it('does not ask the fleet again for a connection it already runs (a retry after the wizard gave up waiting)', async () => {
  const { createHash } = await import('node:crypto');
  const { wecomConfigId } = await import('../src/im/wecom/config/discovery.js');
  const f0 = fixture();
  const file = join(f0.root, 'connections', createHash('sha256').update('bot-id-new').digest('hex'), 'config.json');
  const start = vi.fn(async (_id: string) => undefined);
  const service = new WecomOnboardingManager({
    ...f0.options,
    manager: connections(start, { list: async () => [{ id: wecomConfigId(file), ownership: 'fleet', desired: 'running', gateway: 'starting' }] }),
  });
  const job = await service.start({}, actor);
  await settle(service, job.id, 'completed');
  expect(start).not.toHaveBeenCalled();
});
it('stops waiting at once when the gateway stopped itself with a reason, and shows it', async () => {
  let id = '';
  const start = vi.fn(async (connectionId: string) => {
    id = connectionId;
  });
  const list = async () => (id ? [{ id, ownership: 'none', gateway: 'stopped', desired: 'stopped', stopReason: 'authentication_failed', message: 'fixture-auth-rejected' }] : []);
  const f = fixture({ manager: connections(start, { list }), waitForReady: undefined }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  expect(f.service.get(job.id, actor)!.message).toContain('fixture-auth-rejected');
});
it('a reconstructed manager cancels the durable generation and an old process cannot overwrite it or save its late proof', async () => {
  const proof = deferred<{
    userid: string;
    verifiedAt: string;
  }>(), f = fixture({
    pair: async () => proof.promise
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'verifying');
  const restored = new WecomOnboardingManager(f.options);
  await restored.action(job.id, 'cancel', actor);
  proof.resolve({
    userid: 'obsolete-owner', verifiedAt: new Date().toISOString()
  });
  await settle(restored, job.id, 'cancelled');
  expect(new WecomOnboardingManager(f.options).get(job.id, actor)).toMatchObject({
    status: 'cancelled', saved: false
  });
  expect(f.start).not.toHaveBeenCalled();
});
it('an initial draft write failure preserves the created bot identity and retry never requests another platform QR', async () => {
  const { atomicWriteFileSync } = await import('../src/utils/atomic-write.js');
  const writeDraft = vi.fn().mockImplementationOnce(() => {
    throw new Error('disk temporarily unavailable');
  }).mockImplementation(atomicWriteFileSync);
  const f = fixture({
    writeDraft
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'failed');
  expect(f.service.get(job.id, actor)).toMatchObject({
    status: 'failed', externalBotCreated: true, retryable: true, saved: false
  });
  await f.service.action(job.id, 'retry', actor);
  await settle(f.service, job.id, 'completed');
  expect(f.service.get(job.id, actor)?.status).toBe('completed');
  expect(f.authorize).toHaveBeenCalledTimes(1);
});
it('recovers an atomic private credential envelope committed before its job receipt update', async () => {
  const waiting = deferred<{
    botId: string;
    secret: string;
  }>(), authorize = vi.fn(async () => ({
    authUrl: 'https://work.weixin.qq.com/qr', expiresAt: Date.now() + 60000, waitForCredentials: async () => waiting.promise, cancel: () => {
    }
  }));
  const f = fixture({
    authorize
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'waiting_for_scan');
  expect(f.service.get(job.id, actor)?.status).toBe('waiting_for_scan');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(f.root, 'onboarding', `${job.id}.secret`), JSON.stringify({
    botId: 'already-created-bot', secret: 'already-created-secret'
  }), {
    mode: 0o600
  });
  const recovered = new WecomOnboardingManager(f.options);
  expect(recovered.get(job.id, actor)).toMatchObject({
    status: 'failed', externalBotCreated: true, retryable: true
  });
  await recovered.action(job.id, 'retry', actor);
  await settle(recovered, job.id, 'completed');
  expect(recovered.get(job.id, actor)?.status).toBe('completed');
  expect(authorize).toHaveBeenCalledTimes(1);
  waiting.resolve({
    botId: 'late-bot', secret: 'late-secret'
  });
  await settle(recovered, job.id, 'completed');
  expect(new WecomOnboardingManager(f.options).get(job.id, actor)?.status).toBe('completed');
  expect(f.start).toHaveBeenCalledTimes(1);
});
it('preserves another CLI, its model, wrapper and tmux backend through the common managed-core configuration', async () => {
  const f = fixture();
  const service = new WecomOnboardingManager({
    ...f.options, preflight: async () => ({
      appName: 'other-cli', cliId: 'claude-code', wrapperCli: 'aiden x claude', workingDir: f.root, backend: 'tmux', model: 'sonnet', dirMode: 'card', mode: 'qr', port: 19346
    })
  });
  const job = await service.start({}, actor);
  await settle(service, job.id, 'completed');
  expect(service.get(job.id, actor)?.status).toBe('completed');
  const path = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!, config = parseWecomConfig(JSON.parse(readFileSync(path, 'utf8')));
  expect(config.managedCore).toMatchObject({
    cli: 'claude-code', backend: 'tmux', model: 'sonnet', workingDirectory: f.root, botConfig: {
      wrapperCli: 'aiden x claude'
    }
  });
  expect(config.managedCore?.botConfig?.defaultWorkingDir).toBeUndefined();
});
it('requires authenticated connected runtime and a live child core proof, and rechecks connection after the proof request', async () => {
  const { WecomDashboardSessions } = await import('../src/dashboard/wecom/sessions.js');
  const { wecomBotRoot } = await import('../src/im/wecom/config/runtime.js');
  const { wecomConfigId } = await import('../src/im/wecom/config/discovery.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const f = fixture(), file = join(f.root, 'config.json'), core = join(f.root, 'core'), botId = 'readiness-bot', coreBotId = 'local_readiness', now = Date.now();
  writeFileSync(file, JSON.stringify({
    botId, secretEnv: 'FIXTURE', allowedUsers: ['owner'], coreUrl: 'http://127.0.0.1:19347', managedCore: {
      cli: 'codex', backend: 'pty', workingDirectory: f.root, port: 19347, stateDir: core, botId: coreBotId
    }
  }));
  mkdirSync(join(core, 'dashboard-daemons'), {
    recursive: true
  });
  writeFileSync(join(core, 'dashboard-daemons', `${coreBotId}.json`), JSON.stringify({
    larkAppId: coreBotId, ipcPort: 19347, pid: 200, bootInstanceId: 'core-boot', lastHeartbeat: now
  }));
  const runtimeFile = join(wecomBotRoot(botId, f.root), 'runtime.json');
  mkdirSync(wecomBotRoot(botId, f.root), {
    recursive: true
  });
  const runtime = {
    version: 1, configId: wecomConfigId(file), instanceId: 'instance', pid: 100, processStart: 'gateway-birth', connection: 'connected', phase: 'running', updatedAt: now, control: {
      port: 12345, instanceId: 'instance'
    }
  };
  writeFileSync(runtimeFile, JSON.stringify(runtime));
  let disconnect = false, ready = false;
  const probe = vi.fn(async (_port:number,path:string) => {
    if(path==='/healthz')return new Response(JSON.stringify({ok:ready}),{status:ready?200:503});
    if (disconnect)
      writeFileSync(runtimeFile, JSON.stringify({
        ...runtime, connection: 'disconnected'
      }));
    return new Response(JSON.stringify({
      coreOnly: true, coreBotId, bootInstanceId: 'core-boot', pid: 200, processStart: 'core-birth'
    }));
  });
  const service = new WecomDashboardSessions({
    root: f.root, now: () => now, runtime: {
      readIdentity: pid => pid === 100 ? 'gateway-birth' : pid === 200 ? 'core-birth' : undefined, readCommandLine: () => undefined, readPidNamespace: () => undefined, pidExists: pid => [100, 200].includes(pid)
    }, readParentPid: pid => pid === 200 ? 100 : undefined, fetchCore: probe
  });
  expect(await service.coreReady(wecomConfigId(file))).toBe(false);
  ready = true;
  expect(await service.coreReady(wecomConfigId(file))).toBe(true);
  disconnect = true;
  expect(await service.coreReady(wecomConfigId(file))).toBe(false);
  probe.mockClear();
  expect(await service.coreReady(wecomConfigId(file))).toBe(false);
  expect(probe).not.toHaveBeenCalled();
});
it('rejects malformed manual credentials without an orphan job and never substitutes a platform QR for manual setup', async () => {
  const f = fixture();
  const options = {
    ...f.options, preflight: async () => ({
      appName: 'manual', cliId: 'codex', workingDir: f.root, backend: 'pty' as const, port: 19345, dirMode: 'fixed' as const, mode: 'manual' as const
    })
  };
  const service = new WecomOnboardingManager(options);
  await expect(service.start({
    botId: 'existing-bot', secret: ''
  }, actor)).rejects.toThrow('wecom_invalid_credentials');
  expect(service.list(actor)).toEqual([]);
  expect(f.authorize).not.toHaveBeenCalled();
});
it.each(['ou_native_callback_user', 'on_native_callback_user'])('treats authenticated native userid %s as opaque and makes the initial pairing owner the allowed user, who operates and approves', async (userid) => {
  const { emptyNativeCoreState, nativeCanApprove, nativeCapability, nativeGrant } = await import('../src/im/wecom/gateway/native-core.js');
  const f = fixture({
    pair: async () => ({
      userid, verifiedAt: new Date().toISOString()
    })
  }), job = await f.service.start({}, actor);
  await settle(f.service, job.id, 'completed');
  expect(f.service.get(job.id, actor)?.status).toBe('completed');
  const path = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!, config = parseWecomConfig(JSON.parse(readFileSync(path, 'utf8'))), policy = {
    allowedUsers: config.allowedUsers, ...config.native
  }, state = emptyNativeCoreState();
  // Allowed users are the approvers: the owner is the one allowed user, with no separate approver list.
  expect(config.allowedUsers).toEqual([userid]);
  expect(config.native).toBeUndefined();
  expect(nativeCapability(state, policy, {
    userId: userid, chatType: 'single', conversationId: userid
  }, 1000)).toBe('operate');
  expect(nativeCanApprove(policy, userid)).toBe(true);
  nativeGrant(state, policy, userid, 'guest', 'group:team', 'talk', 1000);
  expect(nativeCapability(state, policy, {
    userId: 'guest', chatType: 'group', conversationId: 'team'
  }, 1001)).toBe('talk');
  expect(nativeCanApprove(policy, 'guest')).toBe(false);
});

async function controlledReadinessOnboarding(){
  const {WecomDashboardSessions}=await import('../src/dashboard/wecom/sessions.js');const {wecomBotRoot}=await import('../src/im/wecom/config/runtime.js');const {wecomConfigId}=await import('../src/im/wecom/config/discovery.js');const {mkdirSync,writeFileSync}=await import('node:fs');
  const f=fixture();let ready=false,config:any,id='';const calls:string[]=[];
  const sessions=new WecomDashboardSessions({root:f.root,runtime:{readIdentity:pid=>pid===100?'gateway-birth':pid===200?'core-birth':undefined,readCommandLine:()=>undefined,readPidNamespace:()=>undefined,pidExists:pid=>[100,200].includes(pid)},readParentPid:pid=>pid===200?100:undefined,fetchCore:async(_port,path,init)=>{
    calls.push(path);if(path==='/healthz'){expect(new Headers(init?.headers).get('x-botmux-expected-core-boot')).toBe('core-boot');return new Response(JSON.stringify({ok:ready}),{status:ready?200:503});}
    return new Response(JSON.stringify({coreOnly:true,coreBotId:config.managedCore.botId,bootInstanceId:'core-boot',pid:200,processStart:'core-birth'}));
  }});
  const start=vi.fn(async(connectionId:string)=>{
    id=connectionId;const path=readWecomConfigPaths(f.root).find(file=>wecomConfigId(file)===id)!;config=parseWecomConfig(JSON.parse(readFileSync(path,'utf8')));
    const core=config.managedCore,botRoot=wecomBotRoot(config.botId,f.root);mkdirSync(botRoot,{recursive:true});mkdirSync(join(core.stateDir,'dashboard-daemons'),{recursive:true});
    writeFileSync(join(botRoot,'runtime.json'),JSON.stringify({version:1,configId:id,instanceId:'instance',pid:100,processStart:'gateway-birth',connection:'connected',phase:'running',updatedAt:Date.now(),control:{port:12345,instanceId:'instance'}}));
    writeFileSync(join(core.stateDir,'dashboard-daemons',`${core.botId}.json`),JSON.stringify({larkAppId:core.botId,ipcPort:core.port,pid:200,bootInstanceId:'core-boot',lastHeartbeat:Date.now()}));return{}as any;
  });
  const service=new WecomOnboardingManager({...f.options,waitForReady:undefined,coreSessions:sessions,manager:connections(start,{list:async()=>[{id,gateway:'running',connection:'connected',ownership:'fleet'}as any]})});
  return{...f,service,calls,setReady:()=>{ready=true;}};
}
it('keeps a real onboarding manager saved and starting while authenticated child core is restoring, then completes only on healthz ok',async()=>{
  const f=await controlledReadinessOnboarding(),job=await f.service.start({},actor);await vi.waitFor(()=>expect(f.calls).toContain('/healthz'));
  expect(f.service.get(job.id,actor)).toMatchObject({status:'starting_bot',saved:true});f.setReady();await settle(f.service,job.id,'completed');
});
it('a cancelled generation cannot complete when core restoration later becomes healthy',async()=>{
  const f=await controlledReadinessOnboarding(),job=await f.service.start({},actor);await vi.waitFor(()=>expect(f.calls).toContain('/healthz'));
  await f.service.action(job.id,'cancel',actor);f.setReady();await settle(f.service,job.id,'cancelled');expect(new WecomOnboardingManager(f.options).get(job.id,actor)?.status).toBe('cancelled');
});

/** The id of the connection the default fixture's wizard creates (bot `bot-id-new`). */
async function createdConnectionId(root: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { wecomConfigId } = await import('../src/im/wecom/config/discovery.js');
  return wecomConfigId(join(root, 'connections', createHash('sha256').update('bot-id-new').digest('hex'), 'config.json'));
}

/** A connections manager whose idle() answers come from `idles` in order (then resolve at once). */
function recordingConnections(idles: Array<Promise<void>> = [], list: () => Promise<any[]> = async () => []) {
  const begun: Array<{ action: string; id: string; options: any }> = [];
  const idle = vi.fn(async () => idles.shift());
  const manager = {
    connection: async (id: string) => (await list()).find(row => row.id === id),
    idle,
    begin: (action: string, id: string, options: any = {}) => {
      options.beforeStart?.();
      begun.push({ action, id, options });
      return { view: {} as any, settled: Promise.resolve({ ok: true, message: '' }) };
    },
  } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
  return { manager, begun, idle };
}

it('still starts a connection the fleet holds but that is recorded as stopped', async () => {
  const f0 = fixture();
  const id = await createdConnectionId(f0.root);
  const start = vi.fn(async (_id: string) => undefined);
  const service = new WecomOnboardingManager({
    ...f0.options,
    manager: connections(start, { list: async () => [{ id, ownership: 'fleet', desired: 'stopped', gateway: 'stopping', notice: 'stop_pending' }] }),
  });
  const job = await service.start({}, actor);
  await settle(service, job.id, 'completed');
  expect(start).toHaveBeenCalledExactlyOnceWith(id);
});

it('waits for another action on the connection to end before starting it', async () => {
  const other = deferred<void>();
  const r = recordingConnections([other.promise]);
  const f = fixture({ manager: r.manager }), job = await f.service.start({}, actor);
  await vi.waitFor(() => expect(r.idle).toHaveBeenCalledTimes(1));
  await new Promise(done => setTimeout(done, 30));
  expect(r.begun).toEqual([]);
  other.resolve();
  await settle(f.service, job.id, 'completed');
  expect(r.begun.map(item => item.action)).toEqual(['start']);
});

it('rolls back with a stop that is forced, after the action still running on the connection ends', async () => {
  const ready = deferred<void>(), running = deferred<void>();
  const r = recordingConnections([Promise.resolve(), running.promise]);
  const f = fixture({ manager: r.manager, waitForReady: async () => ready.promise }), job = await f.service.start({}, actor);
  await vi.waitFor(() => expect(r.begun.map(item => item.action)).toEqual(['start']));
  await f.service.action(job.id, 'cancel', actor);
  await vi.waitFor(() => expect(r.idle).toHaveBeenCalledTimes(2));
  await new Promise(done => setTimeout(done, 30));
  expect(r.begun.map(item => item.action)).toEqual(['start']);
  running.resolve();
  await vi.waitFor(() => expect(r.begun.map(item => item.action)).toEqual(['start', 'stop']));
  expect(r.begun[1]).toMatchObject({ id: f.service.get(job.id, actor)!.connectionId, options: { force: true } });
  ready.resolve();
});

/**
 * The wizard's connections manager in a Dashboard that goes away right after
 * a cancel: `begin('start')` spawns `command` (a stand-in for `botmux wecom
 * start`, still running) and never hears back; from then on this process's own
 * view of the connection never goes idle, so it never gets to stop anything.
 */
function vanishingConnections(command: ChildProcess) {
  let started = false;
  return {
    connection: async () => undefined,
    idle: () => (started ? new Promise<void>(() => {}) : Promise.resolve()),
    begin: (action: string, _id: string, options: { beforeStart?: () => void; onSpawn?: (pid: number) => void } = {}) => {
      options.beforeStart?.();
      if (action === 'start') {
        started = true;
        options.onSpawn?.(command.pid!);
      }
      return { view: {} as any, settled: new Promise(() => {}) };
    },
  } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
}

describe('the stop a cancel owes the connection it started', () => {
  it('a Dashboard with no WeCom wizard receipts starts without touching any connection or file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-onboarding-none-'));
    roots.push(root);
    const begin = vi.fn(), connection = vi.fn(async () => undefined), idle = vi.fn(async () => {});
    new WecomOnboardingManager({ root, manager: { begin, connection, idle } as any });
    await new Promise(done => setTimeout(done, 50));
    expect(begin).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it('outlives the Dashboard that accepted the cancel: the next one waits for the start command, then stops it once', async () => {
    const command = spawnTsEval('setTimeout(() => {}, 1500);', { stdio: 'ignore' });
    commands.push(command);
    const f = fixture({ manager: vanishingConnections(command), waitForReady: async () => new Promise(() => {}) });
    const job = await f.service.start({}, actor);
    await vi.waitFor(() => expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'));
    const connectionId = f.service.get(job.id, actor)!.connectionId!;
    await new Promise(done => setTimeout(done, 50));
    await f.service.action(job.id, 'cancel', actor);

    // The Dashboard is restarted right after answering; the start command it spawned keeps running.
    const stop = vi.fn(async (_id: string) => undefined);
    new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop }), startCommandPollMs: 20 });
    await new Promise(done => setTimeout(done, 300));
    expect(command.exitCode).toBeNull();
    expect(stop).not.toHaveBeenCalled();

    await once(command, 'exit');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(connectionId));

    // Settled for good: yet another Dashboard start stops nothing.
    const again = vi.fn(async (_id: string) => undefined);
    const later = new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop: again }) });
    await new Promise(done => setTimeout(done, 100));
    expect(again).not.toHaveBeenCalled();
    expect(later.get(job.id, actor)?.status).toBe('cancelled');
    // Nor does cancelling the settled job again: it no longer stands for a start.
    await later.action(job.id, 'cancel', actor);
    await new Promise(done => setTimeout(done, 100));
    expect(again).not.toHaveBeenCalled();
  }, 20_000);

  it('retries a stop that fails, says so on the connection after the last attempt, and the next Dashboard tries again', async () => {
    const ready = deferred<void>();
    const stop = vi.fn(async (_id: string) => ({ ok: false, reason: 'fleet_busy', message: 'another fleet operation holds the lock' }));
    const noted: Array<{ id: string; action: string; reason: string }> = [];
    const manager = {
      ...connections(undefined, { stop }),
      noteFailure: (id: string, failure: { action: string; reason: string; message: string }) => noted.push({ id, ...failure }),
    } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
    const f = fixture({ manager, waitForReady: async () => ready.promise, stopRetryDelaysMs: [10, 10] });
    const job = await f.service.start({}, actor);
    await vi.waitFor(() => expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'));
    const connectionId = f.service.get(job.id, actor)!.connectionId!;

    await f.service.action(job.id, 'cancel', actor);

    await vi.waitFor(() => expect(noted).toHaveLength(1));
    expect(stop).toHaveBeenCalledTimes(3);
    expect(noted[0]).toMatchObject({ id: connectionId, action: 'stop', reason: 'fleet_busy' });
    const succeeding = vi.fn(async (_id: string) => undefined);
    new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop: succeeding }) });
    await vi.waitFor(() => expect(succeeding).toHaveBeenCalledExactlyOnceWith(connectionId));
    ready.resolve();
  });

  it('leaves be a start a person made after the stop was given up on', async () => {
    const ready = deferred<void>();
    const stop = vi.fn(async (_id: string) => ({ ok: false, reason: 'fleet_busy', message: 'busy' }));
    const noted: unknown[] = [];
    const manager = {
      ...connections(undefined, { stop }),
      noteFailure: (_id: string, failure: unknown) => noted.push(failure),
    } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
    const f = fixture({ manager, waitForReady: async () => ready.promise, stopRetryDelaysMs: [10] });
    const job = await f.service.start({}, actor);
    await vi.waitFor(() => expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'));
    const connectionId = f.service.get(job.id, actor)!.connectionId!;
    await f.service.action(job.id, 'cancel', actor);
    await vi.waitFor(() => expect(noted).toHaveLength(1));
    ready.resolve();

    // Seeing the failure, the person starts the connection from the list.
    await new Promise(done => setTimeout(done, 5));
    setWecomFleetDesiredState(connectionId, 'running', { root: f.root });

    const later = vi.fn(async (_id: string) => undefined);
    new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop: later }) });
    await new Promise(done => setTimeout(done, 200));
    expect(later).not.toHaveBeenCalled();
    // Nor does a further Dashboard start come back to it.
    new WecomOnboardingManager({ ...f.options, manager: connections(undefined, { stop: later }) });
    await new Promise(done => setTimeout(done, 100));
    expect(later).not.toHaveBeenCalled();
  });

  it('is taken back when the job is retried, even while it still waits for the start command', async () => {
    const command = spawnTsEval('setTimeout(() => {}, 800);', { stdio: 'ignore' });
    commands.push(command);
    const stop = vi.fn(async (_id: string) => undefined);
    let starts = 0;
    const manager = {
      connection: async () => undefined,
      idle: async () => {},
      begin: (action: string, id: string, options: { beforeStart?: () => void; onSpawn?: (pid: number) => void } = {}) => {
        options.beforeStart?.();
        if (action === 'start') {
          starts++;
          options.onSpawn?.(command.pid!);
          return { view: {} as any, settled: Promise.resolve({ ok: true, state: 'started', message: '' }) };
        }
        return { view: {} as any, settled: Promise.resolve(stop(id)).then(() => ({ ok: true, state: 'stopped', message: '' })) };
      },
    } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
    const ready = deferred<void>();
    const f = fixture({ manager, waitForReady: async () => ready.promise, startCommandPollMs: 20 });
    const job = await f.service.start({}, actor);
    await vi.waitFor(() => expect(starts).toBe(1));
    await f.service.action(job.id, 'cancel', actor);
    await settle(f.service, job.id, 'cancelled');
    ready.resolve();

    // The person changes their mind before the start command has ended.
    await vi.waitFor(() => f.service.action(job.id, 'retry', actor));
    expect(command.exitCode).toBeNull();
    await settle(f.service, job.id, 'completed');
    await once(command, 'exit');
    await new Promise(done => setTimeout(done, 100));
    expect(stop).not.toHaveBeenCalled();
  }, 20_000);
});
