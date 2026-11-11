/**
 * A message wakes a suspended Claude session: the daemon forks a worker whose
 * CLI resumes under the session's resume operation, carrying the message as its
 * opening turn. Claude never reports SessionStart, so the ready gate releases
 * on its 45 s timeout; the bot's startup command runs, then the message is
 * written, and only then does the resumed Claude show its native session id.
 *
 * Production (2026-11-10): the resume had been confirmed at that prompt, the
 * live runtime's identity update still carried the resume's operation, the
 * session contract retired the runtime and told the worker not to execute —
 * which stopped its transcript bridge. Claude answered in the terminal, the
 * group never got the reply.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude; the
 * daemon side is the real worker IPC handler with the real session contract.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
}));

import { sessionReadyHookCommand } from '../src/adapters/hook-command.js';
import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude as setup,
} from './helpers/claude-worker-harness.js';

const APP = 'app_test';
const WAKE_TURN = 'om_wake_turn';
const WAKE_TEXT = 'wake question';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

let dataDir: string | undefined;
let previousDataDir: string | undefined;
let closeContract: (() => void) | undefined;

afterEach(async () => {
  await cleanUpClaudeHarnesses();
  closeContract?.(); closeContract = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
  vi.restoreAllMocks();
});

describe.skipIf(!runnable)('a message waking a suspended Claude session', () => {
  it('forwards the reply once when the ready gate falls back and a startup command runs first', async () => {
    const h = setup({ turnMs: 800 });
    const transcript = h.transcript(h.sessionId);
    // What the session answered before it was suspended.
    const ago = (ms: number) => new Date(Date.now() - 3_600_000 + ms).toISOString();
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, [
      { type: 'user', uuid: randomUUID(), timestamp: ago(0), message: { role: 'user', content: 'earlier question' } },
      { type: 'assistant', uuid: randomUUID(), timestamp: ago(1_000), message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1_000, uuid: randomUUID(), timestamp: ago(1_100) },
    ].map(row => `${JSON.stringify({ sessionId: h.sessionId, ...row })}\n`).join(''));
    // botmux's SessionStart hook is installed, so the ready gate arms; the fake
    // never runs it, so the gate releases on its timeout.
    writeFileSync(join(h.claudeDir, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: sessionReadyHookCommand() }] }] },
    }));

    dataDir = mkdtempSync(join(tmpdir(), 'bmx-wake-contract-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
    vi.spyOn(bots, 'getBot').mockReturnValue({
      config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'WakeBot',
    } as any);
    const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply');
    workerPool.initWorkerPool({
      sessionReply, getSessionWorkingDir: () => h.workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
    } as any);
    const ds = {
      session: { sessionId: h.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'claude-code',
        createdAt: new Date().toISOString(), workerGeneration: 1,
        replyTargets: { [WAKE_TURN]: { rootMessageId: WAKE_TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } } },
      larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
      workerGeneration: 1, workerPort: 0, workerToken: 'token',
      spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
    } as unknown as DaemonSession;

    // The session was suspended; forkWorker's contract bootstrap for the
    // message that wakes it.
    const controller = controllerForSession(ds, true)!;
    closeContract = () => controller.store.close();
    const suspend = controller.beginControl('suspend').operation.operationId;
    controller.controlStarted(suspend); controller.controlResult(suspend, 'confirmed');
    const restartAttemptId = controller.prepareWorkerStart();
    expect(controller.operation(restartAttemptId)?.kind).toBe('resume');
    const sessionContract = controller.bindWorker(1);
    const init = {
      type: 'init' as const, sessionId: h.sessionId, resume: true, cliId: 'claude-code', backendType: 'tmux' as const,
      promptInjection: undefined, startupCommands: ['/effort xhigh'],
      prompt: WAKE_TEXT, turnId: WAKE_TURN, trustedCaller: caller, restartAttemptId, sessionContract,
      sessionCommand: { version: 2 as const, execution: controller.admitInput(WAKE_TURN) },
    };
    ds.initConfig = init as any;

    const g = h.startWorker(init as any);
    (ds as any).worker = g.child;
    workerPool.__testOnly_setupWorkerHandlers(ds, g.child as any, undefined, 1);

    const replies = () => sessionReply.mock.calls.map(args => String(args[1]));
    const wakeReplies = () => replies().filter(text => text.includes(`reply: ${WAKE_TEXT}`));
    await g.waitFor(() => wakeReplies().length > 0, 'the reply to the waking message in the group', 120_000);
    // A duplicate would follow within a bridge tick or two.
    await new Promise(done => setTimeout(done, 3_000));
    const log = g.logs.join('');
    expect(wakeReplies(), log).toHaveLength(1);

    // The path this covers: gate fallback, the startup command, then the write.
    const at = (needle: string) => log.indexOf(needle);
    expect(at('Ready gate released (signal timeout fallback)'), log).toBeGreaterThan(-1);
    expect(at('Startup command confirmed'), log).toBeGreaterThan(at('Ready gate released (signal timeout fallback)'));
    expect(at('Writing to PTY'), log).toBeGreaterThan(at('Startup command confirmed'));
    expect(at('Published CLI session id'), log).toBeGreaterThan(at('Writing to PTY'));
    expect(controller.operation(restartAttemptId)?.phase).toBe('confirmed');
    expect(log).not.toContain('mayExecute=false');
    expect(controller.store.runtime(controller.ref)?.identity?.nativeSessionId).toBe(h.sessionId);
  }, 180_000);
});
