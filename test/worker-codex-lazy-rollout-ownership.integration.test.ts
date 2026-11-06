/**
 * Codex creates its rollout lazily at the first submit, and the history.jsonl
 * line for that submit is appended by a different task — so the line can be
 * readable while the Codex process holds no rollout yet (#2363). writeInput
 * must not take that history id as the session (it may be another pane's
 * identical text), but dropping it left a fresh spawn with no way to find its
 * rollout: the reply was never collected and the pre-start lease gave up.
 *
 * The fake Codex below reproduces that order exactly: history line first, the
 * rollout only after the test releases a barrier, which it does once the
 * worker has already settled the submit without a proven session.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNodeExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const OWN_SID = '01a17500-0000-7000-8000-00000000a363';
const FOREIGN_SID = '01a17500-0000-7000-8000-00000000f363';
const PROMPT = 'lazy-rollout-task';
/** Slack for one load-dependent step; deterministic sleeps are added on top. */
const WAIT_MS = 15_000;
const SLOW_LAUNCH_MS = 8_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startWorker(
  historySid: string,
  opts: { openAfterGivingUp?: boolean; historyDelayMs?: number; startupProbe?: boolean; startupDelayMs?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'bmx-codex-lazy-rollout-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const releaseStartup = join(root, 'release-startup');
  const loaded = join(root, 'loaded');
  const openRollout = join(root, 'open-rollout');
  const rolloutOpened = join(root, 'rollout-opened');
  const cliPidFile = join(root, 'cli-pid');
  const probePidFile = join(root, 'probe-pid');
  const launcherPidFile = join(root, 'launcher-pid');
  const launcherStartedFile = join(root, 'launcher-started-at');
  const attestationFile = join(root, 'attestation');
  const firstSubmitAttestationFile = join(root, 'first-submit-attestation');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (${!!opts.startupProbe || !!opts.startupDelayMs}) process.title = 'codex';
// Same data root the worker watches: it may redirect CODEX_HOME per bot.
const codexHome = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
const rolloutPath = (home, sid) => path.join(home, 'sessions', '2026', '10', '27', 'rollout-2026-10-27T00-00-00-' + sid + '.jsonl');
const event = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n';
const rolloutLines = (sid, text, reply, turnSeq) => event('session_meta', { id: sid, cwd: process.cwd() })
  + event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  // Real Codex assigns a unique native turn id per turn. A shared id makes the
  // queue's closed-turn guard (isClosedNativeTurn) reject turn N+1's terminal.
  + event('event_msg', { type: 'task_complete', turn_id: 'native-' + sid + '-' + turnSeq, last_agent_message: reply });
const historyPath = path.join(codexHome, 'history.jsonl');
const ownRollout = rolloutPath(codexHome, ${JSON.stringify(OWN_SID)});
fs.mkdirSync(path.dirname(ownRollout), { recursive: true });
if (${JSON.stringify(historySid)} !== ${JSON.stringify(OWN_SID)}) {
  // Another pane under the same CODEX_HOME submitted identical text: its
  // rollout is on disk (resolvable by id), but this process never opens it.
  fs.writeFileSync(rolloutPath(codexHome, ${JSON.stringify(historySid)}),
    rolloutLines(${JSON.stringify(historySid)}, ${JSON.stringify(PROMPT)}, 'FOREIGN ROLLOUT REPLY', 'foreign'));
}
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
let input = '';
let submits = 0;
let rolloutFd;
const idle = () => process.stdout.write('\\x1b[2J\\x1b[H› Ask Codex to do anything\\r\\n\\r\\n custom-model · /tmp');
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => { input += chunk.toString(); });
setInterval(() => {
  const match = input.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/);
  if (!match) return;
  input = input.slice(input.indexOf(match[0]) + match[0].length);
  submits += 1;
  if (submits === 1) {
    fs.writeFileSync(${JSON.stringify(firstSubmitAttestationFile)},
      fs.existsSync(${JSON.stringify(attestationFile)}) ? fs.readFileSync(${JSON.stringify(attestationFile)}) : 'null');
  }
  if (submits > 1) {
    // Later submits: the rollout is already open, as in a live session.
    fs.writeSync(rolloutFd, rolloutLines(${JSON.stringify(OWN_SID)}, match[1], 'OWN ROLLOUT REPLY ' + submits, 'turn-' + submits));
    fs.appendFileSync(historyPath, JSON.stringify({ session_id: ${JSON.stringify(OWN_SID)}, text: match[1], ts: Date.now() / 1000 }) + '\\n');
    return idle();
  }
  // Codex 0.164 order under load: the history line is readable first.
  setTimeout(() => {
    fs.appendFileSync(historyPath, JSON.stringify({ session_id: ${JSON.stringify(historySid)}, text: match[1], ts: Date.now() / 1000 }) + '\\n');
  }, ${opts.historyDelayMs ?? 0});
  process.stdout.write('\\x1b[2J\\x1b[H• Working (esc to interrupt)\\r\\n');
  const open = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(openRollout)})) return;
    clearInterval(open);
    rolloutFd = fs.openSync(ownRollout, 'a');
    fs.writeSync(rolloutFd, rolloutLines(${JSON.stringify(OWN_SID)}, match[1], 'OWN ROLLOUT REPLY', 'turn-' + submits));
    fs.writeFileSync(${JSON.stringify(rolloutOpened)}, 'open');
    idle();
  }, 25);
}, 25);
process.stdout.write('\\x1b[?2004h│ model: loading /model to change │\\n│ directory: loading │\\n› Ask Codex to do anything\\n  ? for shortcuts');
fs.writeFileSync(${JSON.stringify(loaded)}, 'ready');
const startup = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseStartup)})) return;
  clearInterval(startup);
  process.stdout.write('\\x1b[2J\\x1b[H│ model: custom-model /model to change │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n custom-model · /tmp');
}, 50);
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);

  let cliPath = fakeCli;
  if (opts.startupProbe) {
    // An unrecognised startup probe still looks like Codex to the comm-only
    // resolver. A renamed sleep keeps its real argv and OS comm without a C
    // compiler; explicit debug/version filtering is covered separately.
    const probe = join(root, 'codex');
    copyFileSync('/bin/sleep', probe);
    cliPath = join(root, 'launcher');
    writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
const probe = spawn(${JSON.stringify(probe)}, ['30'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(probePidFile)}, String(probe.pid));
probe.on('exit', () => {
  const cli = spawn(${JSON.stringify(resolveNodeExecutable())}, [${JSON.stringify(fakeCli)}, ...process.argv.slice(2)], { stdio: 'inherit' });
  cli.on('exit', code => process.exit(code ?? 0));
});
`);
    chmodSync(cliPath, 0o755);
  }

  if (opts.startupDelayMs) {
    cliPath = join(root, 'slow-launcher');
    writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
// Written after the pid so a reader never sees the clock without the pid.
fs.writeFileSync(${JSON.stringify(launcherStartedFile)}, String(Date.now()));
setTimeout(() => {
  const cli = spawn(${JSON.stringify(resolveNodeExecutable())}, [${JSON.stringify(fakeCli)}, ...process.argv.slice(2)], { stdio: 'inherit' });
  cli.on('exit', code => process.exit(code ?? 0));
}, ${opts.startupDelayMs});
`);
    chmodSync(cliPath, 0o755);
  }

  const sessionId = randomUUID();
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child: ChildProcess = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: join(root, 'codex-home'),
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let attestedPid: number | undefined;
  child.on('message', m => {
    const msg = m as WorkerToDaemon;
    messages.push(msg);
    if (msg.type === 'local_process_attestation') attestedPid = msg.cliPid;
    if (msg.type === 'managed_turn_origin') {
      // Model the daemon's ordered IPC publication; the fake CLI samples it
      // immediately on its first submit, before creating history or a rollout.
      writeFileSync(attestationFile, JSON.stringify({ cliPid: attestedPid, turnId: msg.turnId }));
    }
  });
  child.stdout?.on('data', b => logs.push(b.toString()));
  child.stderr?.on('data', b => logs.push(b.toString()));
  cleanups.push(async () => {
    await killProcessTree(child);
    // The CLI may live in its own session scope, outside the worker's tree.
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    for (const pidFile of [probePidFile, launcherPidFile]) {
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const waitFor = async (what: string, condition: () => boolean, timeoutMs = WAIT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child.exitCode != null) {
        throw new Error(`timed out waiting for ${what}\n${logs.join('')}`);
      }
      await new Promise(r => setTimeout(r, 25));
    }
  };

  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'codex', cliPathOverride: cliPath, backendType: 'pty',
    promptInjection: 'none',
    prompt: PROMPT, turnId: 'om_lazy', larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  if (opts.startupProbe) {
    await waitFor('the startup probe', () => existsSync(probePidFile) && !!readFileSync(probePidFile, 'utf8'));
    const probePid = Number(readFileSync(probePidFile, 'utf8'));
    // Ensure the production resolver really selected this process before it
    // exits. Without that barrier the regression can pass by missing the race.
    await waitFor('the probe ownership binding', () => logs.some(l => l.includes(`resolved real codex leaf pid ${probePid}`)));
    process.kill(probePid, 'SIGTERM');
  }
  if (opts.startupDelayMs) {
    // The launcher's delay is deterministic and only starts once the worker has
    // booted and spawned it; worker cold start is not (3.7–14.7s measured with
    // 8 files on 4 oversubscribed CPUs, against ~0.4s idle). One window from
    // spawn charged both to the same 15s, leaving cold start ~7s where every
    // other case gets the full window (#2793/#2808/#2809). Give cold start its
    // own window, then measure the delay from the launcher's own clock.
    // writeFileSync creates the file before writing it: an empty read is "not yet".
    const readLauncherStart = () => existsSync(launcherStartedFile) ? Number(readFileSync(launcherStartedFile, 'utf8')) || 0 : 0;
    await waitFor('the slow launcher', () => readLauncherStart() > 0);
    const launcherStartedAt = readLauncherStart();
    await waitFor('fake Codex startup', () => existsSync(loaded),
      launcherStartedAt + opts.startupDelayMs + WAIT_MS - Date.now());
  } else {
    await waitFor('fake Codex startup', () => existsSync(loaded));
  }
  writeFileSync(releaseStartup, 'loaded');
  // Barrier: the submit has already been settled without a proven session,
  // before any rollout exists, so the proof cannot have come from the match.
  if (opts.historyDelayMs) {
    // Past writeInput's own polling; only the deferred recheck sees the line.
    await waitFor('the deferred recheck', () => logs.some(l => l.includes('Deferred recheck found submit')), 40_000);
  } else {
    await waitFor('the unproven history match', () => logs.some(l => l.includes(`Codex history matched session ${historySid}`)));
  }
  if (opts.openAfterGivingUp) {
    // The 20s pre-start lease runs out first; only then does the rollout open.
    await waitFor('the turn to be given up', () => logs.some(l => l.includes('Structured bridge could not collect turn om_lazy')), 30_000);
  }
  writeFileSync(openRollout, 'go');
  await waitFor('the fake rollout to open', () => existsSync(rolloutOpened));

  const finals = () => messages.filter(
    (m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
  const consumed = () => messages.filter(
    (m): m is Extract<WorkerToDaemon, { type: 'native_input_consumed' }> => m.type === 'native_input_consumed');
  return { child, messages, logs, waitFor, finals, consumed, cliPid: Number(readFileSync(cliPidFile, 'utf8')),
    firstSubmitAttestation: JSON.parse(readFileSync(firstSubmitAttestationFile, 'utf8')) };
}

describe('Codex history match that lands before the lazily-created rollout', () => {
  it.skipIf(process.platform !== 'linux')('attests a slow launcher child before the first input is handed to Codex', async () => {
    const run = await startWorker(OWN_SID, { startupDelayMs: SLOW_LAUNCH_MS });
    expect(run.firstSubmitAttestation).toEqual({ cliPid: run.cliPid, turnId: 'om_lazy' });
    await run.waitFor('the slow-launch reply', () => run.finals().some(m => m.turnId === 'om_lazy'));
    expect(run.finals().filter(m => m.turnId === 'om_lazy')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY' }),
    ]);
    // Cold start, the launcher's delay plus its slack, the history match and the
    // reply each get their own window; the case must outlast all of them, or the
    // runner's timeout fires first and hides which step was slow.
  }, 4 * WAIT_MS + SLOW_LAUNCH_MS);

  it.skipIf(process.platform !== 'linux')('recovers a retired startup probe and collects both turns exactly once', async () => {
    const run = await startWorker(OWN_SID, { startupProbe: true });
    await run.waitFor('the turn reply', () => run.finals().some(m => m.turnId === 'om_lazy'));
    expect(run.finals().filter(m => m.turnId === 'om_lazy')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY' }),
    ]);
    expect(run.messages).toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: OWN_SID }));
    run.child.send({ type: 'message', turnId: 'om_next', content: 'next-task' } satisfies DaemonToWorker);
    await run.waitFor('the next turn reply', () => run.finals().some(m => m.turnId === 'om_next'));
    expect(run.finals().filter(m => m.turnId === 'om_next')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY 2' }),
    ]);
    expect(run.messages.filter(m => m.type === 'user_notify')).toEqual([]);
  }, 40_000);

  it('collects the turn once the Codex process holds the matched rollout', async () => {
    const run = await startWorker(OWN_SID);
    await run.waitFor('the turn reply', () => run.finals().some(m => m.turnId === 'om_lazy'));
    expect(run.finals().filter(m => m.turnId === 'om_lazy')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY' }),
    ]);
    // The late-proven match is the same owned evidence writeInput gives when
    // the rollout is already open.
    expect(run.consumed()).toEqual([expect.objectContaining({
      turnId: 'om_lazy', proofKind: 'codex_history_match', nativeSessionId: OWN_SID,
    })]);
    expect(run.messages).toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: OWN_SID }));
  }, 40_000);

  it('collects the turn when only the deferred recheck sees the history line', async () => {
    // The confirmation renews the turn's lease, so a candidate dropped here
    // would fail the turn just like the in-band drop did.
    const run = await startWorker(OWN_SID, { historyDelayMs: 6_000 });
    await run.waitFor('the turn reply', () => run.finals().some(m => m.turnId === 'om_lazy'));
    expect(run.finals().filter(m => m.turnId === 'om_lazy')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY' }),
    ]);
    expect(run.consumed()).toEqual([expect.objectContaining({
      turnId: 'om_lazy', proofKind: 'codex_history_match', nativeSessionId: OWN_SID,
    })]);
    // The deferred path must persist the session id exactly as the in-band one.
    expect(run.messages).toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: OWN_SID }));
  }, 80_000);

  it('never binds a deferred foreign-sid candidate even though that rollout is on disk', async () => {
    // The history line arrives only after the in-band budget, so the candidate
    // is carried through the deferred recheck. The foreign rollout is written
    // to disk (resolvable by sid) but THIS observed process never holds it:
    // the deferred path must still prove fd ownership and never bind.
    const run = await startWorker(FOREIGN_SID, { historyDelayMs: 6_000 });
    await new Promise(r => setTimeout(r, 2_500));
    expect(run.child.exitCode).toBeNull();
    expect(run.finals().map(m => m.content)).not.toContain('FOREIGN ROLLOUT REPLY');
    expect(run.consumed()).toEqual([]);
    expect(run.messages).not.toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: FOREIGN_SID }));
  }, 60_000);

  it('never binds a history id the Codex process does not hold, even when its rollout exists', async () => {
    const run = await startWorker(FOREIGN_SID);
    // Two poller ticks after this process opened its own rollout.
    await new Promise(r => setTimeout(r, 2_500));
    expect(run.child.exitCode).toBeNull();
    expect(run.finals().map(m => m.content)).not.toContain('FOREIGN ROLLOUT REPLY');
    expect(run.consumed()).toEqual([]);
    expect(run.messages).not.toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: FOREIGN_SID }));
  }, 40_000);

  it('drops the candidate with its turn, and the next submit binds through its own proof', async () => {
    const run = await startWorker(OWN_SID, { openAfterGivingUp: true });
    await new Promise(r => setTimeout(r, 2_500));
    // The turn the user was already told about stays given up.
    expect(run.finals().filter(m => m.turnId === 'om_lazy')).toEqual([]);
    expect(run.messages).not.toContainEqual(expect.objectContaining({ type: 'cli_session_id' }));

    run.child.send({ type: 'message', turnId: 'om_next', content: 'next-task' } satisfies DaemonToWorker);
    await run.waitFor('the next turn reply', () => run.finals().some(m => m.turnId === 'om_next'));
    expect(run.finals().filter(m => m.turnId === 'om_next')).toEqual([
      expect.objectContaining({ content: 'OWN ROLLOUT REPLY 2' }),
    ]);
    expect(run.messages).toContainEqual(expect.objectContaining({ type: 'cli_session_id', cliSessionId: OWN_SID }));
  }, 70_000);
});

describe('ZMX submission journal settlement', () => {
  type Result = { submitted: boolean; cliSessionId?: string; unprovenCliSessionId?: string; recheck?: () => unknown };
  const settle = loadWorkerFunction<(result: Result) => Promise<boolean>>(
    'settleVerifiableSubmissionForJournal',
    { SUBMIT_DEFERRED_RECHECK_MS: 0, log: () => {} },
  );

  it('keeps a late unproven history candidate for flushPending', async () => {
    const result: Result = { submitted: false, recheck: () => ({ submitted: true, unprovenCliSessionId: OWN_SID }) };
    expect(await settle(result)).toBe(true);
    expect(result).toMatchObject({ submitted: true, unprovenCliSessionId: OWN_SID });
    expect(result.cliSessionId).toBeUndefined();
  });
});
