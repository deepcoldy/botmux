/**
 * A worker that starts WITH an opening turn — a new topic's first message, or
 * a dormant session woken by a message — reports its identity decision from
 * inside the CLI start, while that turn is still queued in the session
 * contract. Production v3.59.0 / v3.59.1: the contract refused the report, the
 * daemon stayed on the fail-closed single model for the whole worker
 * generation, and every proven identity wrapper (bytedcli, codebase) exited
 * 77 `current_execution_unverified` although `botmux execution current` was
 * verified. Starting WITHOUT a turn (plain restore) was unaffected.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude; the
 * daemon side is the real worker IPC handler with the real session contract.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
}));

import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { logger } from '../src/utils/logger.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude as setup,
} from './helpers/claude-worker-harness.js';

const APP = 'app_test';
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

describe.skipIf(!runnable)('identity decision of a worker started with its opening turn', () => {
  it.each(['a new topic', 'a dormant session woken by a message'])('reaches the daemon for %s', async start => {
    const wake = start.includes('dormant');
    const turnId = wake ? 'om_wake_turn' : 'om_first_turn';
    const text = wake ? 'wake question' : 'first question';
    const h = setup({ turnMs: 800 });
    dataDir = mkdtempSync(join(tmpdir(), 'bmx-identity-decision-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
    vi.spyOn(bots, 'getBot').mockReturnValue({
      config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'DecisionBot',
    } as any);
    const dropped: string[] = [];
    const warn = logger.warn.bind(logger);
    vi.spyOn(logger, 'warn').mockImplementation((message: string, ...rest: unknown[]) => {
      if (String(message).includes('Dropped session_identity_decision')) dropped.push(String(message));
      return warn(message, ...rest);
    });
    const decisions: Array<{ model: string; turnId?: string }> = [];
    const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply');
    workerPool.initWorkerPool({
      sessionReply, getSessionWorkingDir: () => h.workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
      onIdentityDecision: async (_ds: unknown, context: { model: string; turnId?: string }) => { decisions.push(context); },
    } as any);
    const ds = {
      session: { sessionId: h.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'claude-code',
        backendType: 'tmux', createdAt: new Date().toISOString(), workerGeneration: 1,
        replyTargets: { [turnId]: { rootMessageId: turnId, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } } },
      larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
      workerGeneration: 1, workerPort: 0, workerToken: 'token',
      spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: wake,
    } as unknown as DaemonSession;

    // forkWorker's contract bootstrap for the message that starts the worker.
    const controller = controllerForSession(ds, true)!;
    closeContract = () => controller.store.close();
    if (wake) {
      const suspend = controller.beginControl('suspend').operation.operationId;
      controller.controlStarted(suspend); controller.controlResult(suspend, 'confirmed');
    }
    const restartAttemptId = controller.prepareWorkerStart();
    const sessionContract = controller.bindWorker(1);
    const init = {
      type: 'init' as const, sessionId: h.sessionId, cliId: 'claude-code', backendType: 'tmux' as const,
      ...(wake ? { resume: true, restartAttemptId } : {}),
      prompt: text, turnId, trustedCaller: caller, sessionContract,
      sessionCommand: { version: 2 as const, execution: controller.admitInput(turnId) },
    };
    ds.initConfig = init as any;
    const g = h.startWorker(init as any);
    (ds as any).worker = g.child;
    workerPool.__testOnly_setupWorkerHandlers(ds, g.child as any, undefined, 1);

    const replied = () => sessionReply.mock.calls.some(args => String(args[1]).includes(`reply: ${text}`));
    await g.waitFor(replied, 'the reply to the opening turn', 120_000);
    // The worker did report — the question is only whether it arrived.
    expect(g.messages.filter(message => message.type === 'session_identity_decision')).toHaveLength(1);
    expect(dropped).toEqual([]);
    expect(decisions).toEqual([expect.objectContaining({ model: 'proven', turnId })]);
    expect(ds.reportedIdentityModel?.model).toBe('proven');
    expect(workerPool.identityModelRefusalReason(ds)).toBeUndefined();
  }, 180_000);
});
