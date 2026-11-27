/**
 * A native gateway core takes a new core profile while it runs
 * (core/native-gateway-core-profile.ts, POST NATIVE_GATEWAY_ROUTE_PATTERNS.coreProfile):
 *  - a core started on configuration A that took B registers exactly the bot a
 *    core started on B does (same synthesis, in place);
 *  - a candidate that does not validate as a whole changes nothing, not one key;
 *  - after the change, loadBotConfigs(), the registered bot and a worker's
 *    fork environment all synthesize the new settings;
 *  - only a native gateway core has the route: a Feishu daemon and a bare
 *    core-only service answer 404 and load the same bots as before.
 *
 * Real registry, real synthesis, a real IPC server on loopback with a test secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testOnly_resetBotRegistry,
  getBot,
  loadBotConfigs,
  registerBot,
  synthesizeCoreOnlyBotConfig,
  type BotConfig,
} from '../src/bot-registry.js';
import { applyNativeGatewayCoreProfile } from '../src/core/native-gateway-core-profile.js';
import {
  NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS,
  nativeGatewayCoreProfilePath,
  type NativeGatewayCoreProfile,
} from '../src/core/native-gateway-contract.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { findActiveBySessionId, sessionEnvWorkerBase, setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';
import type { CliId } from '../src/adapters/cli/types.js';
import {
  wecomManagedCoreProfileEnvironment,
  type WecomManagedCoreConfig,
} from '../src/im/wecom/config/managed-core-env.js';

const BOT = 'local_profile_fixture';
const SECRET = 'core-profile-fixture-dashboard-secret';
const MODE_KEYS = ['BOTMUX_CORE_ONLY', 'BOTMUX_NATIVE_GATEWAY_CORE', 'BOTMUX_API_ONLY_BOT', 'BOTMUX_CORE_CODEX_AUTH_SYNC', 'BOTS_CONFIG'];
const TOUCHED = [...MODE_KEYS, ...NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS];
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
let server: IpcServerHandle | undefined;

beforeEach(() => {
  for (const key of TOUCHED) saved.set(key, process.env[key]);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  setActiveSessionsRegistry(undefined);
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), 'core-profile-'));
  dirs.push(path);
  return path;
}

type Mode = 'native' | 'bare' | 'feishu';

function setMode(mode: Mode, profile: NativeGatewayCoreProfile = {}): void {
  for (const key of TOUCHED) delete process.env[key];
  if (mode !== 'feishu') {
    process.env.BOTMUX_CORE_ONLY = '1';
    process.env.BOTMUX_API_ONLY_BOT = BOT;
    Object.assign(process.env, profile);
  }
  if (mode === 'native') process.env.BOTMUX_NATIVE_GATEWAY_CORE = '1';
}

function profileOf(config: WecomManagedCoreConfig): NativeGatewayCoreProfile {
  return wecomManagedCoreProfileEnvironment(config);
}

/** A core started on `config`: what its daemon registers at boot. */
function boot(config: WecomManagedCoreConfig, mode: Mode = 'native'): BotConfig {
  __testOnly_resetBotRegistry();
  setMode(mode, profileOf(config));
  return registerBot(loadBotConfigs()[0]!).config;
}

function coreConfig(overrides: Partial<NonNullable<WecomManagedCoreConfig['managedCore']>> = {}, message?: { goalStatusCard?: boolean }): WecomManagedCoreConfig {
  return {
    managedCore: {
      botId: BOT,
      cli: 'codex',
      backend: 'pty',
      workingDirectory: '/srv/core-profile/root-a',
      port: 19555,
      stateDir: '/srv/core-profile/state',
      botConfig: { startupCommands: ['/status'], maxLiveWorkers: 3 },
      ...overrides,
    },
    ...(message ? { message } : {}),
  };
}

const coreEnvSnapshot = () => Object.fromEntries(NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS.map(key => [key, process.env[key]]));

