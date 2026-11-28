import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, stat, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createWecomQrAuthorization, type WecomQrAuthorization } from '../src/im/wecom/protocol/qr-auth.js';
import { WecomDashboardSessions } from '../src/dashboard/wecom/sessions.js';
import { commitWecomConfiguration, parseWecomConfig, readWecomCredentialFile } from '../src/im/wecom/config/config.js';
import { readWecomConfigPaths } from '../src/im/wecom/config/discovery.js';
import { handleWecomOnboardingApi, WecomOnboardingManager, type WecomOnboardingOptions } from '../src/dashboard/wecom/onboarding.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';
import { pairDraftWecomIdentity } from '../src/dashboard/wecom/draft-identity.js';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { emptyNativeCoreState, nativeCapability, nativeCanApprove, nativeApproveRequest, nativeRequestGrant } from '../src/im/wecom/gateway/native-core.js';

const actor = { userId: 'host-admin', authSessionId: 'bound-auth-session' };
const roots: string[] = [];
const children: ChildProcess[] = [];
const defer = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let count = 0; count < 80; count++) await Promise.resolve(); };
const eventually = async (check: () => void) => { await vi.waitFor(check, { timeout: 2000, interval: 5 }); };
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so an
 * assertion created before the event would, under fake timers, wait forever.
 */
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, () => undefined);
/**
 * One real I/O round trip. Neither runner's fake timers intercept it, and it cannot
 * resolve before the microtask queue has drained, so pending file work and promise
 * chains in the code under test get to run without moving the fake clock.
 */
const ioTurn = () => new Promise<void>(done => stat(tmpdir(), () => done()));
/**
 * `eventually` for fake-timer tests. Bun's `vi.waitFor` only advances the fake clock
 * between polls and never yields to the event loop, so file I/O behind the polled
 * state would never complete there; poll across real I/O turns instead.
 */
const eventuallyOnIo = async (check: () => void, rounds = 2000) => {
  for (let round = 0; ; round++) {
    try { check(); return; } catch (error) { if (round >= rounds) throw error; }
    await ioTurn();
  }
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const qrResponse = () => json({ data: { scode: 'private-scode', auth_url: 'https://work.weixin.qq.com/ai/qc/c?code=public' } });
const successResponse = () => json({ data: { status: 'success', bot_info: { botid: 'draft-bot', secret: 'private-platform-secret' } } });

/** The wizard's connections manager: `begin('start'|'stop')` runs `start(id)` / `stop(id)` after `beforeStart`. */
function connections(start: (id: string) => unknown, stop: (id: string) => unknown, list: () => Promise<any[]> = async () => []) {
  return {
    connection: async (id: string) => (await list()).find(row => row.id === id),
    idle: async () => {},
    begin: (action: string, id: string, options: { beforeStart?: () => void } = {}) => {
      options.beforeStart?.();
      const settled = Promise.resolve()
        .then(() => (action === 'stop' ? stop(id) : start(id)))
        .then(() => ({ ok: true, message: '' }), (error: unknown) => ({ ok: false, reason: 'cli_failed', message: String(error) }));
      return { view: {} as any, settled };
    },
  } as unknown as NonNullable<WecomOnboardingOptions['manager']>;
}

function fixture(extra: Partial<WecomOnboardingOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-onboarding-authority-')); roots.push(root);
  const authorize = vi.fn(async (): Promise<WecomQrAuthorization> => ({ authUrl: 'https://work.weixin.qq.com/qr-public', expiresAt: Date.now() + 300000, cancel: vi.fn(), waitForCredentials: async () => ({ botId: 'draft-bot', secret: 'private-platform-secret' }) }));
  const pair = vi.fn(async (options: Parameters<NonNullable<WecomOnboardingOptions['pair']>>[0]) => {
    options.beforeConnect?.(); options.onChallenge('BOTMUX-ID-0123456789ABCDEF0123456789ABCDEF');
    return { userid: 'proved-callback-user', verifiedAt: new Date().toISOString() };
  });
  const start = vi.fn(async (_id: string) => ({} as any));
  const stop = vi.fn(async (_id: string) => ({} as any));
  const options: WecomOnboardingOptions = {
    root, preflight: async () => ({ appName: 'Private test bot', cliId: 'codex', workingDir: root, backend: 'pty', port: 19345, dirMode: 'fixed', mode: 'qr' }),
    authorize, pair, manager: connections(start, stop), waitForReady: async () => {}, ...extra,
  };
  return { root, options, authorize, pair, start, stop, service: new WecomOnboardingManager(options) };
}

afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await closed; clearTimeout(timer);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await releaseWecomCorePorts();
});

