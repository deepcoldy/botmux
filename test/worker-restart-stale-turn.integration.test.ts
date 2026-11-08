/**
 * A daemon restart re-attaching live Claude panes (#2727).
 *
 * 1. A CLI relaunched inside the worker (crash → `restart` with --resume)
 *    left the journal entry of the turn it died in. The next worker process
 *    restored it as a turn IT had interrupted: the replay rewound to that old
 *    mark, re-sent answers the chat already had, and settled the old turn as
 *    failed off the synthetic "No response requested." record Claude writes
 *    when it resumes a cut-off turn.
 * 2. A re-attached pane running a foreground Bash tool shows no busy marker
 *    (Claude's footer drops 「esc to interrupt」 while a tool runs), and the
 *    re-attach probe marked it ready mid-turn — releasing the turn's authority.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude writing
 * the transcript records Claude writes; the restart is the daemon's: SIGTERM,
 * then a new worker with `resume`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';
import { makeFingerprint, normaliseForFingerprint } from '../src/services/bridge-turn-queue.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

afterEach(cleanUpClaudeHarnesses);

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** What the daemon does on a restart: SIGTERM the worker (the pane and its CLI
 *  survive), then start a new one that re-attaches. */
async function sigtermRestart(h: Harness, g: Generation): Promise<Generation> {
  const exited = new Promise<void>(done => g.child.once('exit', () => done()));
  g.child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
  expect(g.child.exitCode !== null || g.child.signalCode !== null, 'the old worker exits on SIGTERM').toBe(true);
  return h.startWorker({ resume: true });
}

const failedTurns = (g: Generation) => g.messages
  .filter((m): m is Extract<WorkerToDaemon, { type: 'turn_terminal' }> => m.type === 'turn_terminal' && m.status !== 'completed')
  .map(m => `${m.turnId}:${m.status}:${m.errorCode ?? ''}`);

const send = (g: Generation, msg: DaemonToWorker) => g.child.send(msg);

/** The turn the CLI is working on when it dies, then an in-worker relaunch and
 *  a later turn the relaunched CLI answers.
 *
 *  In production (2026-11-02 15:09) nothing ever touched the dead CLI's entry
 *  again: that turn had been released at startup and the resumed CLI got no
 *  note under its id. Here the worker's restart note goes out under the
 *  interrupted turn's id and re-marks it, so the entry the dead generation
 *  wrote is kept under an id of its own (`om_lost`) — the on-disk state the
 *  production sessions were in. */
async function crashMidTurnThenAnswerAnother(h: Harness, g: Generation): Promise<void> {
  await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
  send(g, { type: 'message', content: 'HANG stale turn', turnId: 'om_stale' });
  await g.waitFor(() => h.toolStartedAt('HANG stale turn') !== undefined, 'the stale turn to be running its tool');
  h.crashCli();
  await g.waitFor(() => g.messages.some(m => m.type === 'claude_exit'), 'the worker to see its CLI die');
  const journal = join(h.root, 'data', 'turn-marks', `${h.sessionId}.json`);
  const pending = JSON.parse(readFileSync(journal, 'utf8')).pending as Array<{ turnId: string }>;
  const stale = pending.find(entry => entry.turnId === 'om_stale');
  expect(stale, 'the dead generation journaled its turn').toBeDefined();
  writeFileSync(journal, `${JSON.stringify({ version: 1, pending: [...pending, { ...stale, turnId: 'om_lost' }] })}\n`);
  const readyBefore = promptReadyCount(g);
  send(g, { type: 'restart', reason: 'cli_crash', attemptId: 'crash-1' });
  await g.waitFor(() => h.launches().length === 2 && promptReadyCount(g) > readyBefore, 'the relaunched CLI to be ready');
  expect(h.launches()[1]!.args, 'relaunched with --resume').toContain('--resume');
  send(g, { type: 'message', content: 'second question', turnId: 'om_second' });
  await g.waitFor(() => g.finals().some(text => text.includes('reply: second question')), 'the second answer');
}

describe.skipIf(!runnable)('daemon restart after an in-worker CLI relaunch (#2727)', () => {
  it('re-attaching the relaunched pane neither fails the old turn nor re-sends answers', async () => {
    const h = setup({ turnMs: 500, programStatus: true });
    const g = h.startWorker();
    await crashMidTurnThenAnswerAnother(h, g);

    const next = await sigtermRestart(h, g);
    await next.waitFor(() => promptReadyCount(next) > 0, 'the re-attached CLI to be ready');
    await sleep(8_000);
    expect(failedTurns(next), next.logs.join('')).toEqual([]);
    expect(next.finals().filter(text => text.includes('reply: second question')), next.logs.join('')).toEqual([]);
  }, 180_000);

  it('a cold start after it (worker and CLI both gone) neither fails the old turn nor re-sends answers', async () => {
    const h = setup({ turnMs: 500, programStatus: true });
    const g = h.startWorker();
    await crashMidTurnThenAnswerAnother(h, g);

    await g.kill();
    h.killCli();
    const next = h.startWorker({ resume: true });
    await next.waitFor(() => promptReadyCount(next) > 0, 'the relaunched CLI to be ready');
    await sleep(8_000);
    expect(failedTurns(next), next.logs.join('')).toEqual([]);
    expect(next.finals().filter(text => text.includes('reply: second question')), next.logs.join('')).toEqual([]);
  }, 180_000);

  it('an entry a pre-fix build left behind, older than the live CLI, is not restored on re-attach', async () => {
    const h = setup({ turnMs: 500, programStatus: true });
    const beforeLaunch = Date.now();
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    send(g, { type: 'message', content: 'first question', turnId: 'om_first' });
    await g.waitFor(() => g.finals().some(text => text.includes('reply: first question')), 'the first answer');
    // What an older build left on disk: the entry of a turn written into an
    // earlier CLI generation, never removed. Its prompt is in the transcript.
    const journal = join(h.root, 'data', 'turn-marks', `${h.sessionId}.json`);
    mkdirSync(join(h.root, 'data', 'turn-marks'), { recursive: true });
    const normalized = normaliseForFingerprint('first question');
    writeFileSync(journal, `${JSON.stringify({ version: 1, pending: [{
      turnId: 'om_orphan',
      markTimeMs: beforeLaunch - 10 * 60_000,
      jsonlPath: h.transcript(h.sessionId),
      offsetAtMark: 0,
      fingerprint: makeFingerprint(normalized),
      contentNormalized: normalized,
    }] })}\n`);

    const next = await sigtermRestart(h, g);
    await next.waitFor(() => promptReadyCount(next) > 0, 'the re-attached CLI to be ready');
    await sleep(8_000);
    expect(failedTurns(next), next.logs.join('')).toEqual([]);
    expect(next.finals().filter(text => text.includes('reply: first question')), next.logs.join('')).toEqual([]);
  }, 180_000);
});

