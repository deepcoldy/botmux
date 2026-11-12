// Shared real-Worker/PTY fixture for the TraeX auto-model integration suites,
// kept in one place so each suite stays well inside the bun leg's per-file wall.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach } from 'vitest';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../../src/types.js';
import { resolveCodexRpcInput } from '../../src/services/codex-rpc-input-policy.js';
import { killWorkerTmuxSession } from './worker-tmux-session.js';
import { readJsonLines } from './read-json-lines.js';
import { t } from '../../src/i18n/index.js';
import { lookupCliDisplayName } from '../../src/adapters/cli/display-names.js';
import { traexAutoModelPolicyKey } from '../../src/services/traex-auto-model.js';
import { restartInterruptionNote, restartInterruptionNotice } from '../../src/services/restart-interruption.js';
import { SessionController } from '../../src/core/session-controller.js';
import { SessionContractStore } from '../../src/services/session-contract-store.js';
import { sameWorker } from '../../src/services/session-contract.js';
import { loadWorkerPoolClosure } from './worker-pool-function-harness.js';
import type { DaemonSession } from '../../src/core/types.js';
import { messages as zhMessages } from '../../src/i18n/zh.js';
const interruptedTurn = { turnOpen: true, tasks: [] };
export const interruptionNote = () => restartInterruptionNote(interruptedTurn);
export const interruptionNotices = (messages: WorkerToDaemon[]) => messages.filter(message =>
  message.type === 'user_notify' && [true, false].some(noteDelivered =>
    message.message === restartInterruptionNotice(interruptedTurn, {
      cliName: lookupCliDisplayName('traex') ?? 'CLI', noteDelivered,
    })));

// Structural match for the capacity-switch notice, not a hard-coded copy line:
// take the longest placeholder-free literal of the SAME zh template the worker
// renders (the test worker runs with the default zh locale). A copy edit in
// zh.ts then moves this fragment, the assertion and the worker-side delay hook
// together, so the hook can never silently stop matching.
export const modelOrderNoticeFragment = zhMessages['worker.traex_auto_model.available_model']
  .split(/\{[^}]*\}/).map(part => part.trim()).filter(part => part.length >= 4)
  .sort((a, b) => b.length - a.length)[0];
// Fail at module load with an actionable message if the template is ever edited
// down to placeholders only: otherwise the value would silently be undefined,
// the worker delay hook would never match, and the regression would only show
// up as a confusing notice-count timeout deep inside the test.
if (!modelOrderNoticeFragment) {
  throw new Error('worker.traex_auto_model.available_model has no >=4-char literal fragment to match');
}

export const children: ChildProcess[] = [];
const roots: string[] = [];
const panes: string[] = [];
export const contractHandles: SessionContractStore[] = [];
export const contractEvents: Promise<unknown>[] = [];
/** Each suite registers the shared worker/pane/contract cleanup once. */
export function useTraexAutoModelIntegrationCleanup(): void {
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolveExit => child.once('exit', resolveExit));
        child.kill('SIGKILL');
        await Promise.race([stopped, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
      }
    }
    for (const pane of panes.splice(0)) {
      killWorkerTmuxSession(`=${pane}`);
    }
    await Promise.all(contractEvents.splice(0));
    for (const store of contractHandles.splice(0)) store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
}

export function rows(path: string): any[] {
  return readJsonLines(path);
}

