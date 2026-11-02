import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { ScheduleAuthorityStore, scheduleAuthorityDbPath } from '../src/services/schedule-authority-store.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../src/utils/process-identity.js';
import { backgroundAuthorityKey, backgroundCredentialPolicyKey } from '../src/core/background-execution-policy.js';
import { sessionIdentityDataDir } from '../src/core/cli-identity.js';
import { larkToolBindingPath } from '../src/core/lark-tool-binding.js';
import { launchBackgroundExecution } from '../src/cli/background-execution.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as registry from '../src/bot-registry.js';
import * as access from '../src/im/lark/event-dispatcher.js';
import * as identityCache from '../src/im/lark/identity-cache.js';
import * as credentials from '../src/core/lark-tool-platform-credential.js';

const app = 'cli_backgroundguards', sessionId = 's-background-guards';
const turnId = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
const accessKey = 'b'.repeat(64);
let root: string, store: ScheduleAuthorityStore, ipc: IpcServerHandle;
let ds: any, session: any, bot: any;
let server: Server | undefined;
const previous = config.session.dataDir;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function registerSelf() {
  const task = store.getRecord(app, 'abcd1234')!.task;
  const job = { id: '12345678-1234-1234-1234-123456789abc', appId: app, sessionId,
    taskId: 'abcd1234', turnId, root: { pid: process.pid, procStart: readProcessStartIdentity(process.pid)! },
    bootId: readLinuxBootIdentity()!, uid: process.getuid!(), openId: 'ou_background', unionId: 'on_background',
    authEpoch: 0, authorityKey: backgroundAuthorityKey(task), credentialPolicyKey: backgroundCredentialPolicyKey(bot),
    expiresAt: Date.now() + 3600_000 };
  store.registerBackgroundExecution(job);
  return job;
}
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function lark(mode: 'user' | 'bot') {
  return request(`/api/sessions/${sessionId}/lark-tool-identity`, { mode }, { 'x-botmux-lark-session': accessKey });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'background-guards-')); config.session.dataDir = root;
  vi.stubEnv('SESSION_DATA_DIR', root); vi.stubEnv('BOTMUX_NO_CLAIM', '1');
  session = { sessionId, larkAppId: app, chatId: 'oc_background', status: 'active', sandbox: 'off', backendType: 'pty' };
  ds = undefined;
  bot = { larkAppId: app, backendType: 'pty', larkToolBinding: true };
  store = ScheduleAuthorityStore.open(root); store.initializeApp(app, []);
  store.createDirect({ id: 'abcd1234', larkAppId: app, chatId: session.chatId, name: 'job', enabled: true,
    ownerOpenId: 'ou_background', ownerUnionId: 'on_background', prompt: 'work', workingDir: root,
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' }, createdAt: new Date().toISOString() } as any);
  vi.spyOn(registry, 'getBot').mockReturnValue({ config: bot } as any);
  vi.spyOn(access, 'canOperate').mockReturnValue(true);
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
  vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
  vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id => id === sessionId ? session : undefined);
  vi.spyOn(scheduler, 'getScheduleAuthorityRecord').mockImplementation((id, a) => store.getRecord(a!, id));
  vi.spyOn(scheduler, 'registerBackgroundExecution').mockImplementation(job => store.registerBackgroundExecution(job));
  vi.spyOn(scheduler, 'backgroundExecutions').mockImplementation((a, s) => store.backgroundExecutions(a, s));
  vi.spyOn(scheduler, 'revokeBackgroundExecution').mockImplementation(id => store.revokeBackgroundExecution(id));
  vi.spyOn(identityCache, 'getIdentity').mockReturnValue({ type: 'user', openId: 'ou_background', source: 'sender' } as any);
  const identityDir = sessionIdentityDataDir(root, sessionId); mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, 'identity-layout'), 'proven-v1');
  writeFileSync(larkToolBindingPath(root, sessionId), JSON.stringify({ version: 2, sessionId, appId: app,
    brand: 'feishu', defaultAs: 'bot', accessKey, realBinary: '/fake/lark-cli', configDir: root, dataDir: root }), { mode: 0o600 });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  vi.useRealTimers();
  await ipc?.close();
  if (server) { await new Promise<void>(r => server!.close(() => r())); server = undefined; }
  store?.close();
  config.session.dataDir = previous; setIpcAuthSecret(null); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
