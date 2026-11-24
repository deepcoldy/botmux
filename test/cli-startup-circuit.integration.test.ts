/** Real worker + private tmux + real SQLite contract and daemon IPC handler.
 * The fake Pi never prints a composer or a transcript, then exits nonzero.
 * No live daemon, real provider or real Lark transport is used. */
import { execFileSync } from 'node:child_process';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async original => ({
  ...(await original<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction'), removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
}));
import { updateMessage } from '../src/im/lark/client.js';
import { config } from '../src/config.js';
import { t } from '../src/i18n/index.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { normalizeSessionRow } from '../src/services/session-observe.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import { claudeHarnessRunnable, setupFakeClaude, cleanUpClaudeHarnesses } from './helpers/claude-worker-harness.js';

let dataDir: string | undefined;
let closeStore: (() => void) | undefined;
afterEach(async () => {
  pool.setActiveSessionsRegistry(undefined);
  pool.__testOnly_resetRestartCoordinator();
  pool.__testOnly_resetOrdinaryImDeliveries();
  await cleanUpClaudeHarnesses();
  closeStore?.(); closeStore = undefined;
  if (dataDir !== undefined) config.session.dataDir = dataDir;
  dataDir = undefined;
  vi.restoreAllMocks();
});

function setupStartupHarness(instant = false) {
  const h = setupFakeClaude({ turnMs: 50 });
  const launches = join(h.root, 'pi-launches');
  const cli = join(h.root, 'pi');
  writeFileSync(cli, `#!/usr/bin/env node
  const fs = require('node:fs');
  if (process.argv.includes('--version')) { console.log('pi 0.0.0-test'); process.exit(0); }
  const file = ${JSON.stringify(launches)};
  const n = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').length + 1 : 1;
  fs.appendFileSync(file, JSON.stringify({ n, args: process.argv.slice(2) }) + '\\n');
  console.error('startup diagnostic with fake credential SECRET_MUST_NOT_LEAK');
  ${instant ? 'process.exit(1);' : ''}
  setInterval(() => process.stdout.write('Starting plugin...\\r'), 100);
  setInterval(() => { if (fs.existsSync(${JSON.stringify(h.root)} + '/exit-' + n)) process.exit(1); }, 50);
  `);
  chmodSync(cli, 0o755);
  dataDir = config.session.dataDir;
  config.session.dataDir = join(h.root, 'data');
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
  vi.spyOn(bots, 'getBot').mockReturnValue({ config: {
    larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'pi', replyDelivery: 'send',
  }, resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'TestBot' } as any);
  const reply = vi.fn(async () => 'om_reply');
  pool.initWorkerPool({ sessionReply: reply, getSessionWorkingDir: () => h.workingDir,
    getActiveCount: () => 1, closeSession: vi.fn() } as any);
  const now = new Date().toISOString();
  const ds = { session: { sessionId: h.sessionId, rootMessageId: 'om_root', chatId: 'oc_test', chatType: 'group',
    status: 'active', cliId: 'pi', backendType: 'tmux', createdAt: now, updatedAt: now, workerGeneration: 1 },
    larkAppId: 'app_test', chatId: 'oc_test', chatType: 'group', workerGeneration: 1,
    workerPort: null, workerToken: null, spawnedAt: Date.now(), lastMessageAt: Date.now(),
    hasHistory: false, currentTurnId: 'om_opening', workingDir: h.workingDir,
    streamCardId: 'om_starting_card', streamCardNonce: 'nonce', lastScreenStatus: 'starting',
  } as unknown as DaemonSession;
  const controller = controllerForSession(ds, true)!;
  closeStore = () => controller.store.close();
  const sessionContract = controller.bindWorker(1);
  const init = { cliId: 'pi', cliPathOverride: cli, prompt: 'opening task', turnId: 'om_opening',
    sessionContract, sessionCommand: { version: 2, execution: controller.admitInput('om_opening') },
    launchShell: '/bin/sh' } as const;
  ds.initConfig = init as any;
  const g = h.startWorker(init);
  ds.worker = g.child;
  pool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  pool.__testOnly_setupWorkerHandlers(ds, g.child, undefined, 1);
  const count = () => existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\n').length : 0;
  return { h, ds, g, reply, count, controller };
}

