import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnTsEval } from './helpers/ts-runner.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { rememberProvenIdentityContent, recallProvenIdentityContent, sessionIdentityDataDir } from '../src/core/cli-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { bumpCliAuthEpoch } from '../src/services/cli-auth-epoch.js';
import { registerScheduledBackgroundExecution, resolveDetachedScheduledExecutionIdentity,
  resolveRegisteredBackgroundContext, revokeScheduledBackgroundExecution } from '../src/core/detached-scheduled-identity.js';

const h = vi.hoisted(() => ({ root: '', ds: undefined as any, session: undefined as any,
  store: undefined as any, allowed: true, delay: 0, publishes: 0, bot: undefined as any }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: h.bot }) }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'en' }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canOperate: () => h.allowed }));
vi.mock('../src/core/worker-pool.js', () => ({ findActiveBySessionId: (id: string) => id === 's-bg' ? h.ds : undefined,
  identityStorageModelForDaemonSession: () => 'proven' }));
vi.mock('../src/services/session-store.js', () => ({ getOwnedSession: (id: string) => id === 's-bg' ? h.session : undefined }));
vi.mock('../src/core/scheduler.js', () => ({
  getScheduleAuthorityRecord: (id: string, app: string) => h.store.getRecord(app, id),
  registerBackgroundExecution: (job: any) => h.store.registerBackgroundExecution(job),
  backgroundExecutions: (app: string, session: string) => h.store.backgroundExecutions(app, session),
  revokeBackgroundExecution: (id: string) => h.store.revokeBackgroundExecution(id),
}));
vi.mock('../src/core/platform-credential-source.js', () => ({ noteSenderUnionId() {} }));
vi.mock('../src/core/turn-cli-identity.js', () => ({ publishTurnCliIdentity: async (args: any) => {
  h.publishes++;
  if (h.delay) await new Promise(resolve => setTimeout(resolve, h.delay));
  const { rememberProvenIdentityContent } = await import('../src/core/cli-identity.js');
  const env = `BOTMUX_IDENTITY_MODE='local'\nBOTMUX_IDENTITY_OPEN_ID='${args.senderOpenId}'\n`;
  for (const tool of ['bytedcli', 'codebase', 'lark-cli'] as const) {
    rememberProvenIdentityContent(args.sessionDataDir, args.sessionId, args.turnId, tool, env);
  }
} }));
const app = 'cli_background';
const turn = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
let rootProcess: ChildProcess;
const peer = () => ({ pid: rootProcess.pid!, procStart: readProcessStartIdentity(rootProcess.pid!)! });
const input = () => ({ sessionDataDir: h.root, sessionId: 's-bg', peer: peer(), tool: 'bytedcli' as const });
const jwt = (seconds: number) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.sig`;
beforeEach(async () => {
  h.root = mkdtempSync(join(tmpdir(), 'registered-bg-'));
  h.store = ScheduleAuthorityStore.open(h.root); h.store.initializeApp(app, []);
  h.store.createDirect({ id: 'abcd1234', larkAppId: app, chatId: 'oc_bg', enabled: true,
    ownerOpenId: 'ou_bg', ownerUnionId: 'on_bg', name: 'job', prompt: 'work', workingDir: '/repo',
    parsed: { kind: 'interval', minutes: 30, display: 'every 30m' }, createdAt: new Date().toISOString() } as any);
  h.session = { sessionId: 's-bg', larkAppId: app, chatId: 'oc_bg', status: 'active', creationSource: 'message', sandbox: 'off' };
  h.ds = { session: h.session, larkAppId: app, chatId: 'oc_bg', workerGeneration: 1,
    worker: { pid: process.pid, killed: false, connected: true },
    reportedIdentityModel: { model: 'proven' },
    localProcessAttestation: { workerGeneration: 1, cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
    managedTurnOrigin: { turnId: turn, callerOpenId: 'ou_bg', dispatchAttempt: 1,
      capability: 'a'.repeat(64), preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] } };
  h.allowed = true; h.delay = h.publishes = 0;
  h.bot = { larkAppId: app, apiOnly: false };
  rootProcess = spawnTsEval('setInterval(() => {}, 1000)', { stdio: 'ignore' });
  await once(rootProcess, 'spawn');
});
afterEach(async () => {
  vi.useRealTimers();
  if (rootProcess.exitCode === null && rootProcess.signalCode === null) {
    const end = once(rootProcess, 'exit'); rootProcess.kill('SIGKILL'); await end;
  }
  h.store.close(); rmSync(h.root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('registered scheduled identity', () => {
  it('requires exact scheduled execution and original principal at registration', () => {
    expect(registerScheduledBackgroundExecution(input())).not.toBeNull();
    h.ds.managedTurnOrigin.turnId = 'om_ordinary';
    expect(registerScheduledBackgroundExecution(input())).toBeNull();
    h.ds.managedTurnOrigin.turnId = turn; h.ds.managedTurnOrigin.callerOpenId = 'ou_other';
    expect(registerScheduledBackgroundExecution(input())).toBeNull();
  });
  it('refuses persistent engine roots and a process already present before the turn', () => {
    expect(registerScheduledBackgroundExecution({ ...input(), peer: { pid: process.pid,
      procStart: readProcessStartIdentity(process.pid)! } })).toBeNull();
    h.ds.managedTurnOrigin.preexistingProcessIdentities.push(`${peer().pid}:${peer().procStart}`);
    expect(registerScheduledBackgroundExecution(input())).toBeNull();
  });
  it('uses the actual worker sandbox report even if frozen session configuration says off', () => {
    h.ds.reportedIdentityModel.sandboxEngaged = true;
    expect(registerScheduledBackgroundExecution(input())).toBeNull();
  });
  it('rejects a same-UID peer without registration even when its session has a schedule receipt', async () => {
    h.ds.managedTurnOrigin = undefined;
    h.session.dispatchInputReceipts = { [turn]: { committedAt: new Date().toISOString() } };
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
    expect(h.publishes).toBe(0);
  });
  it('continues for a registered root after turn terminal and authority-store restart', async () => {
    const job = registerScheduledBackgroundExecution(input())!; expect(job).not.toBeNull();
    h.ds = undefined; h.store.close(); h.store = ScheduleAuthorityStore.open(h.root);
    const dir = sessionIdentityDataDir(h.root, 's-bg'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity-layout'), 'proven-v1');
    const result = await resolveDetachedScheduledExecutionIdentity(input());
    expect(result?.identityTurnId).toBe(turn);
    expect(result?.env).toContain("BOTMUX_IDENTITY_OPEN_ID='ou_bg'");
    expect(h.publishes).toBe(1);
  });
  it.each(['pause', 'revoke', 'operator', 'claim', 'auth-epoch', 'close', 'expiry', 'policy'] as const)(
    'rejects %s during the provider await and removes late identity contents', async change => {
      const job = registerScheduledBackgroundExecution(input())!; expect(job).not.toBeNull();
      h.ds.managedTurnOrigin = undefined; vi.useFakeTimers();
      h.delay = change === 'expiry' ? 86_401_000 : 1000;
      const pending = resolveDetachedScheduledExecutionIdentity(input());
      await vi.advanceTimersByTimeAsync(100);
      if (change === 'pause') h.store.updateTask(app, 'abcd1234', (t: any) => ({ ...t, enabled: false }));
      if (change === 'revoke') h.store.revokeBackgroundExecution(job.id);
      if (change === 'operator') h.allowed = false;
      if (change === 'claim') h.store.updateTask(app, 'abcd1234', (t: any) => ({ ...t,
        runAsClaim: { larkAppId: app, openId: 'ou_new', unionId: 'on_new', claimedAt: new Date().toISOString() } }));
      if (change === 'auth-epoch') bumpCliAuthEpoch('ou_bg');
      if (change === 'close') h.session.status = 'closed';
      if (change === 'policy') h.bot.triggerUserAuth = { credentialSource: 'platform', enabled: true };
      if (change === 'expiry') await vi.advanceTimersByTimeAsync(86_400_000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBeNull();
      expect(recallProvenIdentityContent(h.root, 's-bg', `background:${job.id}`, 'bytedcli')).toBeUndefined();
    });
  it('does not accept a peer birth mismatch or cross-session selection', () => {
    registerScheduledBackgroundExecution(input());
    expect(resolveRegisteredBackgroundContext({ ...input(), peer: { ...peer(), procStart: 'reused' } })).toBeNull();
    expect(resolveRegisteredBackgroundContext({ ...input(), sessionId: 's-foreign' })).toBeNull();
  });
  it('coalesces concurrent cache misses without publishing another original turn', async () => {
    const job = registerScheduledBackgroundExecution(input())!; h.ds.managedTurnOrigin = undefined;
    vi.useFakeTimers(); h.delay = 1000;
    const first = resolveDetachedScheduledExecutionIdentity(input());
    const next = resolveDetachedScheduledExecutionIdentity(input());
    await vi.advanceTimersByTimeAsync(1100);
    expect(await first).toEqual(await next); expect(h.publishes).toBe(1);
    expect(recallProvenIdentityContent(h.root, 's-bg', turn, 'bytedcli')).toBeUndefined();
    expect(recallProvenIdentityContent(h.root, 's-bg', `background:${job.id}`, 'bytedcli')).toBeDefined();
  });
  it.each(['BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT', 'BOTMUX_IDENTITY_CLOUD_JWT_I18N',
    'BOTMUX_IDENTITY_CLOUD_JWT_I18NBD', 'BOTMUX_IDENTITY_CLOUD_JWT_TX'])('refreshes an expired %s independently', async field => {
      const job = registerScheduledBackgroundExecution(input())!; h.ds.managedTurnOrigin = undefined;
      const env = `BOTMUX_IDENTITY_MODE='local'\nBOTMUX_IDENTITY_OPEN_ID='ou_bg'\n`
        + ['BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT', 'BOTMUX_IDENTITY_CLOUD_JWT_I18N',
          'BOTMUX_IDENTITY_CLOUD_JWT_I18NBD', 'BOTMUX_IDENTITY_CLOUD_JWT_TX']
          .map(key => `${key}='${jwt(key === field ? -60 : 7200)}'`).join('\n');
      rememberProvenIdentityContent(h.root, 's-bg', `background:${job.id}`, 'bytedcli', env);
      await resolveDetachedScheduledExecutionIdentity(input()); expect(h.publishes).toBe(1);
    });
  it('resolves opaque legacy Lark UATs from the provider on each invocation', async () => {
    registerScheduledBackgroundExecution(input()); h.ds.managedTurnOrigin = undefined;
    await resolveDetachedScheduledExecutionIdentity({ ...input(), tool: 'lark-cli' });
    await resolveDetachedScheduledExecutionIdentity({ ...input(), tool: 'lark-cli' });
    expect(h.publishes).toBe(2);
  });
  it('supports explicit self-revocation and cannot restore the same job cache', async () => {
    const job = registerScheduledBackgroundExecution(input())!; h.ds.managedTurnOrigin = undefined;
    await resolveDetachedScheduledExecutionIdentity(input());
    expect(revokeScheduledBackgroundExecution({ ...input(), jobId: job.id })).toBe(true);
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
  });
  it('does not resurrect a job after an observed credential-policy withdrawal is restored', async () => {
    registerScheduledBackgroundExecution(input()); h.ds.managedTurnOrigin = undefined;
    await resolveDetachedScheduledExecutionIdentity(input());
    h.bot.triggerUserAuth = { credentialSource: 'platform', enabled: true };
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
    delete h.bot.triggerUserAuth;
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
  });
  it('retires a job when transport withdrawal makes its authorization context unavailable', async () => {
    registerScheduledBackgroundExecution(input()); h.ds.managedTurnOrigin = undefined;
    await resolveDetachedScheduledExecutionIdentity(input());
    h.bot.apiOnly = true;
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
    h.bot.apiOnly = false;
    h.store.close(); h.store = ScheduleAuthorityStore.open(h.root);
    expect(await resolveDetachedScheduledExecutionIdentity(input())).toBeNull();
  });
});