describe.skipIf(process.platform !== 'linux')('background execution HTTP guards', () => {
  it.each(['/api/current-execution-background', '/api/current-execution-background/revoke'])(
    'rejects unrecognized body keys on %s before authorization', async path => {
      const response = await request(path, { sessionId, ...(path.endsWith('/revoke') ? { jobId: 'known-job' } : {}), openId: 'ou_injected' });
      expect(response.status).toBe(400);
      expect(store.backgroundExecutions(app, sessionId)).toEqual([]);
    });
  it.each(['user', 'bot'] as const)('serves detached %s credentials when authority remains valid', async mode => {
    registerSelf();
    vi.spyOn(credentials, 'resolveBoundLarkUserCredential').mockResolvedValue({ ok: true, appId: app, credential: 'test-user-token' });
    vi.spyOn(registry, 'getBotClient').mockReturnValue({ tokenManager: { getTenantAccessToken: async () => 'test-bot-token' } } as any);
    const response = await lark(mode);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mode, credential: `test-${mode}-token` });
  });
  it.each((['user', 'bot'] as const).flatMap(mode =>
    (['revoke', 'pause', 'expiry'] as const).map(change => [mode, change] as const)))(
    'rechecks detached %s authority after %s during provider await', async (mode, change) => {
      const job = registerSelf();
      const reached = deferred<void>(), release = deferred<void>();
      const provider = async () => { reached.resolve(); await release.promise; return 'late-token'; };
      vi.spyOn(credentials, 'resolveBoundLarkUserCredential').mockImplementation(async () => ({ ok: true, appId: app, credential: await provider() }));
      vi.spyOn(registry, 'getBotClient').mockReturnValue({ tokenManager: { getTenantAccessToken: provider } } as any);
      const pending = lark(mode); await reached.promise;
      if (change === 'revoke') store.revokeBackgroundExecution(job.id);
      if (change === 'pause') store.updateTask(app, 'abcd1234', t => ({ ...t, enabled: false }));
      if (change === 'expiry') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(job.expiresAt + 1); }
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(mode === 'user' ? 409 : 403);
      expect(await response.json()).not.toHaveProperty('credential');
    });
  it('reports failure and revokes registration when the work executable cannot spawn', async () => {
    ds = { session, larkAppId: app, chatId: session.chatId, workerGeneration: 1,
      worker: { pid: process.pid, connected: true, killed: false }, reportedIdentityModel: { model: 'proven' },
      localProcessAttestation: { workerGeneration: 1, cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
      managedTurnOrigin: { turnId, callerOpenId: 'ou_background', capability: 'c'.repeat(64), dispatchAttempt: 1,
        preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] } };
    const { command, prefixArgs } = tsRunnerPrefix();
    const registration = vi.mocked(scheduler.registerBackgroundExecution);
    await expect(launchBackgroundExecution({ ipcPort: ipc.port, sessionId, larkAppId: app },
      { kind: 'launch', ttlSeconds: 60, command: [join(root, 'executable-does-not-exist')] },
      { command, args: [...prefixArgs, resolve('src/background-execution-runner.ts')] })).rejects.toThrow('background_start_failed');
    expect(registration).toHaveBeenCalledTimes(1);
    const job = registration.mock.calls[0][0];
    // Read the durable row before backgroundExecutions can perform dead-root
    // sweeping; that read must not accidentally repair a missing revoke.
    const db = openDatabaseSyncOrThrow(scheduleAuthorityDbPath(root));
    try {
      expect(db.prepare('SELECT revoked FROM schedule_background_executions WHERE id = ?').get(job.id)).toMatchObject({ revoked: 1 });
    } finally { db.close(); }
    expect(store.backgroundExecutions(app, sessionId)).toEqual([]);
  });
  it('refuses a runner registration naming a different PID before spawning work or sending started', async () => {
    const marker = join(root, 'should-not-run');
    server = createServer((req, res) => {
      req.resume(); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, jobId: '12345678-1234-1234-1234-123456789abc', sessionId,
        larkAppId: app, pid: process.pid, expiresAt: Date.now() + 60_000 }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const child = spawnTsScript(resolve('src/background-execution-runner.ts'), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
        BOTMUX_BACKGROUND_EXECUTION: JSON.stringify({ context: { ipcPort: port, sessionId, larkAppId: app },
          launch: { kind: 'launch', ttlSeconds: 60, command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] } }) },
    });
    const messages: unknown[] = []; let stderr = '';
    child.on('message', data => messages.push(data)); child.stderr!.on('data', data => { stderr += data; });
    const [code] = await once(child, 'exit');
    expect(code).not.toBe(0); expect(stderr).toContain('background_registration_failed');
    expect(messages).toEqual([]);
    expect(() => readFileSync(marker)).toThrow();
  });
});