describe('a core that took a profile registers what a core started on it does', () => {
  const cases: Array<[string, WecomManagedCoreConfig, WecomManagedCoreConfig]> = [
    ['the CLI', coreConfig(), coreConfig({ cli: 'claude-code' })],
    ['a model where there was none', coreConfig(), coreConfig({ model: 'gpt-5.5' })],
    ['no model where there was one', coreConfig({ model: 'gpt-5.5' }), coreConfig()],
    ['the backend', coreConfig(), coreConfig({ backend: 'tmux' })],
    ['the working directory', coreConfig(), coreConfig({ workingDirectory: '/srv/core-profile/root-b' })],
    ['a profile key added', coreConfig(), coreConfig({ botConfig: { startupCommands: ['/status'], maxLiveWorkers: 3, idleSuspendMinutes: 15, env: { FIXTURE_FLAG: 'on' } } })],
    ['a profile key removed', coreConfig(), coreConfig({ botConfig: { startupCommands: ['/status'] } })],
    ['a profile key changed', coreConfig(), coreConfig({ botConfig: { startupCommands: ['/compact'], maxLiveWorkers: 7 } })],
    ['goalStatusCard from the message settings', coreConfig(), coreConfig({}, { goalStatusCard: true })],
    ['an env policy', coreConfig(), coreConfig({ botConfig: { envPolicy: { mode: 'strict', inherit: ['LANG'] } } })],
  ];

  it.each(cases)('%s', (_name, a, b) => {
    const started = boot(b);
    const expected = structuredClone(started);
    const registered = boot(a);
    const result = applyNativeGatewayCoreProfile(BOT, { env: profileOf(b) });
    expect(result).toEqual({ ok: true, changed: true });
    // Replaced in place: every holder of the config object sees the change.
    expect(getBot(BOT).config).toBe(registered);
    expect(getBot(BOT).config).toStrictEqual(expected);
    expect(coreEnvSnapshot()).toEqual({ ...Object.fromEntries(NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS.map(key => [key, undefined])), ...profileOf(b) });
  });

  it('reports an unchanged profile as unchanged and leaves the config as it was', () => {
    const registered = boot(coreConfig());
    const before = structuredClone(registered);
    expect(applyNativeGatewayCoreProfile(BOT, { env: profileOf(coreConfig()) })).toEqual({ ok: true, changed: false });
    expect(getBot(BOT).config).toStrictEqual(before);
  });
});

describe('new sessions and workers see the new settings', () => {
  it.each([
    ['inheriting env policy', coreConfig({ cli: 'claude-code', model: 'opus', backend: 'tmux' })],
    ['strict env policy', coreConfig({ cli: 'claude-code', model: 'opus', botConfig: { envPolicy: { mode: 'strict', inherit: [] } } })],
  ])('loadBotConfigs(), the registered bot and a worker fork environment agree (%s)', (_name, next) => {
    boot(coreConfig());
    expect(applyNativeGatewayCoreProfile(BOT, { env: profileOf(next) }).ok).toBe(true);
    const loaded = loadBotConfigs()[0]!;
    const worker = synthesizeCoreOnlyBotConfig(sessionEnvWorkerBase(getBot(BOT).config.envPolicy));
    expect(loaded).toStrictEqual(worker);
    expect(getBot(BOT).config).toEqual(loaded);
    expect(loaded).toMatchObject({ cliId: 'claude-code', model: 'opus' });
  });
});

describe('a candidate that does not validate as a whole changes nothing', () => {
  const valid = () => profileOf(coreConfig({ cli: 'claude-code', model: 'opus' }));
  const invalid: Array<[string, unknown]> = [
    ['an unknown profile key', { env: { ...valid(), BOTMUX_CORE_BOT_CONFIG: JSON.stringify({ notAProfileKey: true }) } }],
    ['a profile that is not JSON', { env: { ...valid(), BOTMUX_CORE_BOT_CONFIG: '{"startupCommands":' } }],
    ['an unsupported backend', { env: { ...valid(), BOTMUX_CORE_BACKEND: 'not-a-backend' } }],
    ['an unknown CLI', { env: { ...valid(), BOTMUX_CORE_CLI: 'not-a-cli' } }],
    ['a relative working directory', { env: { ...valid(), BOTMUX_CORE_WORKING_DIR: 'relative/dir' } }],
    ['a key outside the profile', { env: { ...valid(), BOTMUX_API_ONLY_BOT: 'local_other' } }],
    ['a missing required key', { env: Object.fromEntries(Object.entries(valid()).filter(([key]) => key !== 'BOTMUX_CORE_CLI')) }],
    ['a body with more than the env', { env: valid(), extra: true }],
  ];

  it.each(invalid)('%s', (_name, body) => {
    const registered = boot(coreConfig({ model: 'gpt-5.5' }));
    const env = coreEnvSnapshot();
    const config = JSON.stringify(registered);
    expect(applyNativeGatewayCoreProfile(BOT, body)).toEqual({ ok: false, error: 'invalid_core_profile' });
    expect(coreEnvSnapshot()).toEqual(env);
    expect(getBot(BOT).config).toBe(registered);
    expect(JSON.stringify(getBot(BOT).config)).toBe(config);
    expect(JSON.stringify(loadBotConfigs()[0])).toBe(JSON.stringify(synthesizeCoreOnlyBotConfig({ ...process.env })));
  });
});

