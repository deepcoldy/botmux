import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { extractAntigravityErrorComposerKey } from '../src/adapters/cli/antigravity.js';
import { detectCliUsageLimit } from '../src/utils/cli-usage-limit.js';

const children = new Set<ChildProcess>();
const cliPidFiles = new Set<string>();
const roots = new Set<string>();

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopChildren(): Promise<void> {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      const deadline = setTimeout(() => {
        child.off('exit', onExit);
        reject(new Error(`Worker ${child.pid} did not exit during fixture cleanup`));
      }, 8_000);
      const onExit = () => {
        clearTimeout(forceKill);
        clearTimeout(deadline);
        resolve();
      };
      child.once('exit', onExit);
      // Give the worker a chance to stop its watchers and PTY child. The IPC
      // callback also contains a concurrent disconnect during cleanup.
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }));
  children.clear();
  // A forced worker exit does not prove that its separate PTY child exited.
  // Reap only the fake CLI PIDs this fixture recorded, before deleting their
  // history directory (PR #1616: a pending write raced rmSync with ENOTEMPTY).
  const pids = [...cliPidFiles].filter(existsSync).map(file => Number(readFileSync(file, 'utf8')));
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid fixture CLI PID: ${pid}`);
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  await waitFor(() => pids.every(pid => !processAlive(pid)), ['Waiting for fixture CLI processes to exit'], 5_000);
  cliPidFiles.clear();
}

afterEach(async () => {
  await stopChildren();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitFor(check: () => boolean, logs: string[], timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Worker condition timed out\n${logs.join('')}`);
}

