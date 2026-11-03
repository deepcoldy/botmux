/**
 * Structured submission of a bot-executed workflow node (design 2026-11-03
 * §7.2, §8, §9.7): `botmux report --dispatch-root <handoff> --output …
 * --result-file …` argument rules and size bounds, the executing bot's
 * daemon pre-check, and the end-to-end ingest through the main bot's event
 * route against a REAL run journal — valid, invalid then fixed in the same
 * turn, blocked, and late after cancellation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORKFLOW_SUBMISSION_MAX_FILE_BYTES,
  WORKFLOW_SUBMISSION_MAX_FILES,
  WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES,
  decodeWorkflowSubmission,
  parseWorkflowReportArgs,
  precheckWorkflowSubmission,
  readWorkflowSubmissionFiles,
} from '../src/core/workflow-node-report.js';
import { BotRun, cleanupBotRuns, expectTerminal, reportDag } from './helpers/v3-external-harness.js';
import { CHAT, MAIN, SECRET, handoffWorld, nonceOf, orchestratorEvent, targetReport } from './helpers/workflow-handoff-harness.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleWorkflowHandoffEvent } from '../src/core/workflow-handoff-routes.js';
import { readDispatchRegistryLoose } from '../src/core/workflow-handoff-binding.js';
import { requestV3RunCancel } from '../src/workflows/v3/daemon-run.js';

afterEach(() => cleanupBotRuns());

describe('report CLI arguments', () => {
  it('parses repeatable --output <key>=<path> and one --result-file', () => {
    expect(parseWorkflowReportArgs(['--status', 'completed', '--output', 'report=out/r.md', '--output=log=run.log', '--result-file', 'result.json']))
      .toEqual({ ok: true, value: { outputs: [{ key: 'report', path: 'out/r.md' }, { key: 'log', path: 'run.log' }], resultFile: 'result.json' } });
    expect(parseWorkflowReportArgs(['--status', 'completed'])).toEqual({ ok: true, value: { outputs: [] } });
  });

  it.each([
    [['--output', 'report']],
    [['--output', '=r.md']],
    [['--output', 'bad key=r.md']],
    [['--output', 'r=a.md', '--output', 'r=b.md']],
    [['--result-file', 'a.json', '--result-file', 'b.json']],
    [['--output']],
    [['--output', '--status']],
    [Array.from({ length: WORKFLOW_SUBMISSION_MAX_FILES + 1 }, (_v, i) => ['--output', `k${i}=f${i}`]).flat()],
  ])('refuses %j', (args) => {
    expect(parseWorkflowReportArgs(args)).toMatchObject({ ok: false });
  });

  it('checks sizes before reading anything, per file and per submission', () => {
    const read = vi.fn((_path: string) => Buffer.from('x'));
    const sizes: Record<string, number> = { big: WORKFLOW_SUBMISSION_MAX_FILE_BYTES + 1, half: WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES / 2, small: 3 };
    const reader = { size: (path: string) => ({ ok: true as const, bytes: sizes[path]! }), read };
    expect(readWorkflowSubmissionFiles({ outputs: [{ key: 'a', path: 'big' }] }, reader)).toMatchObject({ ok: false });
    expect(read).not.toHaveBeenCalled();
    // Two files at the per-file bound would pass one by one but not together
    // with a third.
    const total = readWorkflowSubmissionFiles({
      outputs: [{ key: 'a', path: 'half' }, { key: 'b', path: 'half' }, { key: 'c', path: 'small' }],
    }, { size: (path) => ({ ok: true, bytes: Math.min(sizes[path]!, WORKFLOW_SUBMISSION_MAX_FILE_BYTES) }), read });
    expect(total).toMatchObject({ ok: false });
    const ok = readWorkflowSubmissionFiles({ outputs: [{ key: 'a', path: 'small' }], resultFile: 'small' }, reader);
    expect(ok).toEqual({ ok: true, value: { files: [{ key: 'a', name: 'small', data: Buffer.from('x').toString('base64') }], resultText: 'x' } });
  });

  it('daemons re-check the decoded bytes, never trusting the CLI', () => {
    const big = Buffer.alloc(WORKFLOW_SUBMISSION_MAX_FILE_BYTES + 1).toString('base64');
    expect(decodeWorkflowSubmission({ files: [{ key: 'a', name: 'a', data: big }] })).toEqual({ ok: false, error: 'file_too_large' });
    // M11: files each within the per-file bound but together over the total.
    const atBound = Buffer.alloc(WORKFLOW_SUBMISSION_MAX_FILE_BYTES).toString('base64');
    const count = Math.floor(WORKFLOW_SUBMISSION_MAX_TOTAL_BYTES / WORKFLOW_SUBMISSION_MAX_FILE_BYTES) + 1;
    expect(decodeWorkflowSubmission({ files: Array.from({ length: count }, (_v, i) => ({ key: `k${i}`, name: 'f', data: atBound })) }))
      .toEqual({ ok: false, error: 'submission_too_large' });
    expect(decodeWorkflowSubmission({ files: [{ key: '../x', name: 'a', data: '' }] })).toEqual({ ok: false, error: 'bad_output_key' });
    expect(decodeWorkflowSubmission({ files: 'nope' })).toEqual({ ok: false, error: 'bad_files' });
  });
});

describe('pre-check against the node contract', () => {
  const node = reportDag('pc').nodes[0]! as any;

  it('lists every certain problem at once', () => {
    const result = precheckWorkflowSubmission(node, { files: [{ key: 'extra' }], resultText: '{"other":1}' });
    expect(result.ok).toBe(false);
    const problems = (result as { problems: string[] }).problems.join('\n');
    expect(problems).toContain('extra'); // undeclared key
    expect(problems).toContain('report'); // missing declared output
    expect(problems).toContain('message'); // missing required result field
  });

  it('refuses a result that is not a JSON object, or a missing result for a schema node', () => {
    expect(precheckWorkflowSubmission(node, { files: [{ key: 'report' }], resultText: '[1]' })).toMatchObject({ ok: false });
    expect(precheckWorkflowSubmission(node, { files: [{ key: 'report' }], resultText: '{' })).toMatchObject({ ok: false });
    expect(precheckWorkflowSubmission(node, { files: [{ key: 'report' }] })).toMatchObject({ ok: false });
  });

  it('passes a complete submission and returns the parsed result', () => {
    expect(precheckWorkflowSubmission(node, { files: [{ key: 'report' }], resultText: '{"message":"ok"}' }))
      .toEqual({ ok: true, result: { message: 'ok' } });
  });
});

/** A bot run with one node handed to cli_a and accepted by session sess-a. */
async function acceptedRun(runId: string) {
  const run = new BotRun(reportDag(runId));
  const world = handoffWorld();
  await run.drive(world.executor, { opts: { chatBinding: { larkAppId: MAIN, chatId: CHAT, chatType: 'group', rootMessageId: 'om_main' } } });
  const attempt = run.openAttempt('write');
  const orchestrator = orchestratorEvent(world, run.base, run.dag, () => run.clock.t);
  expect(await orchestrator.route({ kind: 'accepted', dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a', acceptedAt: run.clock.t }))
    .toMatchObject({ status: 200 });
  const target = targetReport(world, 'cli_a', orchestrator.route);
  const session = { sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId! };
  return { run, world, attempt, orchestrator, target, session };
}

const file = (key: string, content: string, name = `${key}.md`) => ({ key, name, data: Buffer.from(content).toString('base64') });

describe('end-to-end submission through the main bot\'s daemon', () => {
  it('an invalid submission is refused with what to fix; the corrected one in the same turn completes the node', async () => {
    const { run, attempt, target, session, orchestrator } = await acceptedRun('rep-fix');
    const before = run.events().length;
    const first = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'draft',
      files: [file('report', '# r')], resultText: '{"message":42}',
    }, session);
    expect(first.status).toBe(422);
    expect(first.body.problems).toEqual(expect.arrayContaining([expect.stringContaining('message')]));
    expect(run.events()).toHaveLength(before);
    expect(run.snap().nodes.get('write')?.status).toBe('running');
    expect(target.cards).toEqual([]);

    run.clock.t += 90_000;
    const second = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'risk summary',
      files: [file('report', '# risks')], resultText: '{"message":"ok"}',
    }, session);
    expect(second).toEqual({ status: 200, body: { ok: true, outcome: 'succeeded', elapsedMs: 90_000 } });
    expect(target.submitted).toEqual(['sess-a']);
    expect(target.cards).toHaveLength(1);
    expect(target.cards[0]![1]).toEqual({ summary: 'risk summary', files: [{ key: 'report', name: 'report.md', bytes: 7 }], elapsedMs: 90_000 });
    expect(orchestrator.drives.at(-1)).toBe('rep-fix');
    expect(expectTerminal(await run.drive(handoffWorld().executor)).runStatus).toBe('succeeded');
  });

  it('the executing bot\'s daemon pre-checks the node contract before bothering the main bot', async () => {
    const { run, attempt, world, orchestrator, session } = await acceptedRun('rep-precheck');
    const forwarded = vi.fn(orchestrator.route);
    const target = targetReport(world, 'cli_a', forwarded, { loadNodeContract: () => run.dag.nodes[0] as any });
    const result = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', files: [file('notes', 'x')], resultText: '{"message":"ok"}',
    }, session);
    expect(result).toMatchObject({ status: 422, body: { error: 'invalid' } });
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('a duplicate after success is refused as already completed', async () => {
    const { attempt, target, session } = await acceptedRun('rep-dup');
    const submission = { dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 's', files: [file('report', 'x')], resultText: '{"message":"ok"}' };
    expect((await target.report(submission, session)).status).toBe(200);
    expect(await target.report(submission, session)).toMatchObject({ status: 409, body: { error: 'already-succeeded' } });
  });

  it('a submission after the run was cancelled is refused and changes nothing', async () => {
    const { run, attempt, target, session } = await acceptedRun('rep-late');
    expect(requestV3RunCancel(run.base, run.dag.runId, { by: 'ou_owner' })).toMatchObject({ kind: 'requested' });
    const before = run.events().length;
    const late = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'late', files: [file('report', 'x')], resultText: '{"message":"ok"}',
    }, session);
    expect(late).toMatchObject({ status: 409, body: { error: 'cancelled' } });
    expect(run.events()).toHaveLength(before);
    expect(target.cards).toEqual([]);
  });

  it('a submission from another session than the accepting one is refused', async () => {
    const { attempt, target } = await acceptedRun('rep-session');
    const result = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', files: [file('report', 'x')], resultText: '{"message":"ok"}',
    }, { sessionId: 'sess-other', rootMessageId: attempt.nodeCardMessageId! });
    expect(result).toMatchObject({ status: 409, body: { error: 'session-mismatch' } });
  });

  it('--status blocked settles the node as BOT_REPORTED_BLOCKED with the bot\'s reason', async () => {
    const { run, attempt, target, session } = await acceptedRun('rep-blocked');
    expect(await target.report({ dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'no access to the repo' }, session))
      .toMatchObject({ status: 200, body: { outcome: 'blocked' } });
    expect(run.of('nodeBlocked')).toEqual([expect.objectContaining({ errorCode: 'BOT_REPORTED_BLOCKED', message: 'no access to the repo' })]);
  });

  it('a progress note changes nothing in the run', async () => {
    const { run, attempt, target, session } = await acceptedRun('rep-progress');
    const before = run.events().length;
    expect(await target.report({ dispatchRoot: attempt.handoffMessageId, status: 'in_progress', content: 'halfway' }, session))
      .toMatchObject({ status: 200, body: { outcome: 'progress' } });
    expect(run.events()).toHaveLength(before);
  });

  it.each([
    ['files on an ordinary (non-workflow) dispatch root', { dispatchRoot: 'om_ordinary' }, {}, 404, 'not_workflow_handoff'],
    ['files without --status completed', { status: 'in_progress' }, {}, 400, 'files_require_completed'],
    ['a session outside the node topic', {}, { rootMessageId: 'om_elsewhere' }, 403, 'handoff_route_mismatch'],
    ['another bot\'s session', {}, { larkAppId: 'cli_b' }, 403, 'handoff_target_mismatch'],
  ])('refuses %s', async (_label, bodyOverride, sessionOverride, status, error) => {
    const { attempt, target, session } = await acceptedRun(`rep-refuse-${status}-${error.length}`);
    const result = await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', files: [file('report', 'x')], resultText: '{"message":"ok"}',
      ...bodyOverride,
    }, { ...session, ...sessionOverride });
    expect(result).toMatchObject({ status, body: { ok: false, error } });
  });

  it('a stalled turn is recorded for display only', async () => {
    const { run, attempt, orchestrator } = await acceptedRun('rep-stalled');
    expect(await orchestrator.route({ kind: 'stalled', dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a', at: run.clock.t }))
      .toMatchObject({ status: 200 });
    expect(run.openAttempt('write').stalledAt).toBe(run.clock.t);
    expect(run.snap().nodes.get('write')?.status).toBe('running');
  });

  it('P2-1: once the attempt was stopped (binding revoked) a report is refused, even if the journal still has it open', async () => {
    const { run, attempt, world, target, session } = await acceptedRun('rep-revoked');
    await world.executor.stop({
      runId: run.dag.runId, nodeId: 'write', instanceId: attempt.instanceId, attemptId: attempt.attemptId, revision: 1,
      targetLarkAppId: 'cli_a', placement: 'topic', reason: 'timeout', idempotency: attempt.idempotency,
      handoffMessageId: attempt.handoffMessageId, sessionId: 'sess-a',
    });
    const before = run.events().length;
    expect(await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', files: [file('report', 'x')], resultText: '{"message":"ok"}',
    }, session)).toMatchObject({ status: 409, body: { error: 'handoff_revoked' } });
    expect(run.events()).toHaveLength(before);
  });

  it('M6: a session that registered the handoff by its nonce can report even if the id link was never written', async () => {
    const { run, attempt, world, orchestrator } = await acceptedRun('rep-nonce-fallback');
    // Simulate a main bot that crashed between the send and the link write.
    const registry = readDispatchRegistryLoose(world.dataDir) as Record<string, any>;
    delete registry[attempt.handoffMessageId!];
    delete registry[`workflow-handoff:${nonceOf(attempt)}`].message;
    writeFileSync(join(world.dataDir, 'orchestrate-dispatch.json'), JSON.stringify(registry));
    const target = targetReport(world, 'cli_a', orchestrator.route);
    const session = { sessionId: 'sess-a', rootMessageId: attempt.nodeCardMessageId!, workflowNode: { handoffMessageId: attempt.handoffMessageId!, nonce: nonceOf(attempt) } };
    expect(await target.report({
      dispatchRoot: attempt.handoffMessageId, status: 'completed', content: 'x', files: [file('report', 'x')], resultText: '{"message":"ok"}',
    }, session)).toMatchObject({ status: 200, body: { outcome: 'succeeded' } });
    // Without the marker the unlinked id is not a workflow handoff.
    expect(await target.report({ dispatchRoot: attempt.handoffMessageId, status: 'blocked', content: 'x' }, { ...session, workflowNode: undefined }))
      .toMatchObject({ status: 404 });
    void run;
  });

  it('M8: the event route refuses a run that is not bot-executed', async () => {
    const { attempt, world, run } = await acceptedRun('rep-not-bot');
    const result = await handleWorkflowHandoffEvent(
      { kind: 'stalled', dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' },
      {
        selfLarkAppId: MAIN,
        baseDir: run.base,
        readRegistry: () => readDispatchRegistryLoose(world.dataDir),
        secret: () => SECRET,
        loadRun: () => ({ dag: run.dag }),
        drive: () => {},
      },
    );
    expect(result).toMatchObject({ status: 409, body: { error: 'run_not_bot_executed' } });
    expect(run.openAttempt('write').stalledAt).toBeUndefined();
  });

  it('the event route only serves its own runs', async () => {
    const { attempt, world, run } = await acceptedRun('rep-owner');
    const wrongDaemon = await handleWorkflowHandoffEvent(
      { kind: 'stalled', dispatchRoot: attempt.handoffMessageId, sessionId: 'sess-a' },
      {
        selfLarkAppId: 'cli_b',
        baseDir: run.base,
        readRegistry: () => readDispatchRegistryLoose(world.dataDir),
        secret: () => SECRET,
        loadRun: () => ({ dag: run.dag, nodeExecutor: 'bot' }),
        drive: () => {},
      },
    );
    expect(wrongDaemon).toMatchObject({ status: 409, body: { error: 'wrong_daemon' } });
    expect(run.openAttempt('write').stalledAt).toBeUndefined();
  });
});