describe('the core profile route', () => {
  async function listen(): Promise<void> {
    setIpcAuthSecret(SECRET);
    setLarkAppId(BOT);
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  }
  async function post(body: unknown): Promise<{ status: number; body: any }> {
    const path = nativeGatewayCoreProfilePath();
    const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: daemonIpcAuthHeaders({ secret: SECRET, port: server!.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }),
    });
    return { status: response.status, body: await response.json() };
  }
  /** The next turn of a conversation, as the gateway sends it (bridge/inbound.ts). */
  async function postTrigger(sessionId: string): Promise<{ status: number; body: any }> {
    const path = '/api/trigger';
    const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
      method: 'POST',
      body: JSON.stringify({
        source: { type: 'webhook', connectorId: 'wecom:fixture', requestId: `next-${sessionId}` },
        target: { kind: 'turn', sessionId },
        envelope: { format: 'text', sourceName: 'fixture', trusted: false, rawText: 'next question' },
        payloadTrusted: true,
        options: { asyncReturnSessionId: true, turnIdempotencyKey: 'f'.repeat(64) },
      }),
      headers: daemonIpcAuthHeaders({ secret: SECRET, port: server!.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }),
    });
    return { status: response.status, body: await response.json() };
  }

  it('applies a valid profile in a native gateway core and rejects an invalid one with 400', async () => {
    boot(coreConfig());
    await listen();
    expect(await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(getBot(BOT).config.cliId).toBe('claude-code');
    expect(await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).toEqual({ status: 200, body: { ok: true, changed: false } });
    const before = JSON.stringify(getBot(BOT).config);
    expect((await post({ env: { ...profileOf(coreConfig()), BOTMUX_CORE_BACKEND: 'not-a-backend' } })).status).toBe(400);
    expect(JSON.stringify(getBot(BOT).config)).toBe(before);
  });

  it('does not exist in a bare core-only service', async () => {
    boot(coreConfig(), 'bare');
    const sessions = liveSessions();
    const mismatched = sessions.open('claude-code');
    const loaded = JSON.stringify(loadBotConfigs());
    const env = coreEnvSnapshot();
    await listen();
    expect((await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).status).toBe(404);
    expect(coreEnvSnapshot()).toEqual(env);
    expect(JSON.stringify(loadBotConfigs())).toBe(loaded);
    expect(sessions.isOpen(mismatched)).toBe(true);
  });

  it('does not exist in a Feishu daemon', async () => {
    const root = dir();
    const botsFile = join(root, 'bots.json');
    writeFileSync(botsFile, JSON.stringify([{ larkAppId: BOT, apiOnly: true, cliId: 'codex' }]));
    __testOnly_resetBotRegistry();
    setMode('feishu');
    process.env.BOTS_CONFIG = botsFile;
    const loaded = JSON.stringify(loadBotConfigs());
    registerBot(loadBotConfigs()[0]!);
    const sessions = liveSessions();
    const mismatched = sessions.open('claude-code');
    await listen();
    expect((await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).status).toBe(404);
    expect(coreEnvSnapshot()).toEqual(Object.fromEntries(NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS.map(key => [key, undefined])));
    expect(JSON.stringify(loadBotConfigs())).toBe(loaded);
    expect(getBot(BOT).config.cliId).toBe('codex');
    expect(sessions.isOpen(mismatched)).toBe(true);
  });

  describe('sessions of the CLI a profile replaced', () => {
    it('closes the sessions frozen on the previous CLI before it answers, and keeps the others', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      const previous = [sessions.open('codex'), sessions.open('codex')];
      const adopted = sessions.open('codex', { title: 'Adopt: external codex' });
      await listen();
      expect(await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).toEqual({ status: 200, body: { ok: true, changed: true } });
      for (const id of previous) {
        expect(findActiveBySessionId(id)).toBeUndefined();
        expect(sessionStore.getOwnedSession(id)?.status).toBe('closed');
      }
      // Same exemptions as a Feishu Agent save: an adopted external CLI is not the bot's.
      expect(sessions.isOpen(adopted)).toBe(true);
      // A session started after the switch runs the new CLI and stays.
      const current = sessions.open('claude-code');
      expect(await post({ env: profileOf(coreConfig({ cli: 'claude-code', model: 'opus' })) })).toEqual({ status: 200, body: { ok: true, changed: true } });
      expect(sessions.isOpen(current)).toBe(true);
    });

    it('keeps every session when the CLI stays and only the model, directory or profile changed', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      const kept = [sessions.open('codex'), sessions.open('codex')];
      await listen();
      for (const next of [
        coreConfig({ model: 'gpt-5.5' }),
        coreConfig({ model: 'gpt-5.5', workingDirectory: '/srv/core-profile/root-b' }),
        coreConfig({ model: 'gpt-5.5', workingDirectory: '/srv/core-profile/root-b', botConfig: { startupCommands: ['/compact'] } }),
      ]) {
        expect(await post({ env: profileOf(next) })).toEqual({ status: 200, body: { ok: true, changed: true } });
      }
      for (const id of kept) expect(sessions.isOpen(id)).toBe(true);
    });

    it('closes nothing when the profile did not change', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      // Frozen on another CLI already: only a profile the core takes now closes it.
      const mismatched = sessions.open('claude-code');
      await listen();
      expect(await post({ env: profileOf(coreConfig()) })).toEqual({ status: 200, body: { ok: true, changed: false } });
      expect(sessions.isOpen(mismatched)).toBe(true);
    });

    it('answers only after a close that waits for its worker to exit, so no session of the previous CLI outlives the answer', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      const worker = new FakeWorker();
      const running = sessions.open('codex', { worker });
      const idle = sessions.open('codex');
      await listen();
      let answered = false;
      const pushed = post({ env: profileOf(coreConfig({ cli: 'claude-code' })) }).then(result => {
        answered = true;
        return result;
      });
      // The first close asked its worker to stop and waits for it to exit.
      await vi.waitFor(() => expect(worker.sent).toContainEqual(expect.objectContaining({ type: 'close' })));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(answered).toBe(false);
      worker.exit();
      expect(await pushed).toEqual({ status: 200, body: { ok: true, changed: true } });
      expect(findActiveBySessionId(running)).toBeUndefined();
      expect(findActiveBySessionId(idle)).toBeUndefined();
      expect(sessionStore.getOwnedSession(idle)?.status).toBe('closed');
    });

    it('holds a turn that arrives during the sweep until it ends, so it cannot reach a session of the previous CLI', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      const slow = new FakeWorker();
      sessions.open('codex', { worker: slow });
      const laterWorker = new FakeWorker(true);
      const later = sessions.open('codex', { worker: laterWorker });
      await listen();
      const pushed = post({ env: profileOf(coreConfig({ cli: 'claude-code' })) });
      await vi.waitFor(() => expect(slow.sent).toContainEqual(expect.objectContaining({ type: 'close' })));
      // E.g. the gateway's push timed out and it sends the next turn of that conversation.
      let turnAnswered = false;
      const turn = postTrigger(later).then(result => {
        turnAnswered = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(turnAnswered).toBe(false);
      slow.exit();
      expect((await pushed).status).toBe(200);
      expect(await turn).toMatchObject({ status: 404, body: { errorCode: 'session_not_found' } });
      expect(laterWorker.sent.filter(message => (message as { type?: string }).type !== 'close')).toEqual([]);
    });

    it('answers success when a session cannot be closed now, and leaves that session as it was', async () => {
      boot(coreConfig());
      const sessions = liveSessions();
      const protectedSession = sessions.open('codex', { queuedActivationPending: true });
      const closable = sessions.open('codex');
      await listen();
      expect(await post({ env: profileOf(coreConfig({ cli: 'claude-code' })) })).toEqual({ status: 200, body: { ok: true, changed: true } });
      expect(sessions.isOpen(protectedSession)).toBe(true);
      expect(findActiveBySessionId(closable)).toBeUndefined();
    });
  });
});

