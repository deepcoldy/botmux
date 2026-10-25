import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { evaluateExpression, format, interpolate, isTruthy } from './helpers/github-expression.js';

/**
 * Midscene E2E has a single Feishu live slot for the whole repository
 * (scripts/feishu-live-queue.mjs). A pull request's run that still waits for
 * or holds the slot when the pull request is merged or closed is of no use to
 * anyone, yet it kept the slot: on 2026-10-24 a merged pull request's run held
 * it for about 3.5 hours and another one sat in the queue, until both were
 * cancelled by hand (#2259).
 *
 * The workflow relies on its own concurrency group: the closing event starts a
 * run in the pull request's group, which cancels the queued and running runs
 * there, and every job skips that closing run. These tests evaluate the real
 * trigger, group and job conditions per event, so they go red when a change
 * lets a merged pull request keep its run, lets the closing run start a suite
 * (and queue for the slot itself), or lets a close cancel another run. That
 * GitHub honours the group was checked on the pull request adding this.
 */

interface Job {
  if?: string;
  needs?: string | string[];
}

interface Workflow {
  on: { pull_request?: { types?: string[] } };
  concurrency: { group: string; 'cancel-in-progress': boolean | string };
  jobs: Record<string, Job>;
}

const workflow = parseYaml(
  readFileSync(resolve(import.meta.dirname, '../.github/workflows/midscene-e2e.yml'), 'utf8'),
) as Workflow;

const REPOSITORY = 'deepcoldy/botmux';
// GitHub's `pull_request` activity types when `types` is omitted.
const DEFAULT_PR_TYPES = ['opened', 'synchronize', 'reopened'];
const SUITE_JOBS = ['dashboard', 'feishu-queue', 'feishu'];

interface GithubContext {
  event_name: string;
  repository: string;
  run_id: number;
  event: Record<string, unknown>;
}

let nextRunId = 1000;

function pullRequestEvent(action: string, number: number, headRepo = REPOSITORY): GithubContext {
  return {
    event_name: 'pull_request',
    repository: REPOSITORY,
    run_id: nextRunId++,
    event: { action, number, pull_request: { number, head: { repo: { full_name: headRepo } } } },
  };
}

function manualRun(): GithubContext {
  return { event_name: 'workflow_dispatch', repository: REPOSITORY, run_id: nextRunId++, event: { inputs: {} } };
}

function startsRun(action: string): boolean {
  return (workflow.on.pull_request?.types ?? DEFAULT_PR_TYPES).includes(action);
}

const unwrap = (value: string) => value.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1');

function concurrency(github: GithubContext) {
  const context = { github, inputs: {} };
  const cancel = workflow.concurrency['cancel-in-progress'];
  return {
    group: interpolate(workflow.concurrency.group, context, { format }),
    cancelInProgress: typeof cancel === 'string' ? isTruthy(evaluateExpression(unwrap(cancel), context, { format })) : cancel === true,
  };
}

const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\s*\(/i;

/** The jobs GitHub starts for this event, assuming every job that runs succeeds. */
function jobsThatRun(github: GithubContext): string[] {
  const results: Record<string, 'success' | 'skipped'> = {};
  const visit = (id: string): 'success' | 'skipped' => {
    if (results[id]) return results[id];
    const job = workflow.jobs[id];
    const needs = job.needs === undefined ? [] : [job.needs].flat();
    const needResults = needs.map(visit);
    const success = () => needResults.every((result) => result === 'success');
    const functions = { always: () => true, cancelled: () => false, failure: () => false, success, format };
    const condition = unwrap(job.if ?? 'success()');
    const context = {
      github,
      inputs: (github.event.inputs as Record<string, unknown> | undefined) ?? {},
      needs: Object.fromEntries(needs.map((need, i) => [need, { result: needResults[i], outputs: {} }])),
    };
    let runs = isTruthy(evaluateExpression(condition, context, functions));
    // Without a status function GitHub adds success(): a job whose needs did
    // not all succeed is skipped.
    if (!STATUS_FUNCTION.test(condition)) runs = runs && success();
    return (results[id] = runs ? 'success' : 'skipped');
  };
  return Object.keys(workflow.jobs).filter((id) => visit(id) === 'success');
}

describe('Midscene E2E: a merged or closed pull request gives up the Feishu live slot', () => {
  it('merging or closing a pull request starts a run, as pushes still do', () => {
    expect(startsRun('closed')).toBe(true);
    for (const action of DEFAULT_PR_TYPES) expect(startsRun(action), action).toBe(true);
  });

  it("the closing run joins the pull request's group, so its queued or running run is cancelled", () => {
    const close = concurrency(pullRequestEvent('closed', 7));
    expect(close.group).toBe(concurrency(pullRequestEvent('synchronize', 7)).group);
    expect(close.cancelInProgress).toBe(true);
  });

  it("a close cancels no other pull request's run and no manual run", () => {
    const close = concurrency(pullRequestEvent('closed', 7));
    expect(concurrency(pullRequestEvent('synchronize', 8)).group).not.toBe(close.group);
    expect(concurrency(manualRun()).group).not.toBe(close.group);
    expect(concurrency(manualRun()).group).not.toBe(concurrency(manualRun()).group);
  });

  it('the closing run starts no job, so it never queues for the slot itself', () => {
    expect(jobsThatRun(pullRequestEvent('closed', 7))).toEqual([]);
    expect(jobsThatRun(pullRequestEvent('closed', 7, 'someone/botmux'))).toEqual([]);
  });

  it('pushes and manual runs still start both suites; pushes from forks still start none', () => {
    for (const action of DEFAULT_PR_TYPES) {
      expect(jobsThatRun(pullRequestEvent(action, 7)), action).toEqual(expect.arrayContaining(SUITE_JOBS));
    }
    expect(jobsThatRun(manualRun())).toEqual(expect.arrayContaining(SUITE_JOBS));
    expect(jobsThatRun(pullRequestEvent('synchronize', 7, 'someone/botmux'))).toEqual([]);
  });
});

// The checks above are only as good as this evaluator: one that misreads an
// expression could make them pass vacuously.
describe('GitHub expression evaluator', () => {
  const github = { event: { action: 'Closed' }, run_id: 9 };
  const evaluate = (source: string) => evaluateExpression(source, { github }, { format });

  it('binds && tighter than || and yields operands, not booleans', () => {
    expect(evaluate('true || false && false')).toBe(true);
    expect(evaluate('(true || false) && false')).toBe(false);
    expect(evaluate("null && 'a' || 'b'")).toBe('b');
    expect(evaluate("7 && format('pr-{0}', 7) || github.run_id")).toBe('pr-7');
    expect(evaluate("github.event.number && format('pr-{0}', github.event.number) || github.run_id")).toBe(9);
  });

  it('compares loosely: strings ignore case, a missing property is null', () => {
    expect(evaluate("github.event.action == 'closed'")).toBe(true);
    expect(evaluate("github.event.missing != 'closed'")).toBe(true);
    expect(evaluate("!(github.event.missing == 'closed')")).toBe(true);
    expect(evaluate('github.event.missing == null')).toBe(true);
  });

  it('throws on syntax, functions and contexts it does not support', () => {
    expect(() => evaluate('github.run_id > 1')).toThrow(/Unsupported expression syntax/);
    expect(() => evaluate("contains(github.event.action, 'c')")).toThrow(/Unsupported function/);
    expect(() => evaluate('secrets.TOKEN')).toThrow(/Unknown context/);
  });
});
