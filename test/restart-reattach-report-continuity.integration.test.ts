/**
 * End-to-end verification with a real worker subprocess, a real isolated tmux
 * server, and the real daemon worker-pool + SQLite session contract:
 *
 * Reproduces the exact production failure mode of a persistent Codex tmux
 * session replaced mid-turn while holding both its top-level rollout fd and
 * internal subagent rollout fds open:
 *   1. Replacement worker resolves the sole top-level conversation id from the
 *      surviving Codex leaf's open rollout fds (ignoring `subagent` helper
 *      rollouts), allowing `SessionContractStore.bindRuntime` to reuse the
 *      live turn's runtime epoch instead of stranding the turn on an
 *      `'unresolved'` epoch;
 *   2. Once `runtime_contract_assigned` delivers the active execution reference
 *      (even when `restoreReattachedPaneTurnIdentity` ran earlier before the
 *      assignment arrived), the replacement worker re-publishes
 *      `managed_turn_origin` so `botmux report --status completed` passes
 *      `authorizeReportSessionRelayRequest` without `turn_provenance_stale`;
 *   3. When the surviving Codex finishes the turn without an explicit chat send,
 *      zero-injection (`promptInjection: 'none'`) `final_output` is admitted
 *      and delivered both to `sessionReply` and `onZeroPromptFinal`.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
}));

import { preferredManagedTmuxSocket } from '../src/adapters/backend/tmux-socket.js';
import * as bots from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  createDispatchReportBinding,
  loadOrCreateDispatchReportBindingSecret,
} from '../src/core/dispatch-report-binding.js';
import {
  authorizeReportSessionRelayRequest,
  prepareAutomaticDispatchReport,
} from '../src/core/report-session-relay.js';
import { controllerForSession } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killProcessTree } from './helpers/process-tree.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const runnable = process.platform === 'linux' && probeTmuxFunctional().ok;

const APP = 'cli_reattach_exec';
const COORDINATOR_APP = 'cli_reattach_lead';
const DISPATCH_ROOT = 'om_dispatch_reattach_root';
const TURN = 'om_reattach_report_turn';
const TEXT = 'subtask across codex worker replacement';
const OWN_SID = '01a17c40-ce9a-7681-bcf0-91913289bf82';
const SUB_SID_1 = '01a18b8f-48ac-7000-8000-111111111111';
const SUB_SID_2 = '01a18b8f-9447-7000-8000-222222222222';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

const cleanups: Array<() => Promise<void> | void> = [];
let previousDataDir: string | undefined;
let closeContract: (() => void) | undefined;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  closeContract?.();
  closeContract = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  vi.restoreAllMocks();
});

describe.skipIf(!runnable)('mid-turn Codex worker replacement preserves report authority and zero-prompt final relay', () => {
  it('reuses the live Codex runtime despite open subagent rollouts, restores managedTurnOrigin, and relays zero-prompt final output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bmx-codex-reattach-report-'));
    const workingDir = join(root, 'work');
    const codexHome = join(root, '.codex');
    const dataDir = join(root, 'data');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const cliPidFile = join(root, 'cli-pid');
    const submittedFile = join(root, 'submitted');
    const finishGateFile = join(root, 'finish-gate');
    const finishedFile = join(root, 'finished');
    const sessionId = randomUUID();

    const rolloutDir = join(codexHome, 'sessions', '2026', '10', '27');
    mkdirSync(rolloutDir, { recursive: true });
    const ownRollout = join(rolloutDir, `rollout-2026-10-27T15-26-24-${OWN_SID}.jsonl`);
    const subRollout1 = join(rolloutDir, `rollout-2026-11-12T16-40-00-${SUB_SID_1}.jsonl`);
    const subRollout2 = join(rolloutDir, `rollout-2026-11-12T16-41-00-${SUB_SID_2}.jsonl`);

    const seedTs = (offsetMs: number) => new Date(Date.now() - 3_600_000 + offsetMs).toISOString();
    writeFileSync(
      ownRollout,
      [
        { timestamp: seedTs(0), type: 'session_meta', payload: { id: OWN_SID, cwd: workingDir, thread_source: 'user' } },
        {
          timestamp: seedTs(500),
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'seed prompt' }] },
        },
        {
          timestamp: seedTs(1_000),
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: `seed-${OWN_SID}`, last_agent_message: 'seed reply' },
        },
      ].map(row => `${JSON.stringify(row)}\n`).join(''),
    );
    writeFileSync(
      subRollout1,
      `${JSON.stringify({
        timestamp: seedTs(2_000),
        type: 'session_meta',
        payload: { id: SUB_SID_1, cwd: workingDir, thread_source: 'subagent', parent_thread_id: OWN_SID, source: { subagent: 'review' } },
      })}\n`,
    );
    writeFileSync(
      subRollout2,
      `${JSON.stringify({
        timestamp: seedTs(2_100),
        type: 'session_meta',
        payload: {
          id: SUB_SID_2,
          cwd: workingDir,
          thread_source: 'subagent',
          parent_thread_id: OWN_SID,
          source: { subagent: { thread_spawn: { parent_thread_id: OWN_SID } } },
        },
      })}\n`,
    );

    const fakeCodex = join(root, 'fake-codex');
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.146.0');
  process.exit(0);
}
process.title = 'codex';
try { fs.writeFileSync('/proc/self/comm', 'codex'); } catch {}
const codexHome = process.env.CODEX_HOME || ${JSON.stringify(codexHome)};
const historyPath = path.join(codexHome, 'history.jsonl');
const ownFd = fs.openSync(${JSON.stringify(ownRollout)}, 'a+');
const subFd1 = fs.openSync(${JSON.stringify(subRollout1)}, 'r');
const subFd2 = fs.openSync(${JSON.stringify(subRollout2)}, 'r');
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));

const event = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n';
const renderIdle = () => {
  process.stdout.write('\\x1b[2J\\x1b[H│ model: custom-model /model to change │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n custom-model · /tmp\\x1b[3;3H');
};

let input = '';
let turnRunning = false;
if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.on('data', chunk => { input += chunk.toString(); });

setInterval(() => {
  if (turnRunning) return;
  const bracketed = input.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~(?:\\r|\\n)?/);
  const plain = !bracketed ? input.match(/^([^\\r\\n]+)[\\r\\n]+/) : null;
  const match = bracketed || plain;
  if (!match) return;
  const submittedText = match[1].trim();
  input = input.slice(input.indexOf(match[0]) + match[0].length);
  if (!submittedText) return;
  turnRunning = true;
  const nativeTurnId = 'native-' + Date.now();
  fs.appendFileSync(historyPath, JSON.stringify({ session_id: ${JSON.stringify(OWN_SID)}, text: submittedText, ts: Date.now() / 1000 }) + '\\n');
  fs.writeSync(
    ownFd,
    event('event_msg', { type: 'task_started', turn_id: nativeTurnId })
      + event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: submittedText }] }),
  );
  process.stdout.write('\\x1b[2J\\x1b[H• Working (esc to interrupt)\\r\\n');
  fs.writeFileSync(${JSON.stringify(submittedFile)}, submittedText);

  const waitFinish = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(finishGateFile)})) return;
    clearInterval(waitFinish);
    const reply = 'reply: ' + submittedText;
    fs.writeSync(
      ownFd,
      event('event_msg', { type: 'task_complete', turn_id: nativeTurnId, last_agent_message: reply }),
    );
    fs.writeFileSync(${JSON.stringify(finishedFile)}, reply);
    turnRunning = false;
    renderIdle();
  }, 40);
}, 30);

process.stdout.write('\\x1b[?2004h');
setTimeout(renderIdle, 80);
setInterval(() => { void subFd1; void subFd2; }, 1000);
`,
    );
    chmodSync(fakeCodex, 0o755);

    cleanups.push(async () => {
      if (existsSync(cliPidFile)) {
        try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
      }
      for (const name of new Set(['default', preferredManagedTmuxSocket() ?? 'default'])) {
        const socket = join(root, `tmux-${process.getuid?.() ?? 0}`, name);
        try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* gone */ }
      }
      rmSync(root, { recursive: true, force: true });
    });

    previousDataDir = config.session.dataDir;
    config.session.dataDir = dataDir;

    const bindingSecret = loadOrCreateDispatchReportBindingSecret(config.session.dataDir, { coreOnly: true });
    const reportBinding = createDispatchReportBinding(bindingSecret, {
      dispatchRoot: DISPATCH_ROOT,
      targetLarkAppId: COORDINATOR_APP,
      targetSessionId: 'session-lead-1',
      targetChatId: 'oc_project_test',
      targetScope: 'chat',
      sourceName: 'executor-bot',
      issuedAt: new Date().toISOString(),
    });
    const registry = { [DISPATCH_ROOT]: { reportBinding } };
    writeFileSync(join(config.session.dataDir, 'orchestrate-dispatch.json'), JSON.stringify(registry));

    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
    vi.spyOn(bots, 'getBot').mockReturnValue({
      config: {
        larkAppId: APP,
        larkAppSecret: 'secret',
        cliId: 'codex',
        promptInjection: 'none',
      },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'ExecutorBot',
    } as any);

    const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply_msg');
    const zeroPromptFinals: Array<{ turnId: string; content: string; dispatchRoot?: string }> = [];
    workerPool.initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => workingDir,
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onZeroPromptFinal: async (_ds: DaemonSession, input: { turnId: string; content: string; dispatchRoot?: string }) => {
        zeroPromptFinals.push(input);
      },
    } as any);

    const buildDaemonSession = (generation: number) =>
      ({
        session: {
          sessionId,
          larkAppId: APP,
          chatId: 'oc_project_test',
          chatType: 'group',
          rootMessageId: DISPATCH_ROOT,
          scope: 'thread',
          promptInjection: 'none',
          status: 'active',
          cliId: 'codex',
          cliSessionId: OWN_SID,
          createdAt: new Date().toISOString(),
          workerGeneration: generation,
          replyTargets: {
            [TURN]: {
              rootMessageId: DISPATCH_ROOT,
              turnId: TURN,
              senderOpenId: caller.requestUserOpenId,
              updatedAt: new Date().toISOString(),
            },
          },
        },
        larkAppId: APP,
        chatId: 'oc_project_test',
        chatType: 'group',
        scope: 'thread',
        workerGeneration: generation,
        workerPort: 0,
        workerToken: 'token',
        spawnedAt: Date.now(),
        cliVersion: '1',
        lastMessageAt: Date.now(),
        hasHistory: true,
      }) as unknown as DaemonSession;

    type StartedGeneration = {
      child: ChildProcess;
      messages: WorkerToDaemon[];
      logs: string[];
      waitFor: (cond: () => boolean, what: string, timeoutMs?: number) => Promise<void>;
    };

    const startWorkerProcess = (init: DaemonToWorker): StartedGeneration => {
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const spawnOptions: SpawnOptions = {
        cwd: resolve('.'),
        env: privateTmuxEnv(root, {
          HOME: root,
          CODEX_HOME: codexHome,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: sessionId,
          LARK_APP_ID: APP,
          LARK_APP_SECRET: 'secret',
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      };
      const child = process.env.BOTMUX_TEST_WORKER_BINARY
        ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
        : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
      child.on('message', m => { messages.push(m as WorkerToDaemon); });
      child.stdout?.on('data', b => logs.push(b.toString()));
      child.stderr?.on('data', b => logs.push(b.toString()));
      cleanups.push(() => killProcessTree(child, 3_000));
      child.send(init);
      return {
        child,
        messages,
        logs,
        waitFor: async (cond, what, timeoutMs = 45_000) => {
          const deadline = Date.now() + timeoutMs;
          while (!cond()) {
            if (Date.now() >= deadline || child.exitCode !== null) {
              throw new Error(
                `timed out waiting for ${what}\n${logs.join('')}\n${JSON.stringify(messages.filter(m => m.type !== 'screen_update'))}`,
              );
            }
            await new Promise(done => setTimeout(done, 50));
          }
        },
      };
    };

    const forkGeneration = (
      ds: DaemonSession,
      generation: number,
      confirmLate?: (g: StartedGeneration) => Promise<void>,
    ) => {
      const controller = controllerForSession(ds, true)!;
      closeContract ??= () => controller.store.close();
      const restartAttemptId = controller.prepareWorkerStart();
      const sessionContract = controller.bindWorker(generation);
      const init: DaemonToWorker = {
        type: 'init',
        sessionId,
        chatId: 'oc_project_test',
        rootMessageId: DISPATCH_ROOT,
        workingDir,
        larkAppId: APP,
        larkAppSecret: 'secret',
        resume: true,
        cliSessionId: OWN_SID,
        cliId: 'codex',
        cliPathOverride: fakeCodex,
        backendType: 'tmux',
        promptInjection: 'none',
        prompt: '',
        restartAttemptId,
        sessionContract,
        finalOutputHandoff: { version: 2, token: randomUUID(), admitNew: false },
      };
      ds.initConfig = init as any;
      const g = startWorkerProcess(init);
      let channel: ChildProcess = g.child;
      if (confirmLate) {
        const held = confirmLate(g);
        const raw = g.child.send.bind(g.child) as (...args: unknown[]) => boolean;
        let send: unknown = (message: { type?: string }, ...rest: unknown[]) => {
          if (message?.type !== 'runtime_contract_assigned') return raw(message, ...rest);
          void held.then(() => {
            if (g.child.connected) raw(message, ...rest);
          });
          return true;
        };
        channel = new Proxy(g.child, {
          get: (target, key) => {
            if (key === 'send') return send;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set: (target, key, value) => {
            if (key === 'send') {
              send = value;
              return true;
            }
            return Reflect.set(target, key, value, target);
          },
        });
      }
      (ds as any).worker = channel;
      workerPool.__testOnly_setupWorkerHandlers(ds, channel as any, undefined, generation);
      return { g, controller, workerRef: sessionContract.worker };
    };

    const ds1 = buildDaemonSession(1);
    const first = forkGeneration(ds1, 1);
    await first.g.waitFor(
      () => first.g.messages.some(m => m.type === 'prompt_ready'),
      'worker 1 prompt_ready',
      60_000,
    );
    expect(workerPool.sendWorkerInput(ds1, TEXT, TURN, { trustedCaller: caller })).toBe(true);
    await first.g.waitFor(() => existsSync(submittedFile), 'turn submitted on worker 1', 60_000);
    await vi.waitFor(() => {
      expect(ds1.managedTurnOrigin?.turnId).toBe(TURN);
      const exec = first.controller.store.executions(first.controller.ref).find(v => v.ref.turnId === TURN);
      expect(exec?.runtime).toBeDefined();
      expect(first.controller.store.runtime(first.controller.ref, exec!.runtime!.runtimeId)?.identity?.nativeSessionId)
        .toBe(OWN_SID);
    }, { timeout: 15_000 });

    const originalEpoch = first.controller.store.executions(first.controller.ref)
      .find(v => v.ref.turnId === TURN)!.runtime!;

    // Simulate daemon restart: SIGTERM worker 1 while the tmux pane and Codex leaf
    // (holding parent + 2 subagent rollout fds) stay alive mid-turn.
    const worker1Exited = new Promise(done => first.g.child.once('exit', done));
    ds1.worker = null;
    first.g.child.kill('SIGTERM');
    await worker1Exited;
    first.controller.workerLost(first.workerRef);
    expect(existsSync(finishedFile)).toBe(false);

    const ds2 = buildDaemonSession(2);
    // Hold `runtime_contract_assigned` until worker 2 finishes `init` (`ready`),
    // reproducing the real restart ordering where `restoreReattachedPaneTurnIdentity`
    // runs before the daemon confirms runtime assignment and active executions.
    const second = forkGeneration(ds2, 2, g =>
      g.waitFor(() => g.messages.some(m => m.type === 'ready'), 'worker 2 ready', 60_000),
    );

    // Worker 2 must reuse the original runtime epoch AND restore `ds2.managedTurnOrigin`!
    await vi.waitFor(() => {
      expect(second.controller.currentRuntime()).toEqual(originalEpoch);
      expect(ds2.managedTurnOrigin?.turnId).toBe(TURN);
      expect(typeof ds2.managedTurnOrigin?.capability).toBe('string');
      expect(ds2.managedTurnOrigin!.capability.length).toBeGreaterThan(0);
    }, { timeout: 15_000 });

    // `botmux report --status completed` must pass `authorizeReportSessionRelayRequest`!
    const reportAuth = authorizeReportSessionRelayRequest({
      raw: {
        sessionId,
        dispatchRoot: DISPATCH_ROOT,
        status: 'completed',
        content: 'Completed report from surviving Codex after worker replacement',
        originCapability: ds2.managedTurnOrigin!.capability,
        originTurnId: TURN,
      },
      trustedHost: true,
      session: {
        sessionId: ds2.session.sessionId,
        larkAppId: ds2.larkAppId,
        chatId: ds2.chatId,
        promptInjection: 'none',
        receiver: false,
        scope: 'thread',
        rootMessageId: DISPATCH_ROOT,
        liveOrigin: ds2.managedTurnOrigin,
        replyTargets: ds2.session.replyTargets,
      },
      selfLarkAppId: APP,
      registry,
      bindingSecret,
    });
    expect(reportAuth).toMatchObject({
      ok: true,
      target: { sessionId: 'session-lead-1', larkAppId: COORDINATOR_APP },
      projectUpdate: { status: 'completed' },
    });

    // Release the surviving Codex turn completion: both topic reply and onZeroPromptFinal must fire!
    mkdirSync(dirname(finishGateFile), { recursive: true });
    writeFileSync(finishGateFile, 'go');
    await second.g.waitFor(
      () => sessionReply.mock.calls.some(args => String(args[1]).includes(`reply: ${TEXT}`)),
      'zero-injection final reply delivered after worker replacement',
      60_000,
    );
    await vi.waitFor(() => {
      expect(zeroPromptFinals.some(item => item.turnId === TURN && item.content.includes(`reply: ${TEXT}`))).toBe(true);
    }, { timeout: 10_000 });

    const autoDecision = prepareAutomaticDispatchReport({
      registry,
      bindingSecret,
      dispatchRoot: zeroPromptFinals[0]!.dispatchRoot,
      sourceSessionId: ds2.session.sessionId,
      sourceLarkAppId: ds2.larkAppId,
      content: zeroPromptFinals[0]!.content,
    });
    expect(autoDecision).toMatchObject({
      ok: true,
      target: { sessionId: 'session-lead-1', larkAppId: COORDINATOR_APP },
    });

    await vi.waitFor(() => {
      const exec = second.controller.store.executions(second.controller.ref).find(v => v.ref.turnId === TURN);
      expect(exec?.phase).toBe('succeeded');
    }, { timeout: 10_000 });
  }, 180_000);
});