describe('WeCom onboarding time and authority boundaries', () => {
  it('rejects a success response delivered after the QR deadline without an extra poll', async () => {
    vi.useFakeTimers();
    const response = defer<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(qrResponse()).mockImplementationOnce(() => response.promise);
    const auth = await createWecomQrAuthorization({ fetch });
    const pending = auth.waitForCredentials();
    const pendingSettled = settled(pending);
    vi.setSystemTime(Date.now() + 300001);
    response.resolve(successResponse()); await pendingSettled; await expect(pending).rejects.toThrow('wecom_qr_expired'); await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never saves late QR credentials after cancellation, and releases the obsolete authorization', async () => {
    const generated = defer<WecomQrAuthorization>();
    const cancel = vi.fn(); const waitForCredentials = vi.fn(async () => ({ botId: 'draft-bot', secret: 'private-platform-secret' }));
    const f = fixture({ authorize: async () => generated.promise });
    const job = await f.service.start({}, actor);
    await f.service.action(job.id, 'cancel', actor);
    generated.resolve({ authUrl: 'https://work.weixin.qq.com/qr-public', expiresAt: Date.now() + 300000, cancel, waitForCredentials });
    await flush();
    expect(f.service.get(job.id, actor)).toMatchObject({ status: 'cancelled', saved: false, externalBotCreated: false });
    expect(readdirSync(join(f.root, 'onboarding')).filter(file => file.endsWith('.secret'))).toEqual([]);
    expect(waitForCredentials).not.toHaveBeenCalled(); expect(f.pair).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not accept a late verified owner after the host authentication session is revoked', async () => {
    const proof = defer<{ userid: string; verifiedAt: string }>(); let live = true;
    const f = fixture({ isActorLive: () => live, pair: async options => { options.onChallenge('CURRENT-CHALLENGE'); return proof.promise; } });
    const job = await f.service.start({}, actor);
    await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('needs_pairing'));
    live = false; proof.resolve({ userid: 'revoked-session-user', verifiedAt: new Date().toISOString() });
    await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('failed'));
    expect(f.service.get(job.id, actor)?.saved).toBe(false); expect(f.start).not.toHaveBeenCalled();
    expect(readWecomConfigPaths(f.root)).toEqual([join(f.root, 'config.json')]);
  });

  it('binds GET, cancellation and retry to both actor and auth session and rejects writes before CSRF validation', async () => {
    const proof = defer<{ userid: string; verifiedAt: string }>();
    const f = fixture({ pair: async options => { options.onChallenge('PRIVATE-CURRENT-CHALLENGE'); return proof.promise; } });
    const job = await f.service.start({}, actor); await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('needs_pairing'));
    const request = async (method: string, suffix: string, options: { actor?: typeof actor; hostAdmin?: boolean; csrf?: boolean } = {}) => {
      const output: { status?: number; body?: any } = {};
      const res = { writeHead(status: number) { output.status = status; }, end(body: string) { output.body = JSON.parse(body); } } as unknown as ServerResponse;
      const csrfValid = vi.fn(() => options.csrf !== false);
      await handleWecomOnboardingApi({ method } as IncomingMessage, res, new URL(`http://dashboard/api/bot-onboarding/${job.id}${suffix}`), { manager: f.service, actor: options.actor ?? actor, hostAdmin: options.hostAdmin !== false, csrfValid });
      return { ...output, csrfValid };
    };
    for (const stranger of [{ ...actor, userId: 'other-admin' }, { ...actor, authSessionId: 'other-session' }]) {
      expect((await request('GET', '', { actor: stranger })).status).toBe(404);
      for (const action of ['cancel', 'retry', 'refresh']) expect((await request('POST', `/${action}`, { actor: stranger })).status).toBe(404);
      expect(f.service.list(stranger)).toEqual([]);
    }
    expect((await request('GET', '', { hostAdmin: false })).status).toBe(403);
    const denied = await request('POST', '/cancel', { csrf: false });
    expect(denied.csrfValid).toHaveBeenCalledOnce(); expect(f.service.get(job.id, actor)?.status).toBe('needs_pairing');
    const allowed = await request('GET', ''); expect(allowed.status).toBe(200);
    for (const privateValue of ['private-platform-secret', 'proved-callback-user', 'bound-auth-session', 'draft-bot']) expect(JSON.stringify(allowed.body)).not.toContain(privateValue);
    expect((await request('POST', '/owner')).status).toBeUndefined();
    await f.service.action(job.id, 'cancel', actor); proof.resolve({ userid: 'late', verifiedAt: new Date().toISOString() }); await flush();
  });

  it('recovers the exact committed config after a process crash before the saved receipt update', async () => {
    let interruptedReceipt = '', interruptedDraft = '';
    let f!: ReturnType<typeof fixture>;
    const commit: typeof commitWecomConfiguration = async options => {
      await commitWecomConfiguration(options);
      interruptedReceipt = readFileSync(join(f.root, 'onboarding', readdirSync(join(f.root, 'onboarding')).find(file => file.endsWith('.json'))!), 'utf8');
      interruptedDraft = readFileSync(JSON.parse(interruptedReceipt).draftSecret, 'utf8');
    };
    f = fixture({ commit }); const job = await f.service.start({}, actor);
    await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('completed'));
    const receipt = JSON.parse(interruptedReceipt); expect(receipt.snapshot.saved).toBe(false); expect(receipt.plannedConfig).toBeTruthy();
    writeFileSync(join(f.root, 'onboarding', `${job.id}.json`), interruptedReceipt, { mode: 0o600 });
    writeFileSync(receipt.draftSecret, interruptedDraft, { mode: 0o600 });
    rmSync(join(f.root, 'config-registry.json'), { force: true });
    const resumed = new WecomOnboardingManager(f.options);
    expect(resumed.get(job.id, actor)).toMatchObject({ status: 'failed', saved: false, retryable: true });
    await resumed.action(job.id, 'retry', actor); await eventually(() => expect(resumed.get(job.id, actor)?.status).toBe('completed'));
    expect(f.authorize).toHaveBeenCalledOnce(); expect(f.pair).toHaveBeenCalledOnce();
    const configs = readWecomConfigPaths(f.root).filter(file => file !== join(f.root, 'config.json'));
    expect(configs).toHaveLength(1);
    const config = parseWecomConfig(JSON.parse(readFileSync(configs[0], 'utf8')));
    expect(config.allowedUsers).toEqual(['proved-callback-user']); expect(readWecomCredentialFile(config.secretFile!)).toBe('private-platform-secret');
    expect(readdirSync(join(configs[0], '..', 'credentials'))).toHaveLength(1);
  });

  it('serializes concurrent retry while a long startup is pending, and a cancel stops the connection this job started', async () => {
    const ready = defer<void>(); const started = defer<void>();
    const start = vi.fn(async (_id: string) => { started.resolve(); return {} as any; });
    const stop = vi.fn(async (_id: string) => ({} as any));
    const f = fixture({ manager: connections(start, stop), waitForReady: async () => ready.promise });
    const job = await f.service.start({}, actor); await started.promise;
    expect(f.service.get(job.id, actor)?.status).toBe('starting_bot');
    await expect(f.service.action(job.id, 'retry', actor)).rejects.toThrow('wecom_onboarding_busy');
    await expect(f.service.action(job.id, 'refresh', actor)).rejects.toThrow('wecom_onboarding_busy');
    await f.service.action(job.id, 'cancel', actor); ready.resolve(); await flush();
    expect(f.service.get(job.id, actor)).toMatchObject({ status: 'cancelled', saved: true });
    expect(f.service.get(job.id, actor)?.liveStarted).not.toBe(true);
    await eventually(() => expect(stop).toHaveBeenCalledExactlyOnceWith(f.service.get(job.id, actor)!.connectionId));
    expect(start).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      const retried = await Promise.allSettled([f.service.action(job.id, 'retry', actor), f.service.action(job.id, 'retry', actor)]);
      expect(retried.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    }, { timeout: 2000, interval: 5 });
    await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('completed'));
    expect(start).toHaveBeenCalledTimes(2); expect(f.authorize).toHaveBeenCalledOnce(); expect(f.pair).toHaveBeenCalledOnce();
  });

  it('does not mark launch completed with only a running process: authenticated connection and core health are both required', async () => {
    vi.useFakeTimers();
    let connection = 'unknown', gateway = 'running', coreReady = false;
    const f = fixture({ waitForReady: undefined, manager: connections(async () => ({}), async () => ({}), async () => [{ id: f.service.list(actor)[0]?.connectionId, gateway, connection, ownership: 'fleet' }]) });
    const probe = vi.spyOn(WecomDashboardSessions.prototype, 'coreReady').mockImplementation(async () => coreReady);
    const job = await f.service.start({}, actor); await eventuallyOnIo(() => expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'));
    // Each step runs exactly one 300 ms readiness poll; the I/O turn lets that poll finish before the check.
    const poll = async () => { await vi.advanceTimersByTimeAsync(350); await ioTurn(); };
    coreReady = true; await poll(); expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'); expect(probe).not.toHaveBeenCalled();
    connection = 'connected'; coreReady = false; await poll(); expect(f.service.get(job.id, actor)?.status).toBe('starting_bot');
    gateway = 'starting'; coreReady = true; await poll(); expect(f.service.get(job.id, actor)?.status).toBe('starting_bot');
    gateway = 'running'; await poll(); expect(f.service.get(job.id, actor)).toMatchObject({ status: 'completed', liveStarted: true });
  });

  it('never turns invalid or interrupted manual binding into a platform QR creation', async () => {
    const f = fixture({ preflight: async () => ({ appName: 'manual', cliId: 'codex', workingDir: '/tmp', backend: 'pty', port: 19345, dirMode: 'fixed', mode: 'manual' }), pair: async () => { throw new Error('temporary'); } });
    await expect(f.service.start({ botId: 'manual-bot', secret: 'invalid\nsecret' }, actor)).rejects.toThrow('wecom_invalid_credentials');
    expect(f.service.list(actor)).toEqual([]); expect(f.authorize).not.toHaveBeenCalled();
    const job = await f.service.start({ botId: 'manual-bot', secret: 'private-manual-secret' }, actor);
    await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('failed'));
    expect(f.service.get(job.id, actor)).toMatchObject({ externalBotCreated: false, retryable: true });
    await expect(f.service.action(job.id, 'refresh', actor)).rejects.toThrow('wecom_manual_credentials_required');
    const path = join(f.root, 'onboarding', `${job.id}.json`), receipt = JSON.parse(readFileSync(path, 'utf8'));
    rmSync(receipt.draftSecret); delete receipt.botId; delete receipt.draftSecret; delete receipt.file;
    receipt.snapshot.status = 'starting'; receipt.snapshot.retryable = false;
    writeFileSync(path, JSON.stringify(receipt));
    const restored = new WecomOnboardingManager(f.options);
    expect(restored.get(job.id, actor)).toMatchObject({ status: 'failed', retryable: false });
    await expect(restored.action(job.id, 'refresh', actor)).rejects.toThrow('wecom_manual_credentials_required');
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  });

  it('rejects a draft matching an existing connection without opening another owner socket or changing its config', async () => {
    const f = fixture();
    const file = join(f.root, 'config.json'), existing = JSON.stringify({ botId: 'draft-bot', secretFile: '/unused-existing-credential', coreUrl: 'http://127.0.0.1:19123', allowedUsers: ['existing-owner'] });
    writeFileSync(file, existing);
    const job = await f.service.start({}, actor); await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('failed'));
    expect(f.service.get(job.id, actor)).toMatchObject({ saved: false, externalBotCreated: true });
    expect(f.pair).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(readFileSync(file, 'utf8')).toBe(existing);
  });

  it('uses the authenticated native callback owner even when its text resembles a Lark ID; allowed users approve, a granted guest does not', async () => {
    class Socket extends EventEmitter {
      send(data: string) { const frame = JSON.parse(data); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode: 0 })))); }
      terminate() { this.emit('close'); }
    }
    const socket = new Socket(), nativeOwner = 'ou_authenticated_native_callback_owner';
    const f = fixture({ pair: options => pairDraftWecomIdentity({ ...options,
      createTransport: settings => new WecomTransport({ ...settings, socketFactory: () => { queueMicrotask(() => socket.emit('open')); return socket as any; } }),
      onChallenge: code => { options.onChallenge(code); socket.emit('message', Buffer.from(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'callback' }, body: { msgid: 'owner-proof', from: { userid: nativeOwner }, chattype: 'single', chatid: nativeOwner, msgtype: 'text', text: { content: code } } }))); },
    }) });
    const job = await f.service.start({}, actor); await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('completed'));
    const file = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!;
    const config = parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
    expect(config.allowedUsers).toEqual([nativeOwner]);
    const state = emptyNativeCoreState(), policy = { ...config.native, allowedUsers: [...config.allowedUsers, 'ordinary-allowed-user'] }, now = Date.now();
    const message = { userId: nativeOwner, chatType: 'single' as const, conversationId: nativeOwner };
    expect(nativeCapability(state, policy, message, now)).toBe('operate');
    expect(nativeCanApprove(policy, nativeOwner)).toBe(true);
    expect(nativeCanApprove(policy, 'ordinary-allowed-user')).toBe(true);
    const request = nativeRequestGrant(state, policy, { ...message, userId: 'new-guest', messageId: 'grant-request', text: 'request', attachments: [], replyContext: { requestId: 'request' } }, now);
    expect(nativeApproveRequest(state, policy, request.id, nativeOwner, now)).toBe(true);
    expect(nativeCapability(state, policy, { ...message, userId: 'new-guest' }, now)).toBe('talk');
    // A guest granted access is not an approver.
    expect(nativeCanApprove(policy, 'new-guest')).toBe(false);
    const second = nativeRequestGrant(state, policy, { ...message, userId: 'other-guest', messageId: 'grant-request-2', text: 'request', attachments: [], replyContext: { requestId: 'request-2' } }, now);
    expect(nativeApproveRequest(state, policy, second.id, 'new-guest', now)).toBe(false);
  });

  it('expires a saved draft during a long readiness wait, clears only draft credentials and preserves its committed configuration', async () => {
    let now = 1000; const ready = defer<void>();
    const f = fixture({ now: () => now, waitForReady: async () => ready.promise });
    const job = await f.service.start({}, actor); await eventually(() => expect(f.service.get(job.id, actor)?.status).toBe('starting_bot'));
    const file = readWecomConfigPaths(f.root).find(path => path !== join(f.root, 'config.json'))!;
    const configBefore = readFileSync(file, 'utf8');
    now = job.resumeUntil + 1;
    expect(f.service.get(job.id, actor)).toMatchObject({ status: 'failed', error: 'wecom_onboarding_expired', retryable: false, saved: true });
    ready.resolve();
    await eventually(() => expect(readdirSync(join(f.root, 'onboarding')).filter(name => name.endsWith('.secret'))).toEqual([]));
    expect(readFileSync(file, 'utf8')).toBe(configBefore);
    expect(readWecomCredentialFile(parseWecomConfig(JSON.parse(configBefore)).secretFile!)).toBe('private-platform-secret');
    expect(f.service.get(job.id, actor)?.liveStarted).not.toBe(true);
    await expect(f.service.action(job.id, 'retry', actor)).rejects.toThrow('wecom_onboarding_expired');
    expect(f.authorize).toHaveBeenCalledOnce();
  });

  it('uses the actual Dashboard HTTP auth, CSRF, recovery-list and legacy owner routes without crossing provider or login boundaries', async () => {
    const f = fixture({ pair: async () => { throw new Error('synthetic network failure'); } });
    const home = join(f.root, 'home'), configDir = join(home, '.botmux'), data = join(configDir, 'data'), wecom = join(configDir, 'wecom');
    mkdirSync(wecom, { recursive: true }); mkdirSync(data, { recursive: true });
    const bots = join(configDir, 'bots.json'), secret = 'isolated-dashboard-host-secret';
    writeFileSync(bots, '[]'); writeFileSync(join(configDir, '.env'), ''); writeFileSync(join(configDir, '.dashboard-secret'), secret, { mode: 0o600 });
    const tokenFile = join(configDir, '.dashboard-token'), token = loadOrCreatePersistedToken(tokenFile);
    const hostActor = { userId: 'legacy-owner', authSessionId: createHmac('sha256', secret).update('botmux-legacy-dashboard-session-id-v1\0').update(token).digest('base64url') };
    const seed = new WecomOnboardingManager({ ...f.options, root: wecom });
    const job = await seed.start({}, hostActor); await eventually(() => expect(seed.get(job.id, hostActor)?.status).toBe('failed'));
    const port = await reserveWecomCorePort();
    const htmlFile = join(f.root, 'index.html'); writeFileSync(htmlFile, '<!doctype html><html><head></head><body>isolated route fixture</body></html>');
    const child = spawnTsScript(resolve('test/helpers/dashboard-with-fixture-index.ts'), [], { cwd: resolve('.'), env: { ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: bots, BOTMUX_ONBOARDING_TEST_INDEX: htmlFile, BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PORT: String(port), BOTMUX_DASHBOARD_PUBLIC_READONLY: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let logs = ''; child.stdout!.on('data', chunk => logs += chunk); child.stderr!.on('data', chunk => logs += chunk);
    let base = ''; const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated Dashboard exited: ${logs}`);
      try { const listeningPort = Number(readFileSync(join(configDir, '.dashboard-port'), 'utf8')); if (listeningPort) { base = `http://127.0.0.1:${listeningPort}`; if ((await fetch(base + '/api/settings')).ok) break; } } catch { /* startup is asynchronous */ }
      await new Promise(done => setTimeout(done, 30));
    }
    expect(base, logs).not.toBe('');
    const auth = { cookie: `botmux_dashboard_token=${token}` };
    for (const path of ['/api/bot-onboarding/wecom-jobs', `/api/bot-onboarding/${job.id}`]) expect([401, 403]).toContain((await fetch(base + path)).status);
    const ownList = await fetch(base + '/api/bot-onboarding/wecom-jobs', { headers: auth }); expect(ownList.status).toBe(200);
    expect((await ownList.json()).jobs).toEqual([expect.objectContaining({ id: job.id, platform: 'wecom', status: 'failed' })]);
    expect((await fetch(base + `/api/bot-onboarding/${job.id}`, { headers: auth })).status).toBe(200);
    const html = await (await fetch(base + '/', { headers: auth })).text();
    const csrf = /<meta\s+name="botmux-csrf"\s+content="([^"]+)"/.exec(html)?.[1]; expect(csrf, html.slice(0, 250)).toBeTruthy();
    const writeHeaders = { ...auth, origin: base, 'x-botmux-csrf': csrf!, 'content-type': 'application/json' };
    const bindingFile = join(configDir, 'platform.json');
    writeFileSync(bindingFile, JSON.stringify({ platformUrl: 'http://127.0.0.1:1', machineId: 'isolated-machine', machineToken: 'isolated-token' }), { mode: 0o600 });
    const viewer = { ...auth, 'x-botmux-role': 'guest', 'x-botmux-actor': 'on_isolated_viewer' };
    for (const path of ['/api/bot-onboarding/wecom-jobs', `/api/bot-onboarding/${job.id}`]) expect([401, 403]).toContain((await fetch(base + path, { headers: viewer })).status);
    const platformManager = { ...auth, 'x-botmux-role': 'owner', 'x-botmux-actor': 'on_isolated_manager', 'x-botmux-scopes': 'dashboard:manage' };
    const managerHtml = await (await fetch(base + '/', { headers: platformManager })).text();
    const managerCsrf = /<meta\s+name="botmux-csrf"\s+content="([^"]+)"/.exec(managerHtml)?.[1]; expect(managerCsrf).toBeTruthy();
    const managerHeaders = { ...platformManager, origin: base, 'x-botmux-csrf': managerCsrf!, 'content-type': 'application/json' };
    const existingLark = await fetch(base + '/api/bot-onboarding/start', { method: 'POST', headers: managerHeaders, body: JSON.stringify({ platform: 'lark', cliId: 'not-a-real-cli-for-local-preflight' }) });
    expect(existingLark.status).toBe(400);
    expect(await existingLark.json()).toMatchObject({ error: 'invalid_cli' });
    const restrictedNative = await fetch(base + '/api/bot-onboarding/start', { method: 'POST', headers: managerHeaders, body: JSON.stringify({ platform: 'wecom', cliId: 'not-a-real-cli-for-local-preflight' }) });
    expect(restrictedNative.status).toBe(403);
    rmSync(bindingFile);
    expect((await fetch(base + `/api/bot-onboarding/${job.id}/cancel`, { method: 'POST', headers: { ...auth, origin: base } })).status).toBe(403);
    expect((await fetch(base + `/api/bot-onboarding/${job.id}/cancel`, { method: 'POST', headers: { ...writeHeaders, origin: 'https://foreign.invalid' } })).status).toBe(403);
    const receiptFile = join(wecom, 'onboarding', `${job.id}.json`), before = readFileSync(receiptFile, 'utf8');
    const injected = await fetch(base + `/api/bot-onboarding/${job.id}/owner`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ allowedUsers: ['attacker-userid'] }) });
    expect(injected.status).toBe(404); expect(readFileSync(receiptFile, 'utf8')).toBe(before);
    for (const platform of ['wecom', 'lark']) {
      const preflight = await fetch(base + '/api/bot-onboarding/start', { method: 'POST', headers: writeHeaders, body: JSON.stringify({ platform, cliId: 'not-a-real-cli-for-local-preflight' }) });
      expect(preflight.status).toBe(400); expect(await preflight.json()).toMatchObject({ ok: false });
    }
    const ownCancel = await fetch(base + `/api/bot-onboarding/${job.id}/cancel`, { method: 'POST', headers: writeHeaders });
    expect(ownCancel.status).toBe(200); expect(await ownCancel.json()).toMatchObject({ job: { id: job.id, status: 'cancelled' } });
    const cancelledReceipt = readFileSync(receiptFile, 'utf8');
    const rotated = 'B'.repeat(43); writeFileSync(tokenFile, rotated, { mode: 0o600 });
    const otherAuth = { cookie: `botmux_dashboard_token=${rotated}` };
    expect((await (await fetch(base + '/api/bot-onboarding/wecom-jobs', { headers: otherAuth })).json()).jobs).toEqual([]);
    expect((await fetch(base + `/api/bot-onboarding/${job.id}`, { headers: otherAuth })).status).toBe(404);
    const rotatedHtml = await (await fetch(base + '/', { headers: otherAuth })).text();
    const rotatedCsrf = /<meta\s+name="botmux-csrf"\s+content="([^"]+)"/.exec(rotatedHtml)?.[1]; expect(rotatedCsrf).toBeTruthy();
    for (const action of ['cancel', 'refresh', 'retry']) expect((await fetch(base + `/api/bot-onboarding/${job.id}/${action}`, { method: 'POST', headers: { ...otherAuth, origin: base, 'x-botmux-csrf': rotatedCsrf! } })).status).toBe(404);
    expect(createHash('sha256').update(readFileSync(receiptFile)).digest('hex')).toBe(createHash('sha256').update(cancelledReceipt).digest('hex'));
  }, 30000);
});