/** A worker process as killWorker sees one: it exits when the test says so, or on close. */
class FakeWorker extends EventEmitter {
  readonly pid = 2_147_000_001;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  sent: unknown[] = [];
  constructor(private readonly exitOnClose = false) {
    super();
  }
  send(message: unknown): boolean {
    this.sent.push(message);
    if (this.exitOnClose && (message as { type?: string }).type === 'close') queueMicrotask(() => this.exit());
    return true;
  }
  kill(): boolean {
    return true;
  }
  exit(): void {
    this.exitCode = 0;
    this.connected = false;
    this.emit('exit', 0, null);
  }
}

/**
 * Live sessions of the fixture bot: a row in the real session store and an entry
 * in the registry the core serves from, as a core has them for its HTTP sessions.
 */
function liveSessions() {
  sessionStore.init(BOT);
  const registry = new Map<string, DaemonSession>();
  setActiveSessionsRegistry(registry);
  let n = 0;
  return {
    open(cliId: CliId, extra: { title?: string; worker?: FakeWorker; queuedActivationPending?: boolean } = {}): string {
      const chatId = `http_async_profile_${++n}`;
      const session = sessionStore.createSession(chatId, chatId, extra.title ?? `fixture ${n}`, 'p2p', 'chat');
      session.larkAppId = BOT;
      session.cliId = cliId;
      if (extra.queuedActivationPending) session.queuedActivationPending = true;
      sessionStore.updateSession(session);
      registry.set(chatId, {
        session,
        larkAppId: BOT,
        chatId,
        chatType: 'p2p',
        worker: extra.worker ?? null,
        workerPort: null,
        workerToken: null,
        spawnedAt: Date.now(),
        lastMessageAt: Date.now(),
        hasHistory: true,
      } as unknown as DaemonSession);
      return session.sessionId;
    },
    isOpen(sessionId: string): boolean {
      return findActiveBySessionId(sessionId) !== undefined && sessionStore.getOwnedSession(sessionId)?.status === 'active';
    },
  };
}
