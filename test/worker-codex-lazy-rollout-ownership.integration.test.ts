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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const OWN_SID = '01a17500-0000-7000-8000-00000000a363';
const FOREIGN_SID = '01a17500-0000-7000-8000-00000000f363';
const PROMPT = 'lazy-rollout-task';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startWorker(
  historySid: string,
  opts: { openAfterGivingUp?: boolean; historyDelayMs?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'bmx-codex-lazy-rollout-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const releaseStartup = join(root, 'release-startup');
  const loaded = join(root, 'loaded');
  const openRollout = join(root, 'open-rollout');
  const rolloutOpened = join(root, 'rollout-opened');
  const cliPidFile = join(root, 'cli-pid');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
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
  child.on('message', m => messages.push(m as WorkerToDaemon));
  child.stdout?.on('data', b => logs.push(b.toString()));
  child.stderr?.on('data', b => logs.push(b.toString()));
  cleanups.push(async () => {
    await killProcessTree(child);
    // The CLI may live in its own session scope, outside the worker's tree.
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const waitFor = async (what: string, condition: () => boolean, timeoutMs = 15_000) => {
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
    workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType: 'pty',
    promptInjection: 'none',
    prompt: PROMPT, turnId: 'om_lazy', larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  await waitFor('fake Codex startup', () => existsSync(loaded));
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
  return { child, messages, logs, waitFor, finals, consumed };
}

describe('Codex history match that lands before the lazily-created rollout', () => {
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
