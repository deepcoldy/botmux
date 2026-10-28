/** #2262 across the real process boundary: the shipped `botmux report` CLI
 * talks to the real daemon IPC route (authorization, journal, sessionReply).
 * Only the Lark provider and the orchestrator daemon transport are replaced. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mocks = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? '/tmp'}/report-fallback-import-${process.pid}`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  return {
    reply: vi.fn(async (..._args: unknown[]) => 'om_fallback'),
    send: vi.fn(async (..._args: unknown[]) => 'om_top'),
    online: vi.fn(), fetch: vi.fn(),
  };
});
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/im/lark/client.js', async () => ({
  ...await vi.importActual<any>('../src/im/lark/client.js'),
  replyMessage: mocks.reply, sendMessage: mocks.send,
}));
vi.mock('../src/utils/daemon-discovery.js', async () => ({
  ...await vi.importActual<any>('../src/utils/daemon-discovery.js'), findOnlineDaemon: mocks.online,
}));
vi.mock('../src/core/daemon-ipc-auth.js', async () => ({
  ...await vi.importActual<any>('../src/core/daemon-ipc-auth.js'), fetchDaemonIpc: mocks.fetch,
}));
import { __testOnly_activeSessions as sessions, __testOnly_setDaemonLarkAppId as setApp } from '../src/daemon.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { registerBot, getBot } from '../src/bot-registry.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { config } from '../src/config.js';
import { createDispatchReportBinding, dispatchReportBindingSecretPath } from '../src/core/dispatch-report-binding.js';
import { loadOrCreateDashboardSecret } from '../src/dashboard/auth.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { UNDELIVERED_REPORT_RELAY_REASON_TEXT } from '../src/core/report-session-relay.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const APP = 'cli_report_fallback';
const CHAT = 'oc_report_fallback';
const ROOT = 'om_dispatch';
const CAP = 'e'.repeat(64);
let sandbox: string;
let data: string;
let server: IpcServerHandle;
let ds: DaemonSession;
const originalDataDir = config.session.dataDir;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'report-fallback-'));
  data = join(sandbox, 'data');
  mkdirSync(data);
  config.session.dataDir = data;
  mocks.reply.mockReset().mockResolvedValue('om_fallback');
  mocks.send.mockReset().mockResolvedValue('om_top');
  mocks.online.mockReset().mockReturnValue({ ipcPort: 19999 });
  mocks.fetch.mockReset().mockImplementation(async (_port: number, path: string) => new Response(JSON.stringify(
    path === '/api/trigger' ? { ok: true, triggerId: 'trigger-report' } : { ok: true },
  ), { status: 200 }));
  registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [] });
  setApp(APP); sessions.clear(); setActiveSessionsRegistry(sessions);
  const row = { sessionId: 'source', larkAppId: APP, chatId: CHAT, rootMessageId: ROOT, scope: 'thread' as const,
    status: 'active' as const, createdAt: new Date().toISOString(), title: 'dispatched task', workingDir: sandbox };
  ds = { larkAppId: APP, chatId: CHAT, scope: 'thread', session: { ...row },
    managedTurnOrigin: { capability: CAP, turnId: 'turn-report', dispatchAttempt: 2 } } as DaemonSession;
  sessions.set(activeSessionKey(ds), ds);
  // The CLI process resolves the same session from its persisted row.
  seedPersistedSessionRows(data, APP, { source: row });
  const secret = loadOrCreateDashboardSecret(dispatchReportBindingSecretPath(data));
  writeFileSync(join(data, 'orchestrate-dispatch.json'), JSON.stringify({
    [ROOT]: { orchAppId: 'cli_lead', orchSessionId: 'lead', reportBinding: createDispatchReportBinding(secret, {
      dispatchRoot: ROOT, targetLarkAppId: 'cli_lead', targetSessionId: 'lead', sourceName: 'task',
      issuedAt: new Date().toISOString(),
    }) },
  }));
  setIpcAuthSecret('test-ipc-secret');
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await server?.close(); setApp(undefined); setIpcAuthSecret(null);
  sessions.clear(); setActiveSessionsRegistry(undefined); config.session.dataDir = originalDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Run the real CLI as the dispatched sub-bot would, inside its capability relay. */
