import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { forgetProvenIdentityContent, rememberProvenIdentityContent, sessionIdentityDataDir } from '../src/core/cli-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import * as scheduler from '../src/core/scheduler.js';
import * as registry from '../src/bot-registry.js';
import * as access from '../src/im/lark/event-dispatcher.js';
import * as publication from '../src/core/turn-cli-identity.js';
import { launchBackgroundExecution } from '../src/cli/background-execution.js';

let ipc: IpcServerHandle | undefined;
let store: ScheduleAuthorityStore | undefined;
let root = '', logDir = '', supervisorPid = 0;
const previous = config.session.dataDir;
afterEach(async () => {
  if (supervisorPid) {
    const birth = readProcessStartIdentity(supervisorPid);
    try { process.kill(supervisorPid, 'SIGTERM'); } catch { /* already finished */ }
    const deadline = Date.now() + 6500;
    while (birth && readProcessStartIdentity(supervisorPid) === birth && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    try { if (birth && readProcessStartIdentity(supervisorPid) === birth) process.kill(supervisorPid, 'SIGKILL'); } catch { /* gone */ }
    supervisorPid = 0;
  }
  await ipc?.close(); ipc = undefined;
  store?.close(); store = undefined;
  config.session.dataDir = previous; setIpcAuthSecret(null); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true }); root = '';
  if (logDir) rmSync(logDir, { recursive: true, force: true }); logDir = '';
});
async function waitResult(path: string, phase: number): Promise<{ ok: boolean; identityTurnId?: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const result = JSON.parse(readFileSync(path, 'utf8')); if (result.phase === phase) return result; } catch { /* writer in progress */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`background phase ${phase} timed out`);
}
describe.skipIf(process.platform !== 'linux')('background registration over real IPC and processes', () => {
  it('starts only after registration, rejects another same-UID peer, restores after daemon port/store restart, then revokes', async () => {
    root = mkdtempSync(join(tmpdir(), 'background-ipc-')); config.session.dataDir = root;
    vi.stubEnv('SESSION_DATA_DIR', root); vi.stubEnv('BOTMUX_NO_CLAIM', '1');
    const app = 'cli_backgroundipc', sessionId = 's-background-ipc';
    const turnId = 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc';
    const session: any = { sessionId, larkAppId: app, chatId: 'oc_background', status: 'active', sandbox: 'off', backendType: 'pty' };
    let ds: any = { session, larkAppId: app, chatId: session.chatId, workerGeneration: 1,
      worker: { pid: process.pid, connected: true, killed: false },
      reportedIdentityModel: { model: 'proven' },
      localProcessAttestation: { workerGeneration: 1, cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
      managedTurnOrigin: { turnId, callerOpenId: 'ou_background', capability: 'c'.repeat(64), dispatchAttempt: 1,
        preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] } };
    const bot: any = { larkAppId: app, backendType: 'pty', larkToolBinding: true };
    store = ScheduleAuthorityStore.open(root); store.initializeApp(app, []);
    store.createDirect({ id: 'abcd1234', larkAppId: app, chatId: session.chatId, name: 'job', enabled: true,
      ownerOpenId: 'ou_background', ownerUnionId: 'on_background', prompt: 'work', workingDir: root,
      parsed: { kind: 'interval', minutes: 30, display: 'every 30m' }, createdAt: new Date().toISOString() } as any);
    vi.spyOn(registry, 'getBot').mockReturnValue({ config: bot } as any);
    vi.spyOn(access, 'canOperate').mockReturnValue(true);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
    vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
    vi.spyOn(sessionStore, 'getOwnedSession').mockImplementation(id => id === sessionId ? session : undefined);
    vi.spyOn(scheduler, 'getScheduleAuthorityRecord').mockImplementation((id, a) => store!.getRecord(a!, id));
    vi.spyOn(scheduler, 'registerBackgroundExecution').mockImplementation(job => store!.registerBackgroundExecution(job));
    vi.spyOn(scheduler, 'backgroundExecutions').mockImplementation((a, s) => store!.backgroundExecutions(a, s));
    vi.spyOn(scheduler, 'revokeBackgroundExecution').mockImplementation(id => store!.revokeBackgroundExecution(id));
    vi.spyOn(publication, 'publishTurnCliIdentity').mockImplementation(async args => {
      rememberProvenIdentityContent(root, sessionId, args.turnId!, 'bytedcli',
        "BOTMUX_IDENTITY_MODE='local'\nBOTMUX_IDENTITY_OPEN_ID='ou_background'\n");
      return [];
    });
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const descriptor = join(root, 'dashboard-daemons', 'fixture.json'); mkdirSync(dirname(descriptor), { recursive: true });
    const advertise = () => writeFileSync(descriptor, JSON.stringify({ larkAppId: app, ipcPort: ipc!.port, pid: process.pid, lastHeartbeat: Date.now() }));
    advertise();
    const phaseFile = join(root, 'phase'), resultFile = join(root, 'result.json');
    const originalPort = ipc.port;
    const clientModule = pathToFileURL(resolve('dist/cli/current-execution.js')).href;
    const code = `const fs = require('node:fs'); let phase = 0, pending = false;
setInterval(async () => {
  if (pending || !fs.existsSync(${JSON.stringify(phaseFile)})) return;
  const next = Number(fs.readFileSync(${JSON.stringify(phaseFile)}, 'utf8'));
  if (next <= phase) return; phase = next; pending = true;
  try {
    const { resolveCurrentExecutionIdentity } = await import(${JSON.stringify(clientModule)});
    const identity = await resolveCurrentExecutionIdentity({ ipcPort: ${originalPort}, sessionId: ${JSON.stringify(sessionId)}, larkAppId: ${JSON.stringify(app)}, tool: 'bytedcli' });
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ phase, ok: true, identityTurnId: identity.identityTurnId }));
  } catch { fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ phase, ok: false })); }
  pending = false;
}, 25);`;
    // Use the production dist launcher: the runner entry exists on disk here,
    // while compiled verification exercises the equivalent hidden entry.
    const started = await launchBackgroundExecution({ ipcPort: originalPort, sessionId, larkAppId: app },
      { kind: 'launch', ttlSeconds: 3600, command: [process.execPath, '-e', code] },
      process.env.BOTMUX_TEST_BACKGROUND_BINARY
        ? { command: process.env.BOTMUX_TEST_BACKGROUND_BINARY, args: ['__background-execution-runner'] }
        : { command: process.execPath, args: [resolve('dist/background-execution-runner.js')] });
    supervisorPid = started.pid; logDir = dirname(started.logPath);
    expect(store.backgroundExecutions(app, sessionId)).toHaveLength(1);
    ds.managedTurnOrigin = undefined;
    const foreign = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, tool: 'bytedcli' }),
    });
    expect(foreign.status).toBe(403);
    writeFileSync(phaseFile, '1'); expect(await waitResult(resultFile, 1)).toMatchObject({ ok: true, identityTurnId: turnId });

    await ipc.close(); ipc = undefined;
    store.close(); store = ScheduleAuthorityStore.open(root); ds = undefined;
    forgetProvenIdentityContent(root, sessionId);
    const identityDir = sessionIdentityDataDir(root, sessionId); mkdirSync(identityDir, { recursive: true });
    writeFileSync(join(identityDir, 'identity-layout'), 'proven-v1');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); advertise();
    writeFileSync(phaseFile, '2'); expect(await waitResult(resultFile, 2)).toMatchObject({ ok: true, identityTurnId: turnId });
    store.updateTask(app, 'abcd1234', task => ({ ...task, enabled: false }));
    writeFileSync(phaseFile, '3'); expect(await waitResult(resultFile, 3)).toMatchObject({ ok: false });
    store.updateTask(app, 'abcd1234', task => ({ ...task, enabled: true }));
    writeFileSync(phaseFile, '4'); expect(await waitResult(resultFile, 4)).toMatchObject({ ok: false });
  }, 45_000);
});
