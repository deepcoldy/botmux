import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as registry from '../src/bot-registry.js';
import * as sessions from '../src/services/session-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as access from '../src/im/lark/event-dispatcher.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import * as platformCredentials from '../src/core/platform-credential-source.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { registerScheduledBackgroundExecution } from '../src/core/detached-scheduled-identity.js';
import { sessionIdentityDataDir } from '../src/core/cli-identity.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { config } from '../src/config.js';
import { prepareLarkToolEnv, type LarkToolBinding } from '../src/core/lark-tool-binding.js';

const app = 'cli_background_probe';
const sessionId = 's-bg-probe';
const turn = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
const headlessId = 'hl_11111111-1111-4111-8111-111111111111';
let root: string;
let previousDataDir: string;
let ipc: IpcServerHandle | undefined;
let binding: LarkToolBinding;
let store: ScheduleAuthorityStore;
let rootProcess: ChildProcess;
let session: any;
let ds: any;
let bot: any;

function peer() {
  return { pid: rootProcess.pid!, procStart: readProcessStartIdentity(rootProcess.pid!)! };
}

async function requestFromRegisteredRoot() {
  const result = once(rootProcess, 'message');
  rootProcess.send({ url: `http://127.0.0.1:${ipc!.port}/api/sessions/${sessionId}/lark-tool-identity`, accessKey: binding.accessKey });
  const [message] = await result as [any];
  if (message.error) throw new Error(message.error);
  return message.result as { status: number; body: any };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'detached-credential-target-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = root;
  binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: root, sessionId, appId: app });
  store = ScheduleAuthorityStore.open(root);
  store.initializeApp(app, []);
  store.createDirect({ id: 'abcd1234', larkAppId: app, chatId: 'oc_bg', enabled: true,
    ownerOpenId: 'ou_bg', ownerUnionId: 'on_bg', name: 'job', prompt: 'work', workingDir: '/repo',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' }, createdAt: new Date().toISOString() } as any);
  session = { sessionId, larkAppId: app, chatId: 'oc_bg', status: 'active', creationSource: 'message', sandbox: 'off' };
  ds = { session, larkAppId: app, chatId: 'oc_bg', workerGeneration: 1,
    worker: { pid: process.pid, killed: false, connected: true }, reportedIdentityModel: { model: 'proven' },
    localProcessAttestation: { workerGeneration: 1, cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
    managedTurnOrigin: { turnId: turn, callerOpenId: 'ou_bg', dispatchAttempt: 1,
      capability: 'a'.repeat(64), preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] } };
  bot = { larkAppId: app, larkAppSecret: 'probe-secret', ownerOpenId: 'ou_bg', apiOnly: false };
  vi.spyOn(registry, 'getBot').mockImplementation(() => ({ config: bot }) as any);
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
  vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
  vi.spyOn(sessions, 'getOwnedSession').mockImplementation(id => id === sessionId ? session : undefined);
  vi.spyOn(scheduler, 'getScheduleAuthorityRecord').mockImplementation((id, appId) => store.getRecord(appId, id));
  vi.spyOn(scheduler, 'registerBackgroundExecution').mockImplementation(job => store.registerBackgroundExecution(job));
  vi.spyOn(scheduler, 'backgroundExecutions').mockImplementation((appId, sid) => store.backgroundExecutions(appId, sid));
  vi.spyOn(scheduler, 'revokeBackgroundExecution').mockImplementation(id => store.revokeBackgroundExecution(id));
  vi.spyOn(access, 'canOperate').mockReturnValue(true);
  vi.spyOn(platformCredentials, 'noteSenderUnionId').mockImplementation(() => {});
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue({ openId: 'ou_bg', type: 'user' } as any);
  rootProcess = spawnTsEval(`process.once('message', async input => {
    try {
      const response = await fetch(input.url, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-botmux-lark-session': input.accessKey,
      }, body: JSON.stringify({ mode: 'user' }) });
      process.send({ result: { status: response.status, body: await response.json() } });
    } catch (error) { process.send({ error: String(error) }); }
  });
  setInterval(() => {}, 1000);`, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await once(rootProcess, 'spawn');
  const job = registerScheduledBackgroundExecution({ sessionDataDir: root, sessionId, peer: peer() });
  if (!job) throw new Error('failed to register background fixture');
  ds = undefined;
  const identityDir = sessionIdentityDataDir(root, sessionId);
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, 'identity-layout'), 'proven-v1');
  setIpcAuthSecret('probe-host-key');
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await ipc?.close();
  setIpcAuthSecret(null);
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  if (rootProcess.exitCode === null && rootProcess.signalCode === null) {
    const exited = once(rootProcess, 'exit');
    rootProcess.kill('SIGKILL');
    await exited;
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('detached scheduled user credential target', () => {
  it('allows an unchanged detached target after provider resolution', async () => {
    vi.spyOn(tokens, 'resolveUserToken').mockResolvedValue('late-detached-token');
    const result = await requestFromRegisteredRoot();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, credential: 'late-detached-token' });
  });

  it('rejects a detached stored session that becomes headless during resolution', async () => {
    vi.spyOn(tokens, 'resolveUserToken').mockImplementation(async () => {
      session.headless = { id: headlessId, source: 'cli' };
      return 'late-detached-token';
    });
    const result = await requestFromRegisteredRoot();
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).not.toContain('late-detached-token');
  });

  it('rejects a mismatched active session even without headless metadata', async () => {
    vi.spyOn(tokens, 'resolveUserToken').mockImplementation(async () => {
      ds = { session: { ...session, sessionId: 'different-session' },
        larkAppId: app, chatId: 'oc_bg', workerGeneration: 2, reportedIdentityModel: { model: 'proven' } };
      return 'late-replacement-token';
    });
    const result = await requestFromRegisteredRoot();
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).not.toContain('late-replacement-token');
  });

  it('rejects an active session that becomes headless during resolution', async () => {
    vi.spyOn(tokens, 'resolveUserToken').mockImplementation(async () => {
      ds = { session: { ...session, headless: { id: headlessId, source: 'cli' } },
        larkAppId: app, chatId: 'oc_bg', workerGeneration: 2, reportedIdentityModel: { model: 'proven' } };
      return 'late-replacement-token';
    });
    const result = await requestFromRegisteredRoot();
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).not.toContain('late-replacement-token');
  });
});