async function runReport(args: string[]) {
  const home = join(sandbox, 'home');
  const relay = join(sandbox, 'relay');
  mkdirSync(home, { recursive: true });
  mkdirSync(relay, { recursive: true });
  writeFileSync(join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
    token: CAP, turnId: 'turn-report', dispatchAttempt: 2,
  }), { mode: 0o600 });
  const botsConfig = join(sandbox, 'bots.json');
  writeFileSync(botsConfig, '[]');
  const cliSends = join(sandbox, 'cli-sends.json');
  // Any Lark write by the CLI itself would be a second, unjournaled copy.
  const script = `
    import { writeFileSync } from 'node:fs';
    import { registerBot } from ${JSON.stringify(pathToFileURL(resolve('src/bot-registry.ts')).href)};
    const state = registerBot({ larkAppId: ${JSON.stringify(APP)}, larkAppSecret: 'test-secret', cliId: 'claude-code', allowedUsers: [] });
    const sends = [];
    state.client.request = async () => { throw new Error('Unexpected provider request'); };
    for (const method of ['create', 'reply']) {
      state.client.im.v1.message[method] = async request => {
        sends.push({ method, request }); writeFileSync(${JSON.stringify(cliSends)}, JSON.stringify(sends));
        return { code: 0, data: { message_id: 'om_cli_copy' } };
      };
    }
    process.argv = ['node', 'botmux', 'report', ...${JSON.stringify(['--session-id', 'source', ...args])}];
    await import(${JSON.stringify(pathToFileURL(resolve('src/cli.ts')).href)});
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BOTMUX_') && !['BOTS_CONFIG', 'SESSION_DATA_DIR'].includes(key)));
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawnTsEvalWithRepoImports(script, {
      env: { ...env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: botsConfig,
        BOTMUX_SEND_RELAY: relay, BOTMUX_DAEMON_IPC_PORT: String(server.port) },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => done({ status, stdout, stderr }));
  });
  const line = (text: string, prefix: string) => {
    const found = text.split('\n').find(entry => entry.startsWith(prefix));
    return found ? JSON.parse(found) : undefined;
  };
  let cliWrites: unknown[] = [];
  try { cliWrites = JSON.parse((await import('node:fs')).readFileSync(cliSends, 'utf8')); } catch { /* none */ }
  return { ...result, output: line(result.stdout, '{"success":true'),
    failure: line(result.stderr, '{"success":false'), cliWrites };
}

describe('botmux report relay fallback, CLI to daemon (#2262)', () => {
  it('keeps a healthy relay exactly as before: orchestrator session, nothing visible', async () => {
    const result = await runReport(['--dispatch-root', ROOT, 'Done']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toMatchObject({ delivery: 'orchestrator-session', reportedTo: 'lead', viaRegistry: true });
    expect(mocks.fetch.mock.calls.filter(call => call[1] === '/api/trigger')).toHaveLength(1);
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(result.cliWrites).toEqual([]);
  });

  it('publishes once in the dispatch thread and tells the sub-bot when the orchestrator is offline', async () => {
    mocks.online.mockReturnValue(undefined);
    const result = await runReport(['--dispatch-root', ROOT, 'Done']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toMatchObject({
      success: true, delivery: 'lark-message', relayDelivered: false, publishedMessageId: 'om_fallback',
      publicationTarget: { mode: 'thread', rootMessageId: ROOT, chatId: CHAT },
      relayFailure: { reason: 'orchestrator_offline' },
    });
    expect(result.output.notice).toContain(UNDELIVERED_REPORT_RELAY_REASON_TEXT.orchestrator_offline);
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls[0]![1]).toBe(ROOT);
    expect(mocks.reply.mock.calls[0]![2]).toContain(`未送达主编排：${UNDELIVERED_REPORT_RELAY_REASON_TEXT.orchestrator_offline}`);
    expect(result.cliWrites).toEqual([]);
  });

  it('publishes for a named dispatch root that is no longer registered', async () => {
    writeFileSync(join(data, 'orchestrate-dispatch.json'), '{}');
    const result = await runReport(['--dispatch-root', ROOT, 'Done']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toMatchObject({ relayDelivered: false, relayFailure: { reason: 'dispatch_target_gone' } });
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fails with the reason instead of publishing for a private-card bot', async () => {
    getBot(APP).config.privateCard = true;
    mocks.online.mockReturnValue(undefined);
    const result = await runReport(['--dispatch-root', ROOT, 'Done']);
    expect(result.status).toBe(1);
    expect(result.output).toBeUndefined();
    expect(result.failure).toMatchObject({ success: false, error: 'orchestrator_daemon_offline',
      relayFailure: { reason: 'orchestrator_offline' }, publicationBlockedBy: 'private_card' });
    expect(result.failure.notice).toContain(UNDELIVERED_REPORT_RELAY_REASON_TEXT.orchestrator_offline);
    expect(mocks.reply).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(result.cliWrites).toEqual([]);
  });
});