export async function fixture(enabled: boolean, loadData: false | 'busy' | 'ordered' = false, reselectPerTurn = false,
  rpcPolicy?: { override?: boolean; global: boolean }, restoreWithoutBanner = false, startupExtraArgs?: string,
  freshStart = false, activityMode?: 'working' | 'queue-after-second' | 'delayed-first-queue', terminalDelayMs = 0,
  delaySecondModelOrderNoticeMs = 0, exitFirstReplacement = false, holdPreferredSuccessor = false,
  quota?: { code: string; message?: string; trigger?: 'quota' | 'capacity'; queueModels?: string[];
    modelErrors?: Record<string, { codex_error_info: string; message?: string }>;
    exhaustLast?: boolean; initial?: boolean; blocked?: boolean },
  delayedHistoryReceipt?: { submission: number; ms: number },
  preflight?: { enabled: boolean; initialPrompt?: string; dispatchAttempt?: number;
    probe?: 'success' | 'timeout' | 'failure'; timeoutMs?: number },
  restoreInterruptedStructuredTurn = false, restoreExhaustedOnLast = false, withContract = false,
  resumeRolloutDelayMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-auto-model-'));
  roots.push(root);
  const dataDir = join(root, 'session');
  const traeHome = join(root, '.trae');
  const cliDir = join(traeHome, 'cli');
  const nativeId = '00000000-0000-7000-8000-000000000555';
  const rollouts = join(cliDir, 'sessions', '2026', '10', '21');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(rollouts, { recursive: true });
  const rolloutPath = join(rollouts, `rollout-2026-10-21T00-00-00-${nativeId}.jsonl`);
  const historyPath = join(cliDir, 'history.jsonl');
  const submissions = join(root, 'submissions.jsonl');
  const launches = join(root, 'launches.jsonl');
  const rpcRequests = join(root, 'catalog-requests.jsonl');
  const release = join(root, 'release');
  const crash = join(root, 'crash');
  const replacementExit = join(root, 'replacement-exit');
  if (exitFirstReplacement) writeFileSync(replacementExit, '1');
  writeFileSync(rolloutPath, '');
  writeFileSync(historyPath, '');
  const fake = join(root, 'fake-traex');
  writeFileSync(fake, `#!${nodeTsRunnerPrefix().command}
const fs = require('node:fs');
if (process.argv[2] === 'debug') {
  fs.appendFileSync(${JSON.stringify(rpcRequests)}, JSON.stringify({ method: 'debug/models' }) + '\\n');
  process.stdout.write(JSON.stringify({ models: [] })); process.exit(0);
}
if (process.argv[2] === 'app-server') {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      fs.appendFileSync(${JSON.stringify(rpcRequests)}, JSON.stringify({ method: request.method }) + '\\n');
      if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
      if (request.method === 'model/list' && ${JSON.stringify(preflight?.probe)} === 'timeout') continue;
      if (request.method === 'model/list' && ${JSON.stringify(preflight?.probe)} === 'failure') process.exit(1);
      if (request.method === 'model/list') process.stdout.write(JSON.stringify({ id: request.id, result: {
        data: ${JSON.stringify(loadData ? [
          { id: 'core', businessMetadata: { load: { load_percent: 180 } }, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }] },
          { id: 'backup', businessMetadata: { load: { load_percent: loadData === 'ordered' ? 100 : 160 } }, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
          { id: 'last', businessMetadata: { load: { load_percent: loadData === 'ordered' ? 50 : 120 } }, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }] },
          { id: 'outside', businessMetadata: { load: { load_percent: 0 } } },
        ] : [])}, nextCursor: null } }) + '\\n');
    }
  });
} else {
const model = process.argv[process.argv.indexOf('--model') + 1];
const nativeId = ${JSON.stringify(nativeId)};
const release = ${JSON.stringify(release)};
const rollout = ${JSON.stringify(rolloutPath)};
// Fresh-session discovery follows the native CLI's open rollout descriptor.
// Real TraeX 0.214 opens a resumed rollout up to about a second after it
// starts; a delay models that window without changing other fixtures.
let rolloutFd = process.argv.includes('resume') && ${JSON.stringify(resumeRolloutDelayMs)} > 0 ? undefined : fs.openSync(rollout, 'a');
if (rolloutFd === undefined) setTimeout(() => { rolloutFd ??= fs.openSync(rollout, 'a'); }, ${JSON.stringify(resumeRolloutDelayMs)});
const rolloutWriter = () => rolloutFd ??= fs.openSync(rollout, 'a');
if (!process.argv.includes('resume')) fs.writeSync(rolloutFd, JSON.stringify({
  type: 'session_meta', payload: { id: nativeId, cwd: process.cwd() },
}) + '\\n');
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ model, args: process.argv.slice(2) }) + '\\n');
const exitBeforePrompt = model !== 'core' && fs.existsSync(${JSON.stringify(replacementExit)});
if (exitBeforePrompt) {
  fs.unlinkSync(${JSON.stringify(replacementExit)});
  // Let persistent backends establish their pane/pipe before the process
  // exits, while still preceding the worker's first-prompt readiness edge.
  setTimeout(() => process.exit(1), 1_000);
}
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
let input = '', pasted = '', submitted = false, completed = false, submissionCount = 0;
let turnId;
const startedAt = Date.now();
function line(payload) { fs.writeSync(rolloutWriter(), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\\n'); }
function idle() {
  if (exitBeforePrompt) {
    process.stdout.write('\\x1b[2J\\x1b[H│ model: loading /model to change │\\n❯ Ask anything\\n');
    return;
  }
  if (${JSON.stringify(restoreWithoutBanner)} && model !== 'core') {
    if (Date.now() - startedAt < 400) {
      process.stdout.write('\\x1b[2J\\x1b[H│ model: loading /model to change │\\n│ directory: ${dataDir} │\\n❯ Explain this codebase\\n');
    } else {
      process.stdout.write('\\x1b[2J\\x1b[H■ Conversation interrupted - use /feedback if something went wrong\\n⚠ This session was recorded with model core but is resuming with backup. Consider switching back as it may affect TRAE CLI performance.\\n──────── Configure botmux environment ─\\n❯ Explain this codebase\\n───────────────────────────────────────\\n  ' + model + ' xhigh · ~ · Context 89% left\\n  ☢ Full Access · ? for shortcuts\\n');
    }
    return;
  }
  process.stdout.write('\\x1b[2J\\x1b[H╭──────────────────────────────────────────╮\\n│ model: ' + model + ' /model to change │\\n│ directory: ${dataDir} │\\n╰──────────────────────────────────────────╯\\n❯ Ask TraeCode CLI to do anything\\nContext 99% left\\n');
}
function queued() {
  const rank = model === 'core' ? 1590 : model === 'backup' ? 1000 : 10;
  process.stdout.write('\\x1b[2J\\x1b[H◆ Queued for capacity (20s • esc to interrupt)\\n  └ Too many requests right now. You\\'re in the queue at position ' + rank + '.\\nContext 99% left\\n');
}
idle();
for (const delay of [200, 500, 1000]) setTimeout(() => { if (!submitted) idle(); }, delay);
process.stdin.on('data', chunk => {
  input += chunk;
  const start = input.indexOf('\\x1b[200~');
  const end = input.indexOf('\\x1b[201~', start + 6);
  if (start >= 0 && end >= 0) { pasted = input.slice(start + 6, end); input = input.slice(end + 6); }
  if (pasted && /[\\r\\n]/.test(input)) {
    const text = pasted; pasted = ''; input = ''; submitted = true; completed = false;
    turnId = require('node:crypto').randomUUID();
    fs.appendFileSync(${JSON.stringify(submissions)}, JSON.stringify({ model, text }) + '\\n');
    // delayedHistoryReceipt: the Nth submit's history receipt lands after
    // writeInput's (time-scaled) in-band confirmation budget — the
    // loaded-runner timing that leaves that submit unconfirmed.
    const appendHistory = () => fs.appendFileSync(${JSON.stringify(historyPath)}, JSON.stringify({ session_id: nativeId, ts: Date.now() / 1000, text }) + '\\n');
    if (submissionCount + 1 === ${delayedHistoryReceipt?.submission ?? 0}) setTimeout(appendHistory, ${delayedHistoryReceipt?.ms ?? 0});
    else appendHistory();
    line({ type: 'task_started', turn_id: turnId });
    line({ type: 'user_message', message: text, images: [], local_images: [], text_elements: [], turn_id: turnId });
    // Real interrupted work leaves model/tool history beyond the user receipt.
    // This also exercises the restart scan after that receipt was already read.
    fs.writeSync(rolloutWriter(), JSON.stringify({ timestamp: new Date().toISOString(), type: 'history_mutation',
      payload: { version: 1, commit_id: turnId, turn_id: turnId, operation: 'append',
        items: [{ type: 'function_call', name: 'read_file', call_id: turnId, arguments: '{"path":"src/a.ts"}' }] },
    }) + '\\n');
    submissionCount++;
    // The preferred-model successor starts on core only AFTER the pool walk
    // already reached 'last' (a prior launch row exists). Its turn is open
    // work — the release file was removed by the last model — not a capacity
    // queue. Painting Queued here would start a second pool walk for the
    // successor turn and race the later crash (observed under the tmux
    // backend, whose slower restart window let the walk fire first).
    const successorAfterReset = ${JSON.stringify(holdPreferredSuccessor)} && model === 'core'
      && fs.existsSync(${JSON.stringify(launches)})
      && fs.readFileSync(${JSON.stringify(launches)}, 'utf8').includes('"model":"last"');
    if (${JSON.stringify(!!quota)}) {
      if (${JSON.stringify(quota?.queueModels ?? [])}.includes(model)) { queued(); return; }
      process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (2s • esc to interrupt)\\nContext 99% left\\n');
      setTimeout(() => {
        completed = true;
        const failed = model !== 'last' || ${JSON.stringify(quota?.exhaustLast === true)};
        const error = ${JSON.stringify(quota?.modelErrors ?? {})}[model]
          ?? { codex_error_info: ${JSON.stringify(quota?.code ?? '')}, message: ${JSON.stringify(quota?.message)} };
        line({ type: 'task_complete', turn_id: turnId, last_agent_message: failed ? '' : 'done',
          ...(failed ? { error } : {}) });
        idle();
      }, 1200);
    } else if (successorAfterReset || (${JSON.stringify(withContract)} && model !== 'core')) {
      process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (2s • esc to interrupt)\\nContext 99% left\\n');
    } else if (${JSON.stringify(activityMode === 'delayed-first-queue')} && model === 'core') {
      // Native submission is acknowledged before its first activity repaint.
      // Keep the previous composer visible while follow-up IPC is received.
      idle();
      setTimeout(queued, 1_500);
    } else if (${JSON.stringify(activityMode !== undefined)} && (${JSON.stringify(activityMode === 'working' || activityMode === 'delayed-first-queue')} || submissionCount === 1)) {
      process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (2s • esc to interrupt)\\nContext 99% left\\n');
    } else queued();
  }
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(crash)})) { fs.unlinkSync(${JSON.stringify(crash)}); process.exit(1); }
  if (submitted && !completed && fs.existsSync(release)) {
    completed = true;
    // Keep the preferred successor open so its later crash exercises the
    // ordinary interruption scan after a resumeCurrentTurn=false reset.
    if (${JSON.stringify(holdPreferredSuccessor)} && model === 'last') fs.unlinkSync(release);
    const complete = () => line({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done', duration_ms: 1000 });
    // terminalDelayMs paints the composer BEFORE the authoritative terminal:
    // the exact window where a capacity-held follow-up must not be type-ahead
    // written into the still-running degraded pane.
    if (${terminalDelayMs} > 0) { idle(); setTimeout(complete, ${terminalDelayMs}); }
    else { complete(); idle(); }
  }
}, 100);
}
`);
  chmodSync(fake, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sessionId = randomUUID();
  if (restoreInterruptedStructuredTurn) {
    const markTimeMs = Date.now() - 1_000;
    const timestamp = new Date(markTimeMs).toISOString();
    const interruptedPrompt = 'interrupted cold resume ask';
    writeFileSync(rolloutPath, [
      { type: 'session_meta', payload: { id: nativeId, cwd: dataDir } },
      { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'native_interrupted' } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: interruptedPrompt, turn_id: 'native_interrupted' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const marksDir = join(dataDir, 'turn-marks');
    mkdirSync(marksDir, { recursive: true });
    writeFileSync(join(marksDir, `${sessionId}.json.structured`), `${JSON.stringify({
      version: 1,
      pending: [{
        turnId: 'om_interrupted',
        markTimeMs,
        fingerprint: interruptedPrompt,
        jsonlPath: rolloutPath,
        offsetAtMark: 0,
      }],
    })}\n`);
  }
  const binary = process.env.BOTMUX_TEST_WORKER_BINARY;
  const backendType = withContract || binary || process.env.BOTMUX_TEST_WORKER_BACKEND === 'tmux' ? 'tmux' : 'pty';
  if (backendType === 'tmux') panes.push(`bmx-${sessionId.slice(0, 8)}`);
  const options = {
    cwd: resolve('.'),
    env: { ...process.env, HOME: root, TRAE_HOME: traeHome, BOTMUX_TIME_SCALE: '0.01',
      CLI_EXTRA_ARGS: startupExtraArgs ?? '', SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as any,
  };
  let entry = resolve('src/worker.ts');
  if (!binary && (activityMode || delaySecondModelOrderNoticeMs > 0)) {
    // Test-only worker bootstrap, generated into the fixture's cleaned root.
    // - activityMode: heartbeats + capture timing for admission measurements;
    // - delaySecondModelOrderNoticeMs: delay the worker-side send of the 2nd
    //   capacity-switch notice, reproducing IPC/backpressure delivery lag. The
    //   notice rides the worker IPC channel while the relaunched CLI's
    //   submission rides the PTY channel; the notice leads the 3rd submission
    //   by only a few seconds locally, so 4s reliably inverts their arrival.
    const tmuxImport = JSON.stringify(pathToFileURL(resolve('src/adapters/backend/tmux-pipe-backend.ts')).href);
    const workerImport = JSON.stringify(pathToFileURL(resolve('src/worker.ts')).href);
    const heartbeatProbe = activityMode ? `
let previous = performance.now();
setInterval(() => {
  const now = performance.now();
  if (process.connected) process.send?.({ type: 'admission_heartbeat', atMs: Date.now(), gapMs: now - previous });
  previous = now;
}, 5).unref();
const { TmuxPipeBackend } = await import(${tmuxImport});
const capture = TmuxPipeBackend.prototype.captureViewportAsync;
TmuxPipeBackend.prototype.captureViewportAsync = async function () {
  const started = performance.now();
  try { return await capture.call(this); }
  finally { if (process.connected) process.send?.({ type: 'admission_capture', elapsedMs: performance.now() - started }); }
};
` : '';
    const delayedNoticeSend = delaySecondModelOrderNoticeMs > 0 ? `
const __modelOrderNoticeFragment = ${JSON.stringify(modelOrderNoticeFragment)};
let __modelOrderNotices = 0;
const __realSend = process.send?.bind(process);
if (__realSend) process.send = function (msg: any, callback?: any): boolean {
  if (msg && msg.type === 'user_notify' && typeof msg.message === 'string'
    && msg.message.includes(__modelOrderNoticeFragment)) {
    __modelOrderNotices++;
    if (__modelOrderNotices === 2) {
      setTimeout(() => __realSend(msg, callback), ${delaySecondModelOrderNoticeMs});
      return true;
    }
  }
  return __realSend(msg, callback) as boolean;
} as typeof process.send;
` : '';
    entry = join(root, activityMode ? 'observed-worker.mts' : 'delayed-notice-worker.mts');
    writeFileSync(entry, `${delayedNoticeSend}${heartbeatProbe}await import(${workerImport});
`);
  }
  const child = binary ? spawn(binary, ['__worker'], options) : spawnNodeTsScript(entry, [], options);
  children.push(child);
  const measurements: any[] = [];
  const hostErrors: unknown[] = [];
  const terminalDeliveries: WorkerToDaemon[] = [];
  const noticeDeliveries: WorkerToDaemon[] = [];
  const ds = { larkAppId: 'app_test', chatId: 'oc_test', worker: child, workerGeneration: 1,
    session: { sessionId, larkAppId: 'app_test', status: 'active' }, cliReadyGeneration: 0 } as unknown as DaemonSession;
  const store = withContract ? new SessionContractStore(dataDir, 'app_test') : undefined;
  if (store) contractHandles.push(store);
  const controller = store ? new SessionController(ds, store) : undefined;
  const bootstrap = controller?.bindWorker(1);
  const host = controller && bootstrap ? loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', {
    sessionController: controller, contractWorker: bootstrap.worker, ds, worker: child, sameWorker,
    logger: { warn: (line: string) => logs.push(`HOST ${line}\n`), debug: () => {}, error: () => {} }, t,
    cb: { onTurnTerminal: async (_session: unknown, message: WorkerToDaemon) => { terminalDeliveries.push(message); } },
    enqueueContinuationFailureNotice: (_session: unknown, failure: import('../../src/services/session-contract.js').RuntimeExecutionContinuationFailure) => {
      if (failure.notice) noticeDeliveries.push({ type: 'user_notify', message: failure.notice, turnId: failure.continuation.execution.turnId });
    },
    handleLegacyWorkerMessage: async (message: WorkerToDaemon) => {
      if (message.type === 'turn_terminal') terminalDeliveries.push(message);
      if (message.type === 'user_notify') noticeDeliveries.push(message);
    },
  }) : undefined;
  child.on('message', (raw: any) => {
    if (raw.type === 'admission_heartbeat' || raw.type === 'admission_capture') measurements.push(raw);
    else messages.push(raw as WorkerToDaemon);
    if (host) contractEvents.push(host(raw).catch(error => { hostErrors.push(error); }));
  });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  async function wait(predicate: () => boolean, description: string, timeout = 35_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${description}\n${logs.join('')}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const state = {
      executions: controller?.store.executions(controller.ref).map(execution => ({
        turnId: execution.ref.turnId, phase: execution.phase, runtime: execution.runtime,
      })),
      recent: messages.filter(message => ['turn_terminal', 'cli_input_backlog', 'turn_input_rejected', 'runtime_binding', 'prompt_ready'].includes(message.type)).slice(-12),
      hostErrors: hostErrors.map(String),
      submissions: rows(submissions),
    };
    throw new Error(`timeout: ${description}\n${JSON.stringify(state)}\n${logs.join('')}`);
  }
  const init = { type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'traex', cliPathOverride: fake, cliSessionId: freshStart ? undefined : nativeId,
    resume: !freshStart, model: 'core', backendType,
    prompt: preflight?.initialPrompt ?? (quota?.initial ? 'initial quota task' : ''),
    ...((preflight?.initialPrompt || quota?.initial) ? { turnId: preflight?.initialPrompt ? 'om_initial_preflight' : 'om_initial_quota' } : {}),
    ...(preflight?.initialPrompt && preflight.dispatchAttempt !== undefined
      ? { dispatchAttempt: preflight.dispatchAttempt } : {}),
    ...(quota?.blocked ? { traexAutoModelRuntime: {
      model: 'last', nativeSessionId: nativeId, waitingOnFinalModel: false,
      policyKey: traexAutoModelPolicyKey({ enabled: true, trigger: 'quota', models: ['core', 'backup', 'last'],
        queueTimeoutMs: 5000, switchCooldownMs: 5000 }),
      quotaBlocks: ['core', 'backup', 'last'].map(model => ({ model })),
    } } : {}),
    ...(restoreExhaustedOnLast ? { traexAutoModelRuntime: {
      model: 'last', nativeSessionId: nativeId, waitingOnFinalModel: true,
      policyKey: traexAutoModelPolicyKey({ enabled: true, models: ['core', 'backup', 'last'],
        queueTimeoutMs: 5000, switchCooldownMs: 5000, reselectPerTurn }),
    } } : {}),
    ...(rpcPolicy ? { codexRpcInput: resolveCodexRpcInput('traex', rpcPolicy.override, rpcPolicy.global) } : {}),
    ...(enabled ? { traexAutoModel: { enabled: true, models: ['core', 'backup', 'last'], queueTimeoutMs: 5_000, switchCooldownMs: 5_000,
      ...(quota ? { trigger: quota.trigger ?? 'quota' } : {}),
      ...(preflight?.enabled ? {
        preflightLoadCheck: true,
        overloadThresholdPercent: 100,
        preflightTimeoutMs: preflight.timeoutMs ?? 1_000,
        unknownLoadPolicy: 'skip' as const,
        allOverloadedPolicy: 'lowest_load' as const,
      } : {}),
      reselectPerTurn,
      ...(loadData ? { modelSettings: {
        core: { reasoningEffort: 'high', modelBackendVariant: 'standard' },
        backup: { reasoningEffort: 'xhigh', modelBackendVariant: 'standard' },
        last: { reasoningEffort: 'xhigh', modelBackendVariant: 'max' },
      } } : {}),
    } } : {}),
    ...(bootstrap ? { sessionContract: bootstrap } : {}),
    larkAppId: 'app_test', larkAppSecret: 'secret' } satisfies DaemonToWorker;
  ds.initConfig = init;
  child.send(init);
  if (startupExtraArgs) await wait(() => messages.some(message => message.type === 'error' && message.message.includes('cannot be overridden')), 'rejected external model argv');
  else await wait(() => messages.some(message => message.type === 'prompt_ready'), 'startup prompt');
  const sendInput = (content: string, turnId: string): void => {
    const execution = controller?.admitInput(turnId);
    const message = { type: 'message' as const, content, turnId,
      trustedCaller: { requestLarkAppId: 'app_test', requestUserOpenId: 'ou_test', senderType: 'user' as const },
      ...(controller ? { sessionCommand: controller.command({ type: 'message', turnId,
        sessionCommand: { version: 2, execution } }) } : {}) };
    child.send(message);
  };
  return { child, messages, wait, submissions, launches, release, nativeId, logs, rpcRequests, init, measurements, crash, fake,
    sendInput, controller, hostErrors, terminalDeliveries, noticeDeliveries, options, entry, ds };
}
