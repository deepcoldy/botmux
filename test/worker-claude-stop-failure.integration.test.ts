/**
 * Claude `StopFailure` fallback end to end: the REAL hook client
 * (`botmux __claude-stop-failure-v1`) → the REAL daemon route
 * `/api/claude-stop-failure` behind `startIpcServer({ authRequired: true })` →
 * a REAL worker (tmux backend + claude-code adapter + transcript bridge)
 * driving a fake Claude Code whose `FAIL…` turns end the way Claude 2.1.296
 * ends a turn on "API Error: Connection lost mid-response.": a thinking block,
 * the API-error record (`error:"server_error"`), then `system/turn_duration`.
 *
 * The client runs on the trusted-host path (a host secret in its HOME), so the
 * route's live-origin fence is out of play; that fence and the isolated
 * session's relay-outbox fallback have their own boundary tests.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __testOnly_activeSessions } from '../src/daemon.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS } from '../src/services/claude-stop-failure.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';
import { spawnTsScript } from './helpers/ts-runner.js';

// The workers run with locale zh; the expected notice comes from the same key.
setDefaultLocale('zh');
const UNSETTLED_NOTICE = t('worker.claude_stop_failure_unsettled', {
  cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code',
  errorCode: 'provider_server_error',
});
const HOST_SECRET = 'test-claude-stop-failure-e2e-host-secret';
const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');

let ipc: IpcServerHandle | null = null;
let hookHome: string;

beforeEach(async () => {
  setIpcAuthSecret(HOST_SECRET);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  hookHome = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-e2e-home-'));
  mkdirSync(join(hookHome, '.botmux'), { recursive: true, mode: 0o700 });
  writeFileSync(join(hookHome, '.botmux', '.dashboard-secret'), `${HOST_SECRET}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await cleanUpClaudeHarnesses();
  if (ipc) await ipc.close();
  ipc = null;
  __testOnly_activeSessions.clear();
  setIpcAuthSecret(null);
  rmSync(hookHome, { recursive: true, force: true });
});

type Terminal = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
const terminalsOf = (g: Generation, turnId: string): Terminal[] =>
  g.messages.filter((m): m is Terminal => m.type === 'turn_terminal' && m.turnId === turnId);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** The daemon's view of the session: the route forwards to this worker. */
function mountDaemonSession(h: Harness, g: Generation): void {
  __testOnly_activeSessions.set(h.sessionId, {
    session: { sessionId: h.sessionId },
    worker: { send: (msg: DaemonToWorker) => g.child.send(msg) },
  } as never);
}

/** Run the hook client the way Claude does when the turn ends on its error. */
function runHookClient(h: Harness, turnId: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: hookHome,
    USERPROFILE: hookHome,
    SESSION_DATA_DIR: join(hookHome, 'data'),
    BOTMUX_SESSION_ID: h.sessionId,
    BOTMUX_LARK_APP_ID: 'app_test',
    BOTMUX_DAEMON_IPC_PORT: String(ipc!.port),
    BOTMUX_TURN_ID: turnId,
  };
  for (const key of ['BOTMUX_SEND_RELAY', 'BOTMUX_DISPATCH_ATTEMPT', 'BOTMUX_ORIGIN_CHANNEL_ID', 'CLAUDE_PID']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, ['__claude-stop-failure-v1'], { env, stdio: ['pipe', 'ignore', 'ignore'] }) as ChildProcessWithoutNullStreams;
    child.once('error', reject);
    child.once('close', resolve);
    child.stdin.end(JSON.stringify({
      session_id: h.sessionId,
      transcript_path: h.transcript(h.sessionId),
      hook_event_name: 'StopFailure',
      error: 'server_error',
      last_assistant_message: 'API Error: Connection lost mid-response. The response above may be incomplete.',
    }));
  });
}

async function startWorker(h: Harness): Promise<Generation> {
  const g = h.startWorker();
  mountDaemonSession(h, g);
  await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
  return g;
}

describe.skipIf(!runnable)('Claude StopFailure fallback, hook client → daemon route → worker', () => {
  it('stays quiet when the transcript settles the failed turn itself', async () => {
    const h = setup({ turnMs: 1_000 });
    const g = await startWorker(h);
    g.child.send({ type: 'message', content: 'FAIL right away', turnId: 'om_fail_now' } satisfies DaemonToWorker);
    await g.waitFor(() => terminalsOf(g, 'om_fail_now').length > 0, 'the transcript terminal');
    expect(terminalsOf(g, 'om_fail_now')).toEqual([expect.objectContaining({
      status: 'failed', errorCode: 'provider_server_error', retryable: true,
    })]);

    expect(await runHookClient(h, 'om_fail_now')).toBe(0);
    await sleep(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 2_000);
    expect(terminalsOf(g, 'om_fail_now')).toHaveLength(1);
    expect(g.notices().map(n => n.message)).not.toContain(UNSETTLED_NOTICE);
  }, 120_000);

  it('stays quiet for a report that arrives long after the turn already failed', async () => {
    // A hook client that started unusually slowly: the report lands outside the
    // window around the failure, so only the failed turn's own terminal status
    // (as the worker recorded it) can tell that the failure already surfaced.
    const h = setup({ turnMs: 1_000 });
    const g = await startWorker(h);
    g.child.send({ type: 'message', content: 'FAIL right away, reported late', turnId: 'om_fail_late' } satisfies DaemonToWorker);
    await g.waitFor(() => terminalsOf(g, 'om_fail_late').length > 0, 'the transcript terminal');
    await sleep(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 1_000);

    expect(await runHookClient(h, 'om_fail_late')).toBe(0);
    await sleep(CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 2_000);
    expect(terminalsOf(g, 'om_fail_late')).toHaveLength(1);
    expect(g.notices().map(n => n.message)).not.toContain(UNSETTLED_NOTICE);
  }, 120_000);

  it('reports a failure that lands after its turn was already closed', async () => {
    // The quiet screen mid-turn closes the turn as completed; the API error
    // that ends the real work afterwards has no turn left to fail.
    const h = setup({ turnMs: 1_000 });
    const g = await startWorker(h);
    const prompt = 'FAIL_AFTER_QUIET long task';
    g.child.send({ type: 'message', content: prompt, turnId: 'om_long_task' } satisfies DaemonToWorker);
    await g.waitFor(() => h.failedAt(prompt) !== undefined, 'the turn to end on its API error', 60_000);
    await sleep(2_000);
    // Without the hook nothing tells the chat: the turn reads as completed.
    expect(terminalsOf(g, 'om_long_task').map(m => m.status)).toEqual(['completed']);
    expect(g.notices()).toEqual([]);

    expect(await runHookClient(h, 'om_long_task')).toBe(0);
    await g.waitFor(
      () => g.notices().some(n => n.message === UNSETTLED_NOTICE),
      'the StopFailure notice',
      CLAUDE_STOP_FAILURE_SETTLE_GRACE_MS + 10_000,
    );
    expect(g.notices().find(n => n.message === UNSETTLED_NOTICE)?.turnId).toBe('om_long_task');
    expect(terminalsOf(g, 'om_long_task')).toHaveLength(1);
  }, 120_000);
});