function startWorker(
  mode: 'prompt' | 'delayed' | 'interrupted' | 'manual' | 'native-error' | 'quota' | 'quota-with-footer' | 'expired-quota' | 'running' | 'foreground-tool',
  cliId: 'antigravity' | 'traex' = 'antigravity',
  opts: { ownTranscript?: boolean; followupDelayMs?: number; transcriptLagMs?: number; followupTranscriptLagMs?: number } = {},
) {
  // Closing a worker also stops its OS session scope. A fixed session ID would
  // let parallel runtime/test invocations terminate each other's fake CLI.
  const sessionId = `agy-delivery-${randomUUID()}`;
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-delivery-'));
  roots.add(root);
  const dataDir = join(root, 'session');
  const cliHome = join(root, '.gemini', 'antigravity-cli');
  const nativeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const transcriptDir = join(cliHome, 'brain', nativeId, '.system_generated', 'logs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, 'transcript.jsonl');
  const inputLog = join(root, 'input.log');
  const cliPidFile = join(root, 'fake-cli.pid');
  cliPidFiles.add(cliPidFile);
  const history = cliId === 'antigravity'
    ? join(cliHome, 'history.jsonl') : join(root, '.trae', 'cli', 'history.jsonl');
  mkdirSync(join(history, '..'), { recursive: true });
  const isQuota = mode === 'quota' || mode === 'expired-quota';
  const isQuotaWithFooter = mode === 'quota-with-footer';
  const passive = isQuota || isQuotaWithFooter || ['interrupted', 'native-error', 'running', 'foreground-tool'].includes(mode);
  if (passive) {
    writeFileSync(transcript, JSON.stringify({
      type: mode === 'foreground-tool' ? 'PLANNER_RESPONSE' : 'GENERIC', status: mode === 'running' ? 'RUNNING' : 'DONE', content: 'tool result',
    }) + '\n');
  }
  if (isQuotaWithFooter) {
    const botmuxLogDir = join(cliHome, 'botmux');
    mkdirSync(botmuxLogDir, { recursive: true });
    const nativeLogPath = join(botmuxLogDir, `${encodeURIComponent(sessionId)}.log`);
    writeFileSync(nativeLogPath, [
      'I1125 00:00:01.000000 100 input_loop.go:104] HandleUserInput called with text: "do work"',
      'E1125 00:00:02.123456 200 errorreport.go:282] agent executor error: generating and executing: transport error (ResourceExhausted, HTTP 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.',
    ].join('\n') + '\n');
  }
  const ready = cliId === 'antigravity' ? '? for shortcuts' : '›';
  const screen = mode === 'interrupted'
    ? '  ⎿  Interrupted · What should Antigravity CLI do instead?\n────────\n>\n────────\n? for shortcuts\n'
    : isQuotaWithFooter
      ? '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m35s.\nError ID: agy-1515-footer-fixture\n────────\n>\n────────\n? for shortcuts  accept-edits · Gemini 4 Neon\n'
    : mode === 'native-error' || isQuota
      ? `⚠ ${isQuota ? 'Individual quota reached. Resets in 124h24m15s.' : 'Request failed. Please retry.'}\nError ID: native-error-fixture\n────────\n>\n────────\n`
    : mode === 'running'
      ? '● Bash(sleep 30)\n⣻ Running command...\n────────\n>\n────────\nesc to cancel · 1 task(s)\n'
    : mode === 'foreground-tool'
      ? '────────\n>\n────────\n? for shortcuts\n'
    : ready + '\n';
  const antigravityQuotaHistory = mode === 'expired-quota' ? [screen, screen.replace('native-error-fixture', 'newer-quota-fixture')]
    .map((banner, index) => {
      const state = detectCliUsageLimit(banner, index === 0 ? new Date(0) : new Date());
      if (!state.limited) throw new Error('Expected relative quota');
      const composerKey = extractAntigravityErrorComposerKey(banner);
      return composerKey
        ? { ...state, source: 'antigravity-error-composer' as const, nativeEpisodeKey: composerKey }
        : state;
    }) : undefined;
  const fakeCli = join(root, 'fake-cli');
  const initialScreenGate = passive ? join(root, 'worker-ready') : '';
  writeFileSync(fakeCli, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cliPidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(cliPidFile + '.tmp')}, ${JSON.stringify(cliPidFile)});
const inputLog = ${JSON.stringify(inputLog)};
const history = ${JSON.stringify(history)};
const ready = ${JSON.stringify(ready)};
const screen = ${JSON.stringify(screen)};
const delayed = ${mode === 'delayed'};
const manual = ${mode === 'manual'};
const foregroundTool = ${mode === 'foreground-tool'};
const ownTranscript = ${opts.ownTranscript === true};
const fullTranscript = ${JSON.stringify(join(transcriptDir, 'transcript_full.jsonl'))};
const logFileAt = process.argv.indexOf('--log-file');
const logFile = logFileAt >= 0 ? process.argv[logFileAt + 1] : '';
// Real agy writes its --log-file from startup, then names the conversation it streams.
if (logFile) fs.appendFileSync(logFile, 'I1127 00:00:00.000000 1 main.go:1] starting\\n');
const initialScreenGate = ${JSON.stringify(initialScreenGate)};
process.stdin.setRawMode?.(true);
const drawInitialScreen = () => process.stdout.write('\\x1b[2J\\x1b[H' + screen);
if (initialScreenGate) {
  // The parent opens this gate only after the worker's ready IPC. A one-shot
  // 150ms frame plus one fixed idle wait made a slow worker spend its entire
  // assertion budget during initialization, before idle publication could start.
  const publishWhenReady = () => {
    if (fs.existsSync(initialScreenGate)) drawInitialScreen();
    else setTimeout(publishWhenReady, 25);
  };
  publishWhenReady();
} else {
  setTimeout(drawInitialScreen, 150);
}
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  for (const marker of ['ACTIVATION_UNIQUE_MARKER', 'FOLLOWUP_UNIQUE_MARKER']) {
    if (!text.includes(marker)) continue;
    if (foregroundTool) {
      const steps = [
        { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: marker },
        { type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command' }] },
      ];
      fs.appendFileSync(${JSON.stringify(transcript)}, steps.map(step => JSON.stringify(step)).join('\\n') + '\\n');
      drawInitialScreen();
    }
    if (!manual) setTimeout(() => {
      const row = ${JSON.stringify(cliId)} === 'antigravity'
        ? { display: marker, workspace: ${JSON.stringify(dataDir)}, timestamp: Date.now() }
        : { text: marker, session_id: ${JSON.stringify(nativeId)}, ts: Date.now() };
      fs.appendFileSync(history, JSON.stringify(row) + '\\n');
      // Real agy names the conversation it streams in its own --log-file.
      if (logFile) fs.appendFileSync(logFile, 'I1127 00:00:01.000000 1 x.go:1] Streaming conversation ' + ${JSON.stringify(nativeId)} + '\\n');
      if (ownTranscript) setTimeout(() => {
        // agy feeds the input to its model: this pane's own conversation transcript.
        fs.appendFileSync(fullTranscript, JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE',
          content: '<USER_REQUEST>\\n' + marker + '\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nnow\\n</ADDITIONAL_METADATA>' }) + '\\n');
      }, marker === 'FOLLOWUP_UNIQUE_MARKER' ? ${opts.followupTranscriptLagMs ?? opts.transcriptLagMs ?? 0} : ${opts.transcriptLagMs ?? 0});
    }, marker === 'FOLLOWUP_UNIQUE_MARKER' && ${opts.followupDelayMs ?? -1} >= 0 ? ${opts.followupDelayMs ?? -1} : delayed ? 9_000 : 0);
    if (foregroundTool) continue; // Keep the same composer on screen while the tool runs.
    // Force several idle edges before the delayed receipt appears. Re-enqueueing
    // the activation on a false submit result used to paste the whole input again.
    for (const ms of [1_000, 4_000, 7_000]) {
      setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + ready + '\\n'), ms);
    }
  }
});
setInterval(() => {}, 1_000);
`);
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      TRAE_HOME: join(root, '.trae'),
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_TIME_SCALE: '0.05',
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => {
    const message = raw as WorkerToDaemon;
    messages.push(message);
    if (message.type === 'ready' && initialScreenGate) writeFileSync(initialScreenGate, '');
  });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId, cliPathOverride: fakeCli, backendType: 'pty',
    cliSessionId: nativeId,
    ...(isQuotaWithFooter ? { cliVersion: '1.5.15' } : {}),
    antigravityQuotaHistory,
    prompt: passive ? '' : 'ACTIVATION_UNIQUE_MARKER',
    ...(!passive ? { queuedActivationToken: 'activation-token', turnId: 'om_initial' } : {}),
    larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return {
    child, messages, logs, root, cliPidFile, sessionId, transcript,
    recordReceipt: () => writeFileSync(history, JSON.stringify({
      display: 'ACTIVATION_UNIQUE_MARKER', workspace: dataDir, timestamp: Date.now(),
    }) + '\n'),
    input: () => existsSync(inputLog) ? readFileSync(inputLog, 'utf8') : '',
  };
}

describe('worker delayed activation and interrupted Antigravity delivery', () => {
  it('publishes idle for a resumed native error with a footerless empty composer', async () => {
    const worker = startWorker('native-error');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs, 30_000);
    await waitFor(() => worker.messages.some(m => m.type === 'screen_update' && m.status === 'idle'), worker.logs, 20_000);
    expect(worker.input()).toBe('');
  }, 60_000);

  it('publishes a usage limit for a resumed relative-countdown quota refusal', async () => {
    const worker = startWorker('quota');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs, 30_000);
    await waitFor(() => worker.messages.some(m => m.type === 'screen_update' && m.status === 'limited'
      && m.usageLimit?.kind === 'usage' && m.usageLimit.source === 'antigravity-error-composer'), worker.logs, 20_000);
    expect(worker.input()).toBe('');
  }, 60_000);

  it('does not re-report an older past-reset quota banner on worker reattach', async () => {
    const worker = startWorker('expired-quota');
    const quotaFrame = () => worker.messages.find(m => m.type === 'screen_update'
      && (m.status === 'idle' || m.status === 'limited') && m.content.includes('Individual quota reached'));
    await waitFor(() => quotaFrame() !== undefined, worker.logs, 20_000);
    expect(quotaFrame()).toMatchObject({ status: 'idle' });
    expect(worker.messages.some(m => m.type === 'screen_update' && m.usageLimit)).toBe(false);
  }, 60_000);

  it('keeps an active command working despite its visible empty composer', async () => {
    const worker = startWorker('running');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs, 30_000);
    await waitFor(() => worker.messages.some(m => m.type === 'screen_update' && m.status === 'working'
      && m.content.includes('Running command')), worker.logs, 20_000);
    expect(worker.messages.some(m => m.type === 'prompt_ready')).toBe(false);
    expect(worker.input()).toBe('');
  }, 60_000);

  it('holds a submitted tool call across the post-submit idle probe until the transcript final', async () => {
    const worker = startWorker('foreground-tool');
    await waitFor(() => worker.messages.some(m => m.type === 'screen_update'
      && m.status === 'idle' && m.content.includes('? for shortcuts')), worker.logs, 30_000);
    const start = worker.messages.length;
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER', turnId: 'om_tool' } satisfies DaemonToWorker);
    const frames = () => worker.messages.slice(start);
    await waitFor(() => frames().some(m => m.type === 'turn_input_committed' && m.turnId === 'om_tool'), worker.logs, 15_000);
    // Hold the fake CLI at the type-ahead composer through two 3.5s probe intervals.
    await new Promise(resolve => setTimeout(resolve, 7_500));
    expect(frames().some(m => m.type === 'prompt_ready')).toBe(false);

    appendFileSync(worker.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Finished.' }) + '\n');
    await waitFor(() => frames().some(m => m.type === 'prompt_ready'), worker.logs, 15_000);
  }, 60_000);

  const consumedReceipts = (messages: WorkerToDaemon[]) => messages.filter(m => m.type === 'native_input_consumed');

  it('acknowledges native consumption of the activation and a follow-up once the own transcript records them', async () => {
    const worker = startWorker('prompt', 'antigravity', { ownTranscript: true });
    await waitFor(() => consumedReceipts(worker.messages).some(m => m.type === 'native_input_consumed' && m.turnId === 'om_initial'),
      worker.logs, 30_000);
    expect(consumedReceipts(worker.messages)).toEqual([expect.objectContaining({
      type: 'native_input_consumed', turnId: 'om_initial', proofKind: 'antigravity_transcript_user_input',
      nativeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })]);
    await waitFor(() => worker.messages.some(m => m.type === 'prompt_ready'), worker.logs, 20_000);
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(() => consumedReceipts(worker.messages).some(m => m.type === 'native_input_consumed' && m.turnId === 'om_followup'),
      worker.logs, 20_000);
    expect(consumedReceipts(worker.messages).filter(m => m.type === 'native_input_consumed' && m.turnId === 'om_followup'))
      .toEqual([expect.objectContaining({ proofKind: 'antigravity_transcript_user_input' })]);
  }, 60_000);

  it('acknowledges native consumption of a follow-up whose receipt only the deferred recheck sees', async () => {
    // History lands before the 20s recheck; agy feeds the input only after it.
    const worker = startWorker('prompt', 'antigravity', { ownTranscript: true, followupDelayMs: 600, followupTranscriptLagMs: 22_000 });
    await waitFor(() => consumedReceipts(worker.messages).some(m => m.type === 'native_input_consumed' && m.turnId === 'om_initial'),
      worker.logs, 30_000);
    await waitFor(() => worker.messages.some(m => m.type === 'prompt_ready'), worker.logs, 20_000);
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER', turnId: 'om_late' } satisfies DaemonToWorker);
    // The deferred recheck runs on its unscaled 20s timer.
    await waitFor(() => consumedReceipts(worker.messages).some(m => m.type === 'native_input_consumed' && m.turnId === 'om_late'),
      worker.logs, 45_000);
    expect(worker.logs.join('')).toMatch(/Deferred recheck found submit/);
    expect(worker.input().match(/FOLLOWUP_UNIQUE_MARKER/g)).toHaveLength(1);
  }, 100_000);

  it('acknowledges native consumption that agy records only after the submit returned', async () => {
    const worker = startWorker('prompt', 'antigravity', { ownTranscript: true, transcriptLagMs: 1_500 });
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 30_000);
    expect(consumedReceipts(worker.messages)).toEqual([]);
    await waitFor(() => consumedReceipts(worker.messages).length > 0, worker.logs, 15_000);
    expect(consumedReceipts(worker.messages)).toEqual([expect.objectContaining({
      type: 'native_input_consumed', turnId: 'om_initial', proofKind: 'antigravity_transcript_user_input',
    })]);
  }, 60_000);

  it('does not acknowledge native consumption from a history line alone', async () => {
    const worker = startWorker('prompt', 'antigravity');
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 30_000);
    // Outlast the in-band transcript poll.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(consumedReceipts(worker.messages)).toEqual([]);
  }, 45_000);

  it('acknowledges native consumption of a slow activation through its deferred receipt', async () => {
    const worker = startWorker('delayed', 'antigravity', { ownTranscript: true });
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 40_000);
    await waitFor(() => consumedReceipts(worker.messages).length > 0, worker.logs, 5_000);
    expect(consumedReceipts(worker.messages)).toEqual([expect.objectContaining({
      type: 'native_input_consumed', turnId: 'om_initial', proofKind: 'antigravity_transcript_user_input',
    })]);
    expect(worker.input().match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
  }, 60_000);

  it.each(['antigravity', 'traex'] as const)('%s writes a slow activation once and acknowledges its deferred receipt', async cliId => {
    const worker = startWorker('delayed', cliId);
    await waitFor(() => worker.input().includes('ACTIVATION_UNIQUE_MARKER'), worker.logs, 30_000);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    expect(worker.input().match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 20_000);
    expect(worker.messages.filter(m => m.type === 'queued_activation_submitted')).toEqual([{
      type: 'queued_activation_submitted', sessionId: worker.sessionId, activationToken: 'activation-token',
    }]);
    expect(worker.input().match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    expect(worker.messages.some(m => m.type === 'user_notify')).toBe(false);
  }, 45_000);

  it('delivers a follow-up from the interrupted empty composer despite a stale tool-result transcript', async () => {
    const worker = startWorker('interrupted');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs, 30_000);
    // ready opens the fixture's first-frame gate; do not submit until that
    // interrupted composer has actually been consumed by the worker.
    await waitFor(() => worker.messages.some(m => m.type === 'screen_update'
      && m.status === 'idle' && m.content.includes('Interrupted')), worker.logs, 20_000);
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(() => worker.input().includes('FOLLOWUP_UNIQUE_MARKER'), worker.logs);
    expect(worker.input().match(/FOLLOWUP_UNIQUE_MARKER/g)).toHaveLength(1);
  }, 60_000);

  it.each([false, true])('waits for the worker and its CLI to exit before deleting their home (worker already killed: %s)', async alreadyKilled => {
    const worker = startWorker('interrupted');
    await waitFor(() => existsSync(worker.cliPidFile), worker.logs);
    const cliPid = Number(readFileSync(worker.cliPidFile, 'utf8'));
    expect(processAlive(cliPid)).toBe(true);
    if (alreadyKilled) {
      const exited = new Promise<void>(resolve => worker.child.once('exit', () => resolve()));
      worker.child.kill('SIGKILL');
      await exited;
    }
    await stopChildren();
    expect(worker.child.exitCode !== null || worker.child.signalCode !== null).toBe(true);
    expect(processAlive(cliPid)).toBe(false);
    expect(existsSync(worker.root)).toBe(true);
    // Directory removal needs no retry once all its writers have exited.
    rmSync(worker.root, { recursive: true, force: true });
    expect(existsSync(worker.root)).toBe(false);
  }, 20_000);

  it('acknowledges a manual terminal submission after the warning chain has ended without writing again', async () => {
    const worker = startWorker('manual');
    await waitFor(() => worker.messages.some(m => m.type === 'user_notify'), worker.logs, 65_000);
    const warning = worker.messages.find(m => m.type === 'user_notify');
    expect(warning?.type === 'user_notify' ? warning.message : '').toMatch(/首条消息|Opening message/);
    expect(warning?.type === 'user_notify' ? warning.message : '').toMatch(/关闭该会话|close this session/);
    const originalInput = worker.input();
    worker.recordReceipt();
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 25_000);
    expect(worker.messages.filter(m => m.type === 'queued_activation_submitted')).toEqual([{
      type: 'queued_activation_submitted', sessionId: worker.sessionId, activationToken: 'activation-token',
    }]);
    expect(worker.messages.filter(m => m.type === 'user_notify')).toHaveLength(1);
    expect(originalInput.match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    expect(worker.input()).toBe(originalInput);
  }, 100_000);

  it('promotes agy 1.5.15+ shortcuts-footer quota screen to antigravity-native-log with recovery cursor over real worker/PTY IPC', async () => {
    const worker = startWorker('quota-with-footer');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs, 30_000);
    await waitFor(
      () => worker.messages.some(
        m => m.type === 'screen_update'
          && m.status === 'limited'
          && m.usageLimit?.source === 'antigravity-native-log',
      ),
      worker.logs,
      25_000,
    );
    const limited = worker.messages.find(
      m => m.type === 'screen_update' && m.usageLimit?.source === 'antigravity-native-log',
    );
    expect(limited && limited.type === 'screen_update' ? limited.usageLimit : undefined).toMatchObject({
      limited: true,
      kind: 'usage',
      source: 'antigravity-native-log',
      nativeEpisodeKey: 'log:E1125 00:00:02.123456',
      retryLabel: '2h39m35s',
    });
    expect(limited && limited.type === 'screen_update' ? limited.antigravityQuotaCursor : undefined).toMatchObject({
      lastConfirmed: {
        source: 'antigravity-native-log',
        nativeEpisodeKey: 'log:E1125 00:00:02.123456',
      },
      recoveredEpisodeKey: null,
    });
  }, 60_000);
});