/** SIGTERM after the in-worker relaunch started and before it wrote anything:
 *  the carried-over turn lives only in the dying worker's memory and in the
 *  journal. The next worker must still settle it — restored, or ended with an
 *  explicit terminal — never drop it without a word. */
async function sigtermBeforeRelaunchWrites(h: Harness, g: Generation): Promise<void> {
  await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
  send(g, { type: 'message', content: 'HANG interrupted turn', turnId: 'om_interrupted' });
  await g.waitFor(() => h.toolStartedAt('HANG interrupted turn') !== undefined, 'the turn to be running its tool');
  h.crashCli();
  await g.waitFor(() => g.messages.some(m => m.type === 'claude_exit'), 'the worker to see its CLI die');
  send(g, { type: 'restart', reason: 'cli_crash', attemptId: 'crash-1' });
  await g.waitFor(() => h.launches().length === 2, 'the relaunch');
  // The relaunched CLI holds its prompt back for 20s: nothing has been
  // written into it when the worker goes.
  await sleep(3_000);
  const exited = new Promise<void>(done => g.child.once('exit', () => done()));
  g.child.kill('SIGTERM');
  await Promise.race([exited, sleep(15_000)]);
}

const settledTurn = (g: Generation, turnId: string) => g.messages.some(m =>
  (m.type === 'turn_terminal' || m.type === 'final_output') && m.turnId === turnId);

describe.skipIf(!runnable)('daemon restart while an in-worker relaunch is starting (#2727)', () => {
  it('re-attaching the still-starting pane settles the carried-over turn', async () => {
    const h = setup({ turnMs: 500, programStatus: true, resumeReadyDelayMs: 20_000 });
    const g = h.startWorker();
    await sigtermBeforeRelaunchWrites(h, g);
    const next = h.startWorker({ resume: true });
    await next.waitFor(() => settledTurn(next, 'om_interrupted'), 'the interrupted turn to be settled', 60_000);
  }, 180_000);

  it('a cold start settles the carried-over turn', async () => {
    const h = setup({ turnMs: 500, programStatus: true, resumeReadyDelayMs: 20_000 });
    const g = h.startWorker();
    await sigtermBeforeRelaunchWrites(h, g);
    h.killCli();
    const next = h.startWorker({ resume: true });
    await next.waitFor(() => settledTurn(next, 'om_interrupted'), 'the interrupted turn to be settled', 60_000);
  }, 180_000);
});

describe.skipIf(!runnable)('re-attaching a pane mid-tool (#2727)', () => {
  it('a running foreground tool is not taken for an idle prompt; the turn ends where it belongs', async () => {
    const h = setup({ turnMs: 500, programStatus: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    const prompt = 'LONGTOOL 25000 build the site';
    send(g, { type: 'message', content: prompt, turnId: 'om_long' });
    await g.waitFor(() => h.toolStartedAt(prompt) !== undefined, 'the tool to start');

    const next = await sigtermRestart(h, g);
    await next.waitFor(() => h.doneAt('turn', `reply: ${prompt}`) !== undefined, 'the tool and its turn to finish', 60_000);
    const doneAt = h.doneAt('turn', `reply: ${prompt}`)!;
    expect(next.readyAt.filter(at => at < doneAt), next.logs.join('')).toEqual([]);
    await next.waitFor(() => promptReadyCount(next) > 0, 'the prompt once the turn ended');
    await next.waitFor(() => next.finals().some(text => text.includes(`reply: ${prompt}`)), 'the answer');
    expect(failedTurns(next), next.logs.join('')).toEqual([]);
  }, 180_000);

  it('a turn cancelled before the restart (no closing record, pane at its prompt) still becomes ready', async () => {
    const h = setup({ turnMs: 500, programStatus: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the CLI to be ready');
    const prompt = 'INTERRUPTED long job';
    send(g, { type: 'message', content: prompt, turnId: 'om_cancelled' });
    await g.waitFor(() => h.interruptedAt(prompt) !== undefined, 'the turn to be cancelled');
    await sleep(1_000);

    const next = await sigtermRestart(h, g);
    await next.waitFor(() => promptReadyCount(next) > 0, 'the re-attached CLI to be ready', 60_000);
  }, 180_000);
});
