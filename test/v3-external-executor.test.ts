/**
 * v3 external (bot-executed) goal nodes — engine layer.
 *
 * Real runtime + real journal/manifest validation + a fake transport and an
 * injectable engine clock. A "restart" is a fresh runtime (and a fresh
 * executor instance) over the same run directory.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent, readJournal, type StoredEvent, type V3Event } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { openV3WorkerAttempts } from '../src/workflows/v3/attempt-ledger.js';
import { openV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import {
  V3_HANDOFF_IDEMPOTENCY_WINDOW_MS,
  type V3ExternalNodeExecutor,
} from '../src/workflows/v3/external-executor.js';
import {
  ingestExternalSubmission,
  reassignNode,
  recordExternalAccepted,
  recordExternalStalled,
  reportExternalBlocked,
} from '../src/workflows/v3/external-control.js';
import { requestV3Retry } from '../src/workflows/v3/daemon-run.js';
import type { RunNode } from '../src/workflows/v3/contract.js';
import type { HostExecutorRegistry } from '../src/workflows/hostExecutors/registry.js';
import {
  ACCEPT_MS,
  BotRun,
  FakeExecutor,
  T0,
  TIMEOUT_SEC,
  cleanupBotRuns,
  expectAwaitingExternal,
  expectTerminal,
  reportDag,
  reportFiles,
  trackTempDir,
  validateManifest,
} from './helpers/v3-external-harness.js';

afterEach(cleanupBotRuns);

// ─── Dispatch, suspend, submit ───────────────────────────────────────────

describe('external goal nodes — dispatch suspends on disk', () => {
  it('writes the intent before sending, suspends without a worker, and completes from a validated submission', async () => {
    const run = new BotRun(reportDag('ext-basic'));
    const executor = new FakeExecutor();
    let journalAtSend: StoredEvent[] = [];
    executor.onDispatch = (req) => {
      journalAtSend = readJournal(run.journalPath);
      return { kind: 'sent', handoffMessageId: 'om_handoff_1', threadId: 'omt_1' };
    };

    const first = expectAwaitingExternal(await run.drive(executor));
    expect(run.workerSpawns).toBe(0);
    expect(executor.dispatches).toHaveLength(1);
    const request = executor.dispatches[0]!;
    // Durable intent precedes the send, and carries the keys the send used.
    const prepared = journalAtSend.find((event) => event.type === 'nodeHandoffPrepared');
    expect(prepared).toMatchObject({
      attemptId: request.attemptId,
      targetLarkAppId: 'cli_a',
      idempotency: request.idempotency,
    });
    expect(request).toMatchObject({ nodeId: 'write', targetLarkAppId: 'cli_a', attemptNumber: 1, redispatch: false });
    expect(journalAtSend.some((event) => event.type === 'nodeHandoffSent')).toBe(false);

    // The run waits on disk: no worker attempt to orphan, one open binding.
    expect(openV3WorkerAttempts(run.events())).toEqual([]);
    expect(run.snap().nodes.get('write')?.status).toBe('running');
    const sent = run.of('nodeHandoffSent')[0]!;
    expect(first.wakeAt).toBe(sent.acceptDeadlineAt);
    expect(sent.acceptDeadlineAt - sent.sentAt).toBe(ACCEPT_MS);

    const attemptId = request.attemptId;
    run.clock.t += 1_000;
    const accepted = run.accept(attemptId);
    expect(accepted).toMatchObject({ ok: true, deadlineAt: run.clock.t + TIMEOUT_SEC * 1000 });
    expect(expectAwaitingExternal(await run.drive(new FakeExecutor())).wakeAt).toBe(run.clock.t + TIMEOUT_SEC * 1000);

    const ingested = await run.submit(attemptId, { ...reportFiles('# risk\n'), sessionId: 'sess-1' });
    expect(ingested).toMatchObject({ ok: true, kind: 'succeeded' });
    if (!ingested.ok || ingested.kind !== 'succeeded') throw new Error('unreachable');
    // Engine-generated manifest passes the normal validator against work/.
    const manifest = await readAndValidateManifest(ingested.manifestPath, join(run.runDir, attemptId, 'work'));
    expect(manifest.files.map((file) => file.path).sort()).toEqual(['report.md', 'result.json']);
    expect(readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8')).toBe('# risk\n');

    expect(expectTerminal(await run.drive(new FakeExecutor())).runStatus).toBe('succeeded');
    expect(run.workerSpawns).toBe(0);
  });

  it('feeds a submitted product to the downstream handoff as a resolved input', async () => {
    const run = new BotRun(validateDag({
      schemaVersion: 2,
      runId: 'ext-chain',
      nodes: [
        { id: 'collect', type: 'goal', goal: 'collect', bot: 'cli_a', outputs: { facts: { path: 'facts.md', kind: 'markdown' } } },
        { id: 'report', type: 'goal', goal: 'report', bot: 'cli_b', depends: ['collect'], inputs: [{ from: 'collect', output: 'facts' }] },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const collect = executor.dispatches[0]!;
    await run.submit(collect.attemptId, { files: [{ key: 'facts', data: Buffer.from('fact A') }] });
    await run.drive(executor);
    const report = executor.dispatches.find((req) => req.nodeId === 'report')!;
    expect(report.targetLarkAppId).toBe('cli_b');
    const input = report.inputs.inputs.find((entry) => entry.from === 'collect')!;
    expect(input.output).toBe('facts');
    expect(readFileSync(input.path, 'utf-8')).toBe('fact A');
  });

  it('rejects a submission that breaks the node contract without settling the node, then accepts a fixed one', async () => {
    const run = new BotRun(reportDag('ext-contract'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    const before = run.events().length;

    const undeclared = await run.submit(attemptId, {
      files: [{ key: 'notes', data: Buffer.from('x') }],
      result: { message: 'ok' },
    });
    expect(undeclared).toMatchObject({ ok: false, reason: 'invalid' });
    const missingOutput = await run.submit(attemptId, { result: { message: 'ok' } });
    expect(missingOutput).toMatchObject({ ok: false, reason: 'invalid' });
    const badResult = await run.submit(attemptId, { ...reportFiles(), result: { message: 42 } });
    expect(badResult).toMatchObject({ ok: false, reason: 'invalid' });

    expect(run.events()).toHaveLength(before);
    expect(run.snap().nodes.get('write')?.status).toBe('running');
    expect(existsSync(join(run.runDir, attemptId, 'work'))).toBe(false);

    expect(await run.submit(attemptId, reportFiles())).toMatchObject({ ok: true, kind: 'succeeded' });
  });

  it('copies a regular host file but refuses a symlinked one', async () => {
    const run = new BotRun(reportDag('ext-file-path'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    const staged = join(run.base, 'staged');
    mkdirSync(staged);
    writeFileSync(join(staged, 'secret.md'), 'outside bytes');
    symlinkSync(join(staged, 'secret.md'), join(staged, 'link.md'));
    writeFileSync(join(staged, 'report.md'), 'real report');

    const viaLink = await run.submit(attemptId, {
      files: [{ key: 'report', data: { path: join(staged, 'link.md') } }],
      result: { message: 'ok' },
    });
    expect(viaLink).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await run.submit(attemptId, {
      files: [{ key: 'report', data: { path: join(staged, 'report.md') } }],
      result: { message: 'ok' },
    })).toMatchObject({ ok: true, kind: 'succeeded' });
    expect(readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8')).toBe('real report');
  });

  it('records a stall without closing the attempt', async () => {
    const run = new BotRun(reportDag('ext-stall'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    run.accept(attemptId);
    expect(recordExternalStalled(run.runDir, { attemptId, sessionId: 'sess-1' }, run.ctx())).toEqual({ ok: true });
    expect(run.openAttempt('write').stalledAt).toBe(run.clock.t);
    expect(run.snap().nodes.get('write')?.status).toBe('running');
    expect(await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-1' })).toMatchObject({ ok: true, kind: 'succeeded' });
  });

  it('blocks on a bot-reported failure and retries in the same instance with the reason attached', async () => {
    const run = new BotRun(reportDag('ext-reported'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const first = executor.dispatches[0]!;
    expect(reportExternalBlocked(run.runDir, { attemptId: first.attemptId, reason: 'need prod credentials' }))
      .toEqual({ ok: true });
    const blocked = expectTerminal(await run.drive(executor));
    expect(blocked).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(run.of('nodeBlocked')[0]).toMatchObject({ errorCode: 'BOT_REPORTED_BLOCKED', message: 'need prod credentials' });

    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await run.drive(executor);
    const second = executor.dispatches[1]!;
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.attemptNumber).toBe(2);
    expect(second.idempotency.handoff).not.toBe(first.idempotency.handoff);
    expect(second.retryOf).toEqual({
      attemptId: first.attemptId,
      errorCode: 'BOT_REPORTED_BLOCKED',
      message: 'need prod credentials',
    });
    // The retried attempt can no longer submit.
    expect(await run.submit(first.attemptId, reportFiles())).toEqual({ ok: false, reason: 'retried' });
  });

  it('blocks without stopping anything when the transport proves nothing was sent', async () => {
    const run = new BotRun(reportDag('ext-rejected'));
    const executor = new FakeExecutor();
    executor.onDispatch = () => ({ kind: 'rejected', code: 'BOT_NOT_IN_CHAT' });
    const outcome = expectTerminal(await run.drive(executor));
    expect(outcome).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(run.of('nodeBlocked')[0]).toMatchObject({ errorCode: 'BOT_NOT_IN_CHAT' });
    expect(executor.stops).toEqual([]);
  });

  it('fails closed when a bot-mode run has no executor', async () => {
    const run = new BotRun(reportDag('ext-no-executor'));
    await expect(run.drive(undefined as unknown as V3ExternalNodeExecutor)).rejects.toThrow(/external node executor/);
  });
});

// ─── Restart / cold attach (design §9.5) ─────────────────────────────────

describe('external goal nodes — restart reconciliation (§9.5)', () => {
  it('suspends across a restart: the sent attempt is neither re-sent nor treated as an orphan', async () => {
    const run = new BotRun(reportDag('ext-restart'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;

    const restarted = new FakeExecutor();
    expectAwaitingExternal(await run.drive(restarted));
    expect(restarted.dispatches).toEqual([]);
    expect(restarted.stops).toEqual([]);
    expect(run.of('nodeAttemptDrained')).toEqual([]);
    // Cold attach asks the transport once whether the handoff was picked up.
    expect(restarted.probes.map((probe) => probe.attemptId)).toEqual([attemptId]);

    expect(await run.submit(attemptId, reportFiles())).toMatchObject({ ok: true });
    expect(expectTerminal(await run.drive(new FakeExecutor())).runStatus).toBe('succeeded');
  });

  it('Prepared without Sent: re-sends with the same idempotency keys inside the window', async () => {
    const run = new BotRun(reportDag('ext-prepared-resend'));
    const crashed = new FakeExecutor();
    crashed.onDispatch = () => { throw new Error('connection reset'); };
    expectAwaitingExternal(await run.drive(crashed));
    const original = crashed.dispatches[0]!;
    expect(run.openAttempt('write').phase).toBe('prepared');

    run.clock.t += V3_HANDOFF_IDEMPOTENCY_WINDOW_MS - 1;
    const restarted = new FakeExecutor();
    expectAwaitingExternal(await run.drive(restarted));
    expect(restarted.dispatches).toHaveLength(1);
    expect(restarted.dispatches[0]).toMatchObject({
      attemptId: original.attemptId,
      idempotency: original.idempotency,
      redispatch: true,
    });
    expect(run.openAttempt('write').phase).toBe('sent');
  });

  it('Prepared without Sent: an unknown in-process failure re-sends the same keys at the advertised wake time', async () => {
    const run = new BotRun(reportDag('ext-prepared-backoff'));
    const executor = new FakeExecutor();
    let failures = 1;
    executor.onDispatch = (req) => {
      if (failures-- > 0) throw new Error('timeout');
      return { kind: 'sent', handoffMessageId: 'om_retry' };
    };
    const outcome = expectAwaitingExternal(await run.drive(executor));
    expect(outcome.wakeAt).toBeGreaterThan(run.clock.t);
    expect(executor.dispatches).toHaveLength(1);

    run.clock.t = outcome.wakeAt!;
    expectAwaitingExternal(await run.drive(executor));
    expect(executor.dispatches).toHaveLength(2);
    expect(executor.dispatches[1]!.idempotency).toEqual(executor.dispatches[0]!.idempotency);
    expect(run.openAttempt('write').handoffMessageId).toBe('om_retry');
  });

  it('Prepared without Sent beyond the window blocks HANDOFF_UNCERTAIN instead of re-sending blindly', async () => {
    const run = new BotRun(reportDag('ext-prepared-uncertain'));
    const crashed = new FakeExecutor();
    crashed.onDispatch = () => { throw new Error('connection reset'); };
    await run.drive(crashed);
    const attemptId = crashed.dispatches[0]!.attemptId;

    run.clock.t += V3_HANDOFF_IDEMPOTENCY_WINDOW_MS;
    const restarted = new FakeExecutor();
    const outcome = expectTerminal(await run.drive(restarted));
    expect(outcome).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(restarted.dispatches).toEqual([]);
    expect(restarted.stops.map((stop) => [stop.attemptId, stop.reason])).toEqual([[attemptId, 'uncertain']]);
    expect(run.of('nodeBlocked')[0]).toMatchObject({ attemptId, errorCode: 'HANDOFF_UNCERTAIN' });

    // A human retry starts a fresh attempt with fresh keys.
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'write' })).toMatchObject({ kind: 'requested' });
    await run.drive(restarted);
    expect(restarted.dispatches).toHaveLength(1);
    expect(restarted.dispatches[0]!.attemptId).not.toBe(attemptId);
    expect(restarted.dispatches[0]!.idempotency).not.toEqual(crashed.dispatches[0]!.idempotency);
  });

  it('a crash inside the dispatch claim (dispatched, no intent) writes the intent and sends', async () => {
    const run = new BotRun(reportDag('ext-claim-crash'));
    const crashed = new FakeExecutor();
    crashed.onDispatch = () => { throw new Error('process died'); };
    await run.drive(crashed);
    // Simulate the crash between the two appends of the claim.
    const lines = readFileSync(run.journalPath, 'utf-8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => JSON.parse(line).type !== 'nodeHandoffPrepared');
    writeFileSync(run.journalPath, `${kept.join('\n')}\n`);
    expect(run.openAttempt('write').phase).toBe('dispatched');

    const restarted = new FakeExecutor();
    expectAwaitingExternal(await run.drive(restarted));
    expect(restarted.dispatches).toHaveLength(1);
    expect(run.openAttempt('write').phase).toBe('sent');
    expect(run.of('nodeHandoffPrepared')).toHaveLength(1);
  });

  it('Sent without Accepted: a positive probe records acceptance and re-arms the node deadline', async () => {
    const run = new BotRun(reportDag('ext-sent-probe-accepted'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;

    run.clock.t += 5_000;
    const restarted = new FakeExecutor();
    const acceptedAt = run.clock.t - 2_000;
    restarted.onProbe = () => ({ status: 'accepted', sessionId: 'sess-cold', acceptedAt });
    const outcome = expectAwaitingExternal(await run.drive(restarted));
    expect(run.of('nodeHandoffAccepted')).toEqual([
      expect.objectContaining({ attemptId, sessionId: 'sess-cold', acceptedAt, deadlineAt: acceptedAt + TIMEOUT_SEC * 1000 }),
    ]);
    expect(outcome.wakeAt).toBe(acceptedAt + TIMEOUT_SEC * 1000);
  });

  it('Sent without Accepted: waits until the acceptance deadline, then blocks HANDOFF_NOT_ACCEPTED and stops', async () => {
    const run = new BotRun(reportDag('ext-sent-not-accepted'));
    const first = expectAwaitingExternal(await run.drive(new FakeExecutor()));
    const attemptId = run.openAttempt('write').attemptId;

    run.clock.t = first.wakeAt! - 1;
    const early = new FakeExecutor();
    expectAwaitingExternal(await run.drive(early));
    expect(early.stops).toEqual([]);

    run.clock.t = first.wakeAt!;
    const due = new FakeExecutor();
    const outcome = expectTerminal(await run.drive(due));
    expect(outcome).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
    expect(due.probes.map((probe) => probe.attemptId)).toEqual([attemptId]);
    expect(due.stops.map((stop) => stop.reason)).toEqual(['notAccepted']);
    expect(run.of('nodeBlocked')[0]).toMatchObject({ attemptId, errorCode: 'HANDOFF_NOT_ACCEPTED' });
  });

  it('Accepted: the deadline survives a restart and fires NODE_TIMEOUT with a stop', async () => {
    const run = new BotRun(reportDag('ext-accepted-timeout'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const accepted = run.accept(attemptId);
    if (!accepted.ok) throw new Error('accept failed');

    run.clock.t = accepted.deadlineAt - 1;
    const restarted = new FakeExecutor();
    expect(expectAwaitingExternal(await run.drive(restarted)).wakeAt).toBe(accepted.deadlineAt);
    expect(restarted.stops).toEqual([]);

    run.clock.t = accepted.deadlineAt;
    const atDeadline = new FakeExecutor();
    expect(expectTerminal(await run.drive(atDeadline))).toMatchObject({ runStatus: 'blocked' });
    expect(atDeadline.stops).toEqual([
      expect.objectContaining({ attemptId, reason: 'timeout', sessionId: 'sess-1' }),
    ]);
    expect(run.of('nodeBlocked')[0]).toMatchObject({ attemptId, errorCode: 'NODE_TIMEOUT' });
    expect(await run.submit(attemptId, reportFiles())).toEqual({ ok: false, reason: 'timed-out' });
  });

  it('a crash-left uncommitted install is moved aside and the next submission wins', async () => {
    const run = new BotRun(reportDag('ext-install-crash'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const workDir = join(run.runDir, attemptId, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'report.md'), 'stale bytes from an interrupted install');

    const ingested = await run.submit(attemptId, reportFiles('fresh'));
    expect(ingested).toMatchObject({ ok: true, kind: 'succeeded' });
    expect(readFileSync(join(workDir, 'report.md'), 'utf-8')).toBe('fresh');
  });
});

// ─── Late / duplicate submissions and races (design §9.7) ────────────────

describe('external goal nodes — late submissions and first-wins races (§9.7)', () => {
  it('rejects a second submission for an attempt that already succeeded', async () => {
    const run = new BotRun(reportDag('ext-dup'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    expect(await run.submit(attemptId, reportFiles('first'))).toMatchObject({ ok: true });
    const after = run.events().length;
    expect(await run.submit(attemptId, reportFiles('second'))).toEqual({ ok: false, reason: 'already-succeeded' });
    expect(run.events()).toHaveLength(after);
    expect(readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8')).toBe('first');
  });

  it('two concurrent submissions for one attempt: exactly one is installed and recorded', async () => {
    const run = new BotRun(reportDag('ext-concurrent-submit'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    const results = await Promise.all([
      run.submit(attemptId, reportFiles('from-1')),
      run.submit(attemptId, reportFiles('from-2')),
    ]);
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'already-succeeded' }]);
    expect(run.of('nodeSucceeded')).toHaveLength(1);
    const installed = readFileSync(join(run.runDir, attemptId, 'work', 'report.md'), 'utf-8');
    const winnerIndex = results.findIndex((result) => result.ok);
    expect(installed).toBe(`from-${winnerIndex + 1}`);
    await readAndValidateManifest(join(run.runDir, attemptId, 'manifest.json'), join(run.runDir, attemptId, 'work'));
  });

  it('a verdict appended by another caller mid-tick is decided on, not reported as stuck', async () => {
    const run = new BotRun(reportDag('ext-mid-tick'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.accept(attemptId);
    let concurrentWriter: (() => void) | undefined = () => {
      expect(reportExternalBlocked(run.runDir, { attemptId, sessionId: 'sess-1', reason: 'gave up' })).toEqual({ ok: true });
    };
    const outcome = await run.drive(new FakeExecutor(), {
      deps: {
        now: () => {
          const write = concurrentWriter;
          concurrentWriter = undefined;
          write?.();
          return run.clock.t;
        },
      },
    });
    expect(expectTerminal(outcome)).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'write' });
  });

  it('rejects a submission from a session other than the one that accepted', async () => {
    const run = new BotRun(reportDag('ext-session'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    run.accept(attemptId, 'sess-owner');
    expect(await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-other' }))
      .toEqual({ ok: false, reason: 'session-mismatch' });
    expect(await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-owner' }))
      .toMatchObject({ ok: true, kind: 'succeeded' });
  });

  it('submission before the timeout fires wins; the deadline then has nothing to close', async () => {
    const run = new BotRun(reportDag('ext-race-submit-first'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const accepted = run.accept(attemptId);
    if (!accepted.ok) throw new Error('accept failed');
    expect(await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-1' })).toMatchObject({ ok: true });

    run.clock.t = accepted.deadlineAt + 1;
    const executor = new FakeExecutor();
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('succeeded');
    expect(executor.stops).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('a submission landing while the timeout is stopping the bot still wins', async () => {
    const run = new BotRun(reportDag('ext-race-during-timeout'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const accepted = run.accept(attemptId);
    if (!accepted.ok) throw new Error('accept failed');

    run.clock.t = accepted.deadlineAt;
    const executor = new FakeExecutor();
    let raced: unknown;
    executor.onStop = async () => {
      raced = await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-1' });
    };
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('succeeded');
    expect(raced).toMatchObject({ ok: true, kind: 'succeeded' });
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('a durable cancel request wins over a submission racing the cancellation stop', async () => {
    const run = new BotRun(reportDag('ext-race-cancel'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.accept(attemptId);
    appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'cancel-1', by: 'ou_owner' });

    const executor = new FakeExecutor();
    let raced: unknown;
    executor.onStop = async () => {
      raced = await run.submit(attemptId, reportFiles());
    };
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('cancelled');
    expect(raced).toEqual({ ok: false, reason: 'cancelled' });
    expect(executor.stops).toEqual([
      expect.objectContaining({ attemptId, reason: 'runCancelled', handoffMessageId: expect.any(String) }),
    ]);
    expect(run.of('nodeCancelled')).toEqual([
      expect.objectContaining({ attemptId, reason: 'runCancelled', cancelRequestId: 'cancel-1' }),
    ]);
    expect(openV3ExternalAttempts(run.events())).toEqual([]);
    expect(await run.submit(attemptId, reportFiles())).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('a submission committed before the cancel request stays committed', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-submit-then-cancel',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const a = run.openAttempt('a').attemptId;
    const b = run.openAttempt('b').attemptId;
    expect(await run.submit(a, { files: [{ key: 'out', name: 'out.md', data: Buffer.from('a') }] }))
      .toMatchObject({ ok: true });
    appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'cancel-2', by: 'ou_owner' });
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('cancelled');
    expect(run.snap().nodes.get('a')?.status).toBe('done');
    expect(run.snap().nodes.get('b')?.status).toBe('cancelled');
    expect(executor.stops.map((stop) => stop.attemptId)).toEqual([b]);
  });

  it('cancelling while a handoff send is in flight aborts the send, stops the attempt, and terminates', async () => {
    const run = new BotRun(reportDag('ext-cancel-in-flight'));
    const controller = new AbortController();
    const executor = new FakeExecutor();
    executor.onDispatch = (req) => new Promise((_resolve, reject) => {
      req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    });
    const outcome = expectTerminal(await run.drive(executor, { opts: { cancelSignal: controller.signal } }));
    expect(outcome.runStatus).toBe('cancelled');
    expect(executor.stops.map((stop) => stop.reason)).toEqual(['runCancelled']);
    expect(openV3ExternalAttempts(run.events())).toEqual([]);
  });
});

// ─── Reassignment ─────────────────────────────────────────────────────────

function twoBotDag(runId: string) {
  // `spare` only exists to put cli_b into the run's frozen bot set.
  return validateDag({
    schemaVersion: 2,
    runId,
    nodes: [
      { id: 'write', type: 'goal', goal: 'write', bot: 'cli_a', timeoutSec: TIMEOUT_SEC,
        outputs: { report: { path: 'report.md', kind: 'markdown' } } },
      { id: 'spare', type: 'goal', goal: 'spare', bot: 'cli_b', depends: ['write'] },
    ],
  });
}

describe('external goal nodes — reassignment', () => {
  it('reassigning a running node stops and closes its attempt; the next attempt targets the new bot', async () => {
    const run = new BotRun(twoBotDag('ext-reassign-running'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const old = executor.dispatches[0]!;
    run.accept(old.attemptId);

    const outcome = await reassignNode(run.runDir, { nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou_owner' }, {
      ...run.ctx(),
      executor,
    });
    expect(outcome).toMatchObject({ kind: 'reassigned', from: 'cli_a', to: 'cli_b', closedAttemptId: old.attemptId });
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: old.attemptId, reason: 'reassigned' })]);
    expect(await run.submit(old.attemptId, { files: [{ key: 'report', data: Buffer.from('late') }] }))
      .toEqual({ ok: false, reason: 'reassigned' });

    await run.drive(executor);
    const next = executor.dispatches[1]!;
    expect(next).toMatchObject({ nodeId: 'write', targetLarkAppId: 'cli_b', reassignedFrom: 'cli_a', attemptNumber: 2 });
    expect(next.instanceId).toBe(old.instanceId);
    expect(await run.submit(next.attemptId, { files: [{ key: 'report', data: Buffer.from('ok') }] }))
      .toMatchObject({ ok: true });
  });

  it('a submission racing the reassignment stop wins and the reassignment reports stale', async () => {
    const run = new BotRun(twoBotDag('ext-reassign-race'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    let raced: unknown;
    executor.onStop = async () => {
      raced = await run.submit(attemptId, { files: [{ key: 'report', data: Buffer.from('ok') }] });
    };
    const outcome = await reassignNode(run.runDir, { nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou_owner' }, {
      ...run.ctx(),
      executor,
    });
    expect(raced).toMatchObject({ ok: true, kind: 'succeeded' });
    expect(outcome.kind).toBe('rejected');
    expect(run.of('nodeReassigned')).toEqual([]);
    expect(run.snap().nodes.get('write')?.status).toBe('done');
  });

  it('a handoff that lands after its attempt was reassigned is stopped as well', async () => {
    const run = new BotRun(twoBotDag('ext-reassign-in-flight'));
    const executor = new FakeExecutor();
    executor.onDispatch = async (req) => {
      if (req.attemptNumber === 1) {
        await reassignNode(run.runDir, { nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou_owner' }, {
          ...run.ctx(),
          executor,
        });
      }
      return { kind: 'sent', handoffMessageId: `om_${req.attemptId}` };
    };
    await run.drive(executor);
    const first = executor.dispatches[0]!;
    expect(executor.stops).toContainEqual(expect.objectContaining({
      attemptId: first.attemptId,
      reason: 'obsolete',
      handoffMessageId: `om_${first.attemptId}`,
    }));
    expect(run.openAttempt('write')).toMatchObject({ targetLarkAppId: 'cli_b' });
  });

  it('reassigning a blocked node retries it on the new bot', async () => {
    const run = new BotRun(twoBotDag('ext-reassign-blocked'));
    const executor = new FakeExecutor();
    executor.onDispatch = () => ({ kind: 'rejected', code: 'BOT_OFFLINE' });
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('blocked');
    const blockedAttempt = executor.dispatches[0]!.attemptId;

    const outcome = await reassignNode(run.runDir, {
      nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou_owner', expectedAttemptId: blockedAttempt,
    }, run.ctx());
    expect(outcome).toMatchObject({ kind: 'reassigned', to: 'cli_b' });
    executor.onDispatch = (req) => ({ kind: 'sent', handoffMessageId: `om_${req.attemptId}` });
    expectAwaitingExternal(await run.drive(executor));
    expect(executor.dispatches[1]).toMatchObject({ targetLarkAppId: 'cli_b', attemptNumber: 2 });
  });

  it('refuses targets outside the run bot set, the current bot, and settled nodes', async () => {
    const run = new BotRun(twoBotDag('ext-reassign-refuse'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const attemptId = executor.dispatches[0]!.attemptId;
    const reassign = (to: string) => reassignNode(run.runDir, { nodeId: 'write', toLarkAppId: to, by: 'ou_owner' }, {
      ...run.ctx(),
      executor,
    });
    expect(await reassign('cli_stranger')).toEqual({ kind: 'rejected', reason: 'not-in-bot-set' });
    expect(await reassign('cli_a')).toEqual({ kind: 'rejected', reason: 'same-bot' });
    await run.submit(attemptId, { files: [{ key: 'report', data: Buffer.from('ok') }] });
    expect(await reassign('cli_b')).toEqual({ kind: 'rejected', reason: 'not-reassignable' });
    expect(executor.stops).toEqual([]);
  });
});

describe('external goal nodes — replay', () => {
  const at = (ts: number, event: V3Event): StoredEvent => ({ ...event, ts } as StoredEvent);

  it('a reassignment naming a stale attempt only re-targets; it never resets the live attempt', () => {
    const events = [
      at(1, { type: 'runStarted', runId: 'r' }),
      at(2, { type: 'nodeDispatched', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/001', nodeExecutor: 'bot' }),
      at(3, { type: 'nodeBlocked', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/001', errorClass: 'timeout', errorCode: 'NODE_TIMEOUT' }),
      at(4, {
        type: 'nodeRetryRequested', nodeId: 'w', instanceId: 'w#001',
        previousAttemptId: 'w#001/attempts/001', nextAttemptId: 'w#001/attempts/002', reason: 'blockedRetry',
      }),
      at(5, { type: 'nodeDispatched', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/002', nodeExecutor: 'bot' }),
      at(6, { type: 'nodeReassigned', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/001', from: 'cli_a', to: 'cli_b', by: 'ou' }),
    ];
    const snap = materialize(events);
    expect(snap.nodes.get('w')?.status).toBe('running');
    expect(snap.assignments.get('w')).toBe('cli_b');
    expect(openV3ExternalAttempts(events).map((attempt) => attempt.attemptId)).toEqual(['w#001/attempts/002']);
  });

  it('reassigning the live attempt returns the node to pending with its gate approval kept', () => {
    const snap = materialize([
      at(1, { type: 'runStarted', runId: 'r' }),
      at(2, { type: 'gateDispatched', nodeId: 'w', instanceId: 'w#001', waitId: 'w#001-gate' }),
      at(3, { type: 'gateResolved', nodeId: 'w', instanceId: 'w#001', waitId: 'w#001-gate', resolution: 'approved', by: 'ou' }),
      at(4, { type: 'nodeDispatched', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/001', nodeExecutor: 'bot' }),
      at(5, { type: 'nodeReassigned', nodeId: 'w', instanceId: 'w#001', attemptId: 'w#001/attempts/001', from: 'cli_a', to: 'cli_b', by: 'ou' }),
    ]);
    expect(snap.nodes.get('w')).toMatchObject({ status: 'pending', gateCleared: true, effectiveInstanceId: 'w#001' });
  });
});

// ─── Concurrency ──────────────────────────────────────────────────────────

describe('external goal nodes — concurrency caps', () => {
  it('counts the per-bot cap by resolved bot and keeps the slot across drives; no per-CLI cap', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-caps',
      nodes: [
        { id: 'a1', type: 'goal', goal: 'a1', bot: 'cli_a' },
        { id: 'a2', type: 'goal', goal: 'a2', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
        { id: 'c', type: 'goal', goal: 'c', bot: 'cli_c' },
      ],
    }));
    const executor = new FakeExecutor();
    const caps = { opts: { perBotConcurrency: 1, perCliConcurrency: 1, globalConcurrency: 4 } };
    await run.drive(executor, caps);
    // Three distinct bots of the same CLI all start; cli_a holds one slot.
    expect(executor.dispatches.map((req) => req.nodeId).sort()).toEqual(['a1', 'b', 'c']);

    await run.drive(executor, caps); // the open attempt keeps cli_a busy across drives
    expect(executor.dispatches).toHaveLength(3);

    await run.submit(run.openAttempt('a1').attemptId, { files: [{ key: 'x', name: 'x.md', data: Buffer.from('1') }] });
    await run.drive(executor, caps);
    expect(executor.dispatches.map((req) => req.nodeId)).toContain('a2');
  });

  it('an open external attempt holds a global slot across drives', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-global-cap',
      nodes: [
        { id: 'x', type: 'goal', goal: 'x', bot: 'cli_a' },
        { id: 'y', type: 'goal', goal: 'y', bot: 'cli_b' },
      ],
    }));
    const executor = new FakeExecutor();
    const caps = { opts: { globalConcurrency: 1 } };
    await run.drive(executor, caps);
    await run.drive(executor, caps);
    expect(executor.dispatches.map((req) => req.nodeId)).toEqual(['x']);
    await run.submit(run.openAttempt('x').attemptId, { files: [{ key: 'x', name: 'x.md', data: Buffer.from('1') }] });
    await run.drive(executor, caps);
    expect(executor.dispatches.map((req) => req.nodeId)).toEqual(['x', 'y']);
  });

  it('a reassigned pending node queues on its new bot', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-caps-reassigned',
      nodes: [
        { id: 'busy', type: 'goal', goal: 'busy', bot: 'cli_b' },
        { id: 'moved', type: 'goal', goal: 'moved', bot: 'cli_a', depends: ['gatekeeper'] },
        { id: 'gatekeeper', type: 'goal', goal: 'gk', bot: 'cli_c' },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    expect(await reassignNode(run.runDir, { nodeId: 'moved', toLarkAppId: 'cli_b', by: 'ou' }, run.ctx()))
      .toMatchObject({ kind: 'reassigned', from: 'cli_a', to: 'cli_b' });
    await run.submit(run.openAttempt('gatekeeper').attemptId, { files: [{ key: 'x', name: 'x.md', data: Buffer.from('1') }] });
    await run.drive(executor);
    expect(executor.dispatches.some((req) => req.nodeId === 'moved')).toBe(false); // cli_b busy
    await run.submit(run.openAttempt('busy').attemptId, { files: [{ key: 'x', name: 'x.md', data: Buffer.from('1') }] });
    await run.drive(executor);
    expect(executor.dispatches.find((req) => req.nodeId === 'moved')).toMatchObject({ targetLarkAppId: 'cli_b' });
  });

  it('ephemeral mode: two selectors resolving to the same bot share its per-bot slot', async () => {
    const base = trackTempDir(mkdtempSync(join(tmpdir(), 'v3-ext-ephemeral-')));
    let active = 0;
    let peak = 0;
    const runNode: RunNode = async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      writeFileSync(join(req.outputDir, 'out.md'), 'x');
      writeFileSync(join(req.attemptDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        status: 'ok',
        summary: 'ok',
        files: [{
          name: 'out', path: 'out.md', kind: 'markdown', bytes: 1,
          sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', mime: 'text/markdown',
        }],
      }));
      active--;
      return { status: 'ok', manifestPath: join(req.attemptDir, 'manifest.json') };
    };
    const outcome = await runWorkflow(validateDag({
      runId: 'ephemeral-same-bot',
      nodes: [
        { id: 'one', type: 'goal', goal: 'one', bot: 'alias-1' },
        { id: 'two', type: 'goal', goal: 'two', bot: 'alias-2' },
      ],
    }), {
      runNode,
      validateManifest,
      resolveBotSnapshot: () => ({ larkAppId: 'cli_same', cliId: 'claude-code', workingDir: '/tmp' }),
      attemptLeaseProvider: {
        acquire: () => ({ auditKind: 'attemptLease' }),
        closeBeforeExecution: () => {},
        drainExternallyOwned: () => ({ status: 'unknown' }),
        cleanupSettled: () => {},
      },
    }, { baseDir: base, perBotConcurrency: 1 });
    expect(expectTerminal(outcome).runStatus).toBe('succeeded');
    expect(peak).toBe(1);
  });
});

// ─── Scheduler features over external nodes ──────────────────────────────

describe('external goal nodes — loops, revisits, gates, edges, host nodes', () => {
  it('runs loop bodies as external attempts with previous-iteration feedback', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-loop',
      nodes: [{
        id: 'fix',
        type: 'loop',
        bot: 'cli_a',
        maxIterations: 3,
        body: {
          nodes: [{
            id: 'verify',
            type: 'goal',
            goal: 'verify',
            resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
          }],
        },
        exit: { node: 'verify', when: { path: 'result.passed', equals: true } },
        feedback: ['verify.result'],
        output: { from: 'verify' },
      }],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const round1 = executor.dispatches[0]!;
    expect(round1.loop).toEqual({ loopId: 'fix', iteration: 1, bodyNodeId: 'verify' });
    expect(await run.submit(round1.attemptId, { result: { passed: false } })).toMatchObject({ ok: true });

    await run.drive(executor);
    const round2 = executor.dispatches[1]!;
    expect(round2.loop).toEqual({ loopId: 'fix', iteration: 2, bodyNodeId: 'verify' });
    const feedback = round2.inputs.inputs.find((input) => input.from === 'previous.verify')!;
    expect(JSON.parse(readFileSync(feedback.path, 'utf-8'))).toEqual({ passed: false });
    expect(await run.submit(round2.attemptId, { result: { passed: true } })).toMatchObject({ ok: true });

    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('succeeded');
  });

  it('a revisit requested by a submission refreshes the ancestor and stops open attempts in the cone', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-revisit',
      nodes: [
        { id: 'draft', type: 'goal', goal: 'draft', bot: 'cli_a' },
        { id: 'review', type: 'goal', goal: 'review', bot: 'cli_b', depends: ['draft'], revisitTo: ['draft'] },
        { id: 'publish', type: 'goal', goal: 'publish', bot: 'cli_c', depends: ['draft'] },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const draft1 = run.openAttempt('draft').attemptId;
    await run.submit(draft1, { files: [{ key: 'd', name: 'draft.md', data: Buffer.from('v1') }] });
    await run.drive(executor);
    const review1 = run.openAttempt('review').attemptId;
    const publish1 = run.openAttempt('publish').attemptId;

    const revisit = await run.submit(review1, { result: { status: 'revisit', revisitTo: 'draft', reason: 'too vague' } });
    expect(revisit).toEqual({ ok: true, kind: 'revisit', toNodeId: 'draft' });
    expect(await run.submit(review1, { result: { ok: true } })).toEqual({ ok: false, reason: 'superseded' });
    // publish#001 was mid-flight inside the refreshed cone.
    expect(await run.submit(publish1, { files: [{ key: 'p', name: 'p.md', data: Buffer.from('x') }] }))
      .toEqual({ ok: false, reason: 'superseded' });

    await run.drive(executor);
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: publish1, reason: 'obsolete' })]);
    const draft2 = executor.dispatches.filter((req) => req.nodeId === 'draft')[1]!;
    expect(draft2.instanceId).toBe('draft#002');
    const reason = draft2.inputs.inputs.find((input) => input.from === 'revisit' && input.name === 'reason')!;
    expect(readFileSync(reason.path, 'utf-8')).toContain('too vague');

    await run.submit(draft2.attemptId, { files: [{ key: 'd', name: 'draft.md', data: Buffer.from('v2') }] });
    await run.drive(executor);
    await run.submit(run.openAttempt('review').attemptId, { files: [{ key: 'r', name: 'r.md', data: Buffer.from('ok') }] });
    await run.submit(run.openAttempt('publish').attemptId, { files: [{ key: 'p', name: 'p.md', data: Buffer.from('ok') }] });
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('succeeded');
  });

  it('a revisit beyond the budget blocks the requesting node for a human grant', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-revisit-budget',
      nodes: [
        { id: 'draft', type: 'goal', goal: 'draft', bot: 'cli_a' },
        { id: 'review', type: 'goal', goal: 'review', bot: 'cli_b', depends: ['draft'], revisitTo: ['draft'] },
      ],
    }));
    const executor = new FakeExecutor();
    const draftOnce = async () => {
      await run.drive(executor);
      await run.submit(run.openAttempt('draft').attemptId, { files: [{ key: 'd', name: 'd.md', data: Buffer.from('d') }] });
      await run.drive(executor);
    };
    await draftOnce();
    expect(await run.submit(run.openAttempt('review').attemptId, { result: { status: 'revisit', revisitTo: 'draft' } }))
      .toMatchObject({ ok: true, kind: 'revisit' });
    await draftOnce();
    expect(await run.submit(run.openAttempt('review').attemptId, { result: { status: 'revisit', revisitTo: 'draft' } }))
      .toEqual({ ok: true, kind: 'blocked', errorCode: 'REVISIT_BUDGET_EXHAUSTED' });
    expect(expectTerminal(await run.drive(executor))).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'review' });
  });

  it('a gate pending beside an open external attempt is reported with the external wait', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-gate',
      nodes: [
        { id: 'work', type: 'goal', goal: 'work', bot: 'cli_a' },
        { id: 'deploy', type: 'goal', goal: 'deploy', bot: 'cli_b', humanGate: { prompt: 'deploy?' } },
      ],
    }));
    const executor = new FakeExecutor();
    const outcome = expectAwaitingExternal(await run.drive(executor));
    expect(outcome.pendingWaits.map((wait) => wait.nodeId)).toEqual(['deploy']);
    expect(executor.dispatches.map((req) => req.nodeId)).toEqual(['work']);

    const gate = run.of('gateDispatched')[0]!;
    appendEvent(run.journalPath, {
      type: 'gateResolved', nodeId: 'deploy', instanceId: gate.instanceId, waitId: gate.waitId,
      resolution: 'approved', by: 'ou_owner', selected: 'approve',
    });
    await run.drive(executor);
    expect(executor.dispatches.map((req) => req.nodeId)).toEqual(['work', 'deploy']);

    // Reassigning the approved, running node does not ask the gate again.
    const deployAttempt = run.openAttempt('deploy').attemptId;
    expect(await reassignNode(run.runDir, { nodeId: 'deploy', toLarkAppId: 'cli_a', by: 'ou_owner' }, {
      ...run.ctx(),
      executor,
    })).toMatchObject({ kind: 'reassigned', closedAttemptId: deployAttempt });
    await run.submit(run.openAttempt('work').attemptId, { files: [{ key: 'w', name: 'w.md', data: Buffer.from('w') }] });
    await run.drive(executor);
    expect(run.of('gateDispatched')).toHaveLength(1);
    expect(executor.dispatches.at(-1)).toMatchObject({ nodeId: 'deploy', targetLarkAppId: 'cli_a', attemptNumber: 2 });
  });

  it('an early-release loser that is still with a bot is stopped and its submission refused', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-early-release',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
        { id: 'merge', type: 'goal', goal: 'merge', bot: 'cli_c', depends: ['a', 'b'], triggerRule: 'one_success' },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const b = run.openAttempt('b').attemptId;
    await run.submit(run.openAttempt('a').attemptId, { files: [{ key: 'a', name: 'a.md', data: Buffer.from('a') }] });
    await run.drive(executor);
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: b, reason: 'obsolete' })]);
    expect(await run.submit(b, { files: [{ key: 'b', name: 'b.md', data: Buffer.from('b') }] }))
      .toEqual({ ok: false, reason: 'cancelled' });
    expect(executor.dispatches.map((req) => req.nodeId)).toContain('merge');
    expect(openV3ExternalAttempts(run.events()).map((attempt) => attempt.nodeId)).toEqual(['merge']);
  });

  it('conditional edges and a host node read the engine-written result.json', async () => {
    const invoked: unknown[] = [];
    const hostExecutors: HostExecutorRegistry = new Map([['feishu-send', {
      parseInput: (value: unknown) => value as { larkAppId: string; chatId: string; content: string },
      executor: {
        provider: 'feishu-im',
        idempotencyTtlMs: 3_600_000,
        canonicalInput: (input: unknown) => input,
        invoke: async (input: unknown) => {
          invoked.push(input);
          return { output: { messageId: 'om_sent' }, externalRefs: { messageId: 'om_sent' } };
        },
      },
    }]]);
    const run = new BotRun(validateDag({
      runId: 'ext-edges-host',
      nodes: [
        {
          id: 'triage', type: 'goal', goal: 'triage', bot: 'cli_a',
          resultSchema: {
            type: 'object',
            properties: { route: { type: 'string', enum: ['fix', 'ship'] }, message: { type: 'string' } },
            required: ['route', 'message'],
          },
        },
        { id: 'fix', type: 'goal', goal: 'fix', bot: 'cli_b', depends: [{ from: 'triage', when: { path: 'result.route', equals: 'fix' } }] },
        {
          id: 'announce', type: 'host', executor: 'feishu-send',
          depends: [{ from: 'triage', when: { path: 'result.route', equals: 'ship' } }],
          input: {
            larkAppId: { $ref: 'context.larkAppId' },
            chatId: { $ref: 'context.chatId' },
            content: { $ref: 'triage.result.message' },
          },
          humanGate: { prompt: 'announce?' },
        },
      ],
    }));
    const executor = new FakeExecutor();
    const extra = {
      deps: { hostExecutors, hostExecutorPolicy: () => {} },
      opts: { executionContext: { params: {}, context: { larkAppId: 'cli_main', chatId: 'oc_chat' } } },
    };
    await run.drive(executor, extra);
    await run.submit(run.openAttempt('triage').attemptId, { result: { route: 'ship', message: 'v1.2 shipped' } });
    const gated = await run.drive(executor, extra);
    expect(gated.reason).toBe('awaitingGate');
    expect(run.snap().nodes.get('fix')?.status).toBe('skipped');

    const gate = run.of('gateDispatched')[0]!;
    appendEvent(run.journalPath, {
      type: 'gateResolved', nodeId: 'announce', instanceId: gate.instanceId, waitId: gate.waitId,
      resolution: 'approved', by: 'ou_owner', selected: 'approve', hostApproval: gate.hostApproval,
    });
    expect(expectTerminal(await run.drive(executor, extra)).runStatus).toBe('succeeded');
    expect(invoked).toEqual([{ larkAppId: 'cli_main', chatId: 'oc_chat', content: 'v1.2 shipped' }]);
  });

  it('a run boundary already on disk with a bot binding still open (older/raced history) is cleaned up', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-boundary-history',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
      ],
    }));
    await run.drive(new FakeExecutor());
    const a = run.openAttempt('a').attemptId;
    const b = run.openAttempt('b').attemptId;
    appendEvent(run.journalPath, {
      type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: a,
      errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', message: 'x',
    });
    appendEvent(run.journalPath, { type: 'runBlocked', blockedNodeId: 'a' });

    const executor = new FakeExecutor();
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('blocked');
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: b, reason: 'runBoundary' })]);
    expect(openV3ExternalAttempts(run.events())).toEqual([]);
  });

  it('a blocked peer brings the run to a boundary: open peer bots are stopped and requeued', async () => {
    const run = new BotRun(validateDag({
      runId: 'ext-boundary',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    const a = run.openAttempt('a').attemptId;
    const b = run.openAttempt('b').attemptId;
    reportExternalBlocked(run.runDir, { attemptId: a, reason: 'cannot' });
    expect(expectTerminal(await run.drive(executor))).toMatchObject({ runStatus: 'blocked', blockedNodeId: 'a' });
    expect(executor.stops).toEqual([expect.objectContaining({ attemptId: b, reason: 'runBoundary' })]);
    expect(run.snap().nodes.get('b')?.status).toBe('pending');
    expect(openV3ExternalAttempts(run.events())).toEqual([]);
  });
});

// ─── Adversarial-review regressions ──────────────────────────────────────

describe('external goal nodes — review regressions', () => {
  it('P1: an acceptance recorded before dispatch() returns is kept and guards the attempt', async () => {
    const run = new BotRun(reportDag('rv-accept-before-sent'));
    const executor = new FakeExecutor();
    executor.onDispatch = (req) => {
      expect(run.accept(req.attemptId, 'sess-owner')).toMatchObject({ ok: true });
      return { kind: 'sent', handoffMessageId: 'om_early' };
    };
    const outcome = expectAwaitingExternal(await run.drive(executor));
    const attempt = run.openAttempt('write');
    expect(attempt).toMatchObject({ phase: 'accepted', sessionId: 'sess-owner', handoffMessageId: 'om_early' });
    expect(outcome.wakeAt).toBe(attempt.deadlineAt);
    expect(await run.submit(attempt.attemptId, { ...reportFiles(), sessionId: 'sess-intruder' }))
      .toEqual({ ok: false, reason: 'session-mismatch' });

    // Past the acceptance window the working bot is neither blocked nor stopped.
    run.clock.t += ACCEPT_MS + 1;
    const later = new FakeExecutor();
    later.onProbe = () => ({ status: 'accepted', sessionId: 'sess-owner' });
    expectAwaitingExternal(await run.drive(later));
    expect(later.stops).toEqual([]);
    expect(run.of('nodeBlocked')).toEqual([]);
    expect(run.of('nodeHandoffAccepted')).toHaveLength(1);
    expect(await run.submit(attempt.attemptId, { ...reportFiles(), sessionId: 'sess-owner' }))
      .toMatchObject({ ok: true, kind: 'succeeded' });
  });

  it('P2-b: an unknown probe after a long outage backs off; only persistence becomes HANDOFF_UNCERTAIN', async () => {
    const run = new BotRun(reportDag('rv-probe-outage'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.clock.t += 2 * 60 * 60_000; // main daemon was down for two hours

    const flaky = new FakeExecutor();
    flaky.onProbe = () => { throw new Error('target daemon unreachable'); };
    let outcome = expectAwaitingExternal(await run.drive(flaky));
    expect(run.of('nodeBlocked')).toEqual([]);
    expect(flaky.stops).toEqual([]);
    expect(outcome.wakeAt).toBeGreaterThan(run.clock.t);

    for (let wakes = 0; ; wakes++) {
      if (wakes > 500) throw new Error('never escalated');
      run.clock.t = outcome.wakeAt!;
      const next = await run.drive(flaky);
      if (next.reason !== 'awaitingExternal') break;
      outcome = next;
    }
    expect(flaky.probes.length).toBeGreaterThan(2);
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ attemptId, errorCode: 'HANDOFF_UNCERTAIN' })]);
    expect(flaky.stops.map((stop) => stop.reason)).toEqual(['uncertain']);
  });

  it('P2-b: a probe that recovers after failing records the acceptance', async () => {
    const run = new BotRun(reportDag('rv-probe-recovers'));
    await run.drive(new FakeExecutor());
    run.clock.t += 2 * 60 * 60_000;
    const executor = new FakeExecutor();
    let failures = 1;
    executor.onProbe = () => {
      if (failures-- > 0) throw new Error('transient');
      return { status: 'accepted', sessionId: 'sess-late', acceptedAt: run.clock.t };
    };
    const first = expectAwaitingExternal(await run.drive(executor));
    run.clock.t = first.wakeAt!;
    expectAwaitingExternal(await run.drive(executor));
    expect(run.openAttempt('write')).toMatchObject({ phase: 'accepted', sessionId: 'sess-late' });
    expect(run.of('nodeBlocked')).toEqual([]);
  });

  it('R1: reassigning a lingering binding inside a blocked run requeues the node', async () => {
    const run = new BotRun(validateDag({
      runId: 'rv-blocked-reassign',
      nodes: [
        { id: 'a', type: 'goal', goal: 'a', bot: 'cli_a' },
        { id: 'b', type: 'goal', goal: 'b', bot: 'cli_b' },
        { id: 'spare', type: 'goal', goal: 'spare', bot: 'cli_c', depends: ['a'] },
      ],
    }));
    await run.drive(new FakeExecutor());
    const a = run.openAttempt('a').attemptId;
    appendEvent(run.journalPath, {
      type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId: a,
      errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED', message: 'x',
    });
    appendEvent(run.journalPath, { type: 'runBlocked', blockedNodeId: 'a' }); // older/raced boundary

    const executor = new FakeExecutor();
    expect(await reassignNode(run.runDir, { nodeId: 'b', toLarkAppId: 'cli_c', by: 'ou' }, { ...run.ctx(), executor }))
      .toMatchObject({ kind: 'reassigned' });
    expect(requestV3Retry(run.base, run.dag.runId, { nodeId: 'a' })).toMatchObject({ kind: 'requested' });
    expectAwaitingExternal(await run.drive(executor));
    expect(executor.dispatches.find((req) => req.nodeId === 'b')).toMatchObject({ targetLarkAppId: 'cli_c' });
  });

  it('E1: a dispatch that never settles (and ignores abort) is bounded and retried later', async () => {
    const run = new BotRun(reportDag('rv-hung-dispatch'));
    const executor = new FakeExecutor();
    executor.onDispatch = () => new Promise(() => {});
    const errors: string[] = [];
    const outcome = expectAwaitingExternal(await run.drive(executor, {
      opts: { externalCallTimeoutMs: 20 },
      deps: { onExternalError: (_err, ctx) => { errors.push(ctx.operation); } },
    }));
    expect(errors).toEqual(['dispatch']);
    expect(run.openAttempt('write').phase).toBe('prepared');
    expect(outcome.wakeAt).toBeGreaterThan(run.clock.t);
  });

  it('E1: a probe and a stop that never settle cannot wedge acceptance checks or cancellation', async () => {
    const run = new BotRun(reportDag('rv-hung-probe-stop'));
    await run.drive(new FakeExecutor());
    const hung = new FakeExecutor();
    hung.onProbe = () => new Promise(() => {});
    hung.onStop = () => new Promise(() => {});
    const fast = { opts: { externalCallTimeoutMs: 20 } };
    expectAwaitingExternal(await run.drive(hung, fast));
    appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'cancel-hung', by: 'ou' });
    expect(expectTerminal(await run.drive(hung, fast)).runStatus).toBe('cancelled');
    expect(hung.stops.map((stop) => stop.reason)).toEqual(['runCancelled']);
  });

  it('F1: stopping a prepared-but-unconfirmed handoff names its idempotency keys', async () => {
    const run = new BotRun(reportDag('rv-stop-prepared'));
    const crashed = new FakeExecutor();
    crashed.onDispatch = () => { throw new Error('connection reset'); };
    await run.drive(crashed);
    appendEvent(run.journalPath, { type: 'runCancelRequested', cancelRequestId: 'cancel-prep', by: 'ou' });
    const executor = new FakeExecutor();
    expect(expectTerminal(await run.drive(executor)).runStatus).toBe('cancelled');
    expect(executor.stops).toEqual([expect.objectContaining({
      reason: 'runCancelled',
      idempotency: crashed.dispatches[0]!.idempotency,
    })]);
  });

  it('C1: once accepted, a caller without the accepting session is refused', async () => {
    const run = new BotRun(reportDag('rv-session-required'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    run.accept(attemptId, 'sess-owner');
    expect(await run.submit(attemptId, reportFiles())).toEqual({ ok: false, reason: 'session-mismatch' });
    expect(reportExternalBlocked(run.runDir, { attemptId, reason: 'x' })).toEqual({ ok: false, reason: 'session-mismatch' });
    expect(recordExternalStalled(run.runDir, { attemptId }, run.ctx())).toEqual({ ok: false, reason: 'session-mismatch' });
    expect(await run.submit(attemptId, { ...reportFiles(), sessionId: 'sess-owner' })).toMatchObject({ ok: true });
  });

  it('R2: reassignment is refused for a run that does not execute nodes through bots', async () => {
    const base = trackTempDir(mkdtempSync(join(tmpdir(), 'v3-ext-r2-')));
    const runDir = join(base, 'rv-ephemeral');
    mkdirSync(runDir);
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId: 'rv-ephemeral' });
    expect(await reassignNode(runDir, { nodeId: 'write', toLarkAppId: 'cli_b', by: 'ou' }, {
      dag: reportDag('rv-ephemeral'),
      botSnapshots: new Map([['', { larkAppId: 'cli_b', cliId: 'claude-code', workingDir: '/tmp' }]]),
    })).toEqual({ kind: 'rejected', reason: 'not-bot-run' });
    expect(readJournal(join(runDir, 'journal.ndjson')).map((event) => event.type)).toEqual(['runStarted']);
  });

  it('window: stops same-key re-sends with a margin before Lark’s one-hour uuid de-duplication ends', async () => {
    const LARK_UUID_DEDUP_MS = 60 * 60_000; // Lark message `uuid` de-duplication window
    const run = new BotRun(reportDag('rv-window-margin'));
    const crashed = new FakeExecutor();
    crashed.onDispatch = () => { throw new Error('connection reset'); };
    await run.drive(crashed);
    run.clock.t = run.openAttempt('write').preparedAt! + LARK_UUID_DEDUP_MS - 5 * 60_000;
    const restarted = new FakeExecutor();
    expect(expectTerminal(await run.drive(restarted)).runStatus).toBe('blocked');
    expect(restarted.dispatches).toEqual([]);
    expect(run.of('nodeBlocked')[0]).toMatchObject({ errorCode: 'HANDOFF_UNCERTAIN' });
  });

  it('P2-c: staging left by a crash before the install intent is removed once the attempt closes', async () => {
    const run = new BotRun(reportDag('rv-staging-leftover'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    const leftover = join(run.runDir, attemptId, 'submissions', '00000000-0000-4000-8000-000000000000', 'work');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'report.md'), 'half-staged');
    expect(await run.submit(attemptId, reportFiles())).toMatchObject({ ok: true });
    expect(expectTerminal(await run.drive(new FakeExecutor())).runStatus).toBe('succeeded');
    expect(existsSync(join(run.runDir, attemptId, 'submissions'))).toBe(false);
  });

  it('M25: a submission may only revisit nodes listed in revisitTo', async () => {
    const run = new BotRun(validateDag({
      runId: 'rv-revisit-membership',
      nodes: [
        { id: 'draft', type: 'goal', goal: 'draft', bot: 'cli_a' },
        { id: 'other', type: 'goal', goal: 'other', bot: 'cli_c' },
        { id: 'review', type: 'goal', goal: 'review', bot: 'cli_b', depends: ['draft', 'other'], revisitTo: ['draft'] },
      ],
    }));
    const executor = new FakeExecutor();
    await run.drive(executor);
    await run.submit(run.openAttempt('draft').attemptId, { files: [{ key: 'd', name: 'd.md', data: Buffer.from('d') }] });
    await run.submit(run.openAttempt('other').attemptId, { files: [{ key: 'o', name: 'o.md', data: Buffer.from('o') }] });
    await run.drive(executor);
    const before = run.events().length;
    expect(await run.submit(run.openAttempt('review').attemptId, { result: { status: 'revisit', revisitTo: 'other' } }))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(run.events()).toHaveLength(before);
  });

  it('M17: a reassignment planned while idle refuses an attempt dispatched before its lock', async () => {
    const run = new BotRun(twoBotDag('rv-reassign-idle-open'));
    const executor = new FakeExecutor();
    await run.drive(executor);
    await run.submit(run.openAttempt('write').attemptId, { files: [{ key: 'report', data: Buffer.from('ok') }] });
    // `spare` is pending; a concurrent drive dispatches it mid-reassignment.
    const frozen = new Map([
      ['cli_a', { larkAppId: 'cli_a', cliId: 'claude-code' as const, workingDir: '/tmp' }],
      ['cli_b', { larkAppId: 'cli_b', cliId: 'claude-code' as const, workingDir: '/tmp' }],
    ]);
    let concurrentDispatch: (() => void) | undefined = () => {
      appendEvent(run.journalPath, {
        type: 'nodeDispatched', nodeId: 'spare', instanceId: 'spare#001', attemptId: 'spare#001/attempts/001', nodeExecutor: 'bot',
      });
    };
    const racing = new Map(frozen);
    racing.get = (key: string) => {
      const write = concurrentDispatch;
      concurrentDispatch = undefined;
      write?.();
      return frozen.get(key);
    };
    const outcome = await reassignNode(run.runDir, { nodeId: 'spare', toLarkAppId: 'cli_a', by: 'ou' }, {
      ...run.ctx(),
      botSnapshots: racing,
      executor,
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'stale-attempt' });
    expect(run.of('nodeReassigned')).toEqual([]);
    expect(executor.stops).toEqual([]);
  });

  it('M15: an acceptance time in the future is clamped to now', async () => {
    const run = new BotRun(reportDag('rv-accept-clamp'));
    await run.drive(new FakeExecutor());
    const attemptId = run.openAttempt('write').attemptId;
    expect(recordExternalAccepted(run.runDir, { attemptId, sessionId: 's', acceptedAt: run.clock.t + 3_600_000 }, run.ctx()))
      .toMatchObject({ ok: true, deadlineAt: run.clock.t + TIMEOUT_SEC * 1000 });
  });
});