describe.skipIf(!claudeHarnessRunnable)('CLI startup crash circuit end to end', () => {
  it('restarts an unstarted Pi once, fails its queued turns, patches the starting card and allows a new batch', async () => {
    const { h, ds, g, reply, count } = setupStartupHarness();
    await g.waitFor(() => count() === 1 && g.messages.some(m => m.type === 'ready'), 'first CLI and worker initialized', 45_000);
    // Match the incident: old tmux installations discard failed panes instead
    // of retaining an exit-code remnant. The private server is the only target.
    let keeperStarted = false;
    const discardFailedPane = () => {
      const target = g.messages.find(m => m.type === 'persistent_backend_target');
      if (!target || target.type !== 'persistent_backend_target' || target.target.backendType !== 'tmux') throw new Error('missing private tmux target');
      if (!keeperStarted) {
        // Keep the private server alive after our pane disappears: this drives
        // three authoritative pane misses, not the separate server-loss path.
        execFileSync('tmux', ['-L', target.target.socketName ?? 'default', 'new-session',
          '-d', '-s', 'startup-fixture-keeper', 'sleep 120'], { env: privateTmuxEnv(h.root) });
        keeperStarted = true;
      }
      execFileSync('tmux', ['-L', target.target.socketName ?? 'default', 'set-window-option',
        '-t', target.target.sessionName, 'remain-on-exit', 'off'], { env: privateTmuxEnv(h.root) });
    };
    discardFailedPane();
    expect(pool.sendWorkerInput(ds, 'queued before crash', 'om_queued')).toBe(true);
    writeFileSync(join(h.root, 'exit-1'), '');
    await g.waitFor(() => count() === 2, 'real replacement after startup exit', 30_000);
    expect(g.messages.some(m => m.type === 'claude_exit' && m.code === 1 && m.startupFailure)).toBe(true);
    // First attempt's absence is observable, not an immortal working card.
    expect(ds.lastScreenStatus).not.toBe('working');
    const replacement = g.messages.filter(m => m.type === 'runtime_binding_started').at(-1);
    await g.waitFor(() => replacement?.type === 'runtime_binding_started' && g.messages.some(m =>
      m.type === 'runtime_binding' && m.bindingId === replacement.bindingId), 'replacement observer wired');
    discardFailedPane();
    writeFileSync(join(h.root, 'exit-2'), '');
    await g.waitFor(() => ds.cliStartupFailureReason !== undefined, 'startup circuit open', 30_000);
    await g.waitFor(() => g.messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_queued'
      && m.status === 'failed' && m.errorCode === 'cli_startup_failed'), 'queued turn terminal', 15_000);
    const failureReason = t('worker.startup_circuit_stopped', { cliName: 'Pi', code: 1 }, 'zh');
    await g.waitFor(() => vi.mocked(updateMessage).mock.calls.some(call => call[1] === 'om_starting_card'
      && String(call[2]).includes(failureReason)), 'starting card patched with safe diagnosis');
    const observed = normalizeSessionRow(composeRowFromActive(ds), { observedAt: Date.now(), includeTask: true });
    expect(observed.schemaVersion).toBe(1);
    expect(observed.turn).toBe('interrupted');
    expect(observed.task).toMatchObject({ kind: 'needs_you', reason: 'interrupted' });
    expect(observed.attention?.reason).toBe(failureReason);
    expect(JSON.stringify(vi.mocked(updateMessage).mock.calls)).not.toContain('SECRET_MUST_NOT_LEAK');
    expect(JSON.stringify(reply.mock.calls)).not.toContain('SECRET_MUST_NOT_LEAK');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(count()).toBe(2);
    expect(pool.sendWorkerInput(ds, 'a new recovery task', 'om_recovery')).toBe(true);
    await g.waitFor(() => count() === 3, 'new message starts a fresh bounded batch', 30_000);
    expect(ds.cliStartupFailureReason).toBeUndefined();
    process.stdout.write('startup sequence:\n' + g.logs.join('').split('\n').filter(line => /Spawning fresh CLI|pane.*(missing|gone)|exited \(code|will re-queue|Startup circuit|Message received after crash-loop/.test(line)).join('\n') + '\n');
  }, 150_000);

  it('fails closed with a safe card even when exit 1 occurs before backend observers are installed', async () => {
    const { ds, g, reply, count } = setupStartupHarness(true);
    await vi.waitFor(() => expect(g.messages.some(m => m.type === 'error')).toBe(true), { timeout: 45_000 });
    await vi.waitFor(() => expect(ds.cliStartupFailureReason).toBeDefined());
    await vi.waitFor(() => expect(vi.mocked(updateMessage).mock.calls.some(call =>
      call[1] === 'om_starting_card' && String(call[2]).includes(JSON.stringify(ds.cliStartupFailureReason).slice(1, -1)))).toBe(true));
    expect(g.messages.some(m => m.type === 'ready')).toBe(false);
    expect(count()).toBe(1);
    expect(JSON.stringify(reply.mock.calls)).not.toContain('SECRET_MUST_NOT_LEAK');
    expect(JSON.stringify(vi.mocked(updateMessage).mock.calls)).not.toContain('SECRET_MUST_NOT_LEAK');
    const observed = normalizeSessionRow(composeRowFromActive(ds), { observedAt: Date.now(), includeTask: true });
    expect(observed.turn).not.toBe('working');
    expect(observed.task).toMatchObject({ kind: 'needs_you', reason: 'interrupted' });
  }, 60_000);
});
