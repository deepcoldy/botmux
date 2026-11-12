import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { evaluateExpression, format, interpolate, isTruthy } from './helpers/github-expression.js';

/**
 * Midscene E2E runs after merge, on master pushes, not on pull requests: the
 * Feishu live suite drives one shared set of bots, so pull requests waited
 * hours for the one live slot (scripts/feishu-live-queue.mjs) and a merged
 * pull request's run once held it for about 3.5 hours (#2259). A failed
 * master run comments on the pull requests it covers instead.
 *
 * These tests evaluate the real triggers, concurrency group and job
 * conditions per event, so they go red when pull requests start runs again,
 * when a master merge cancels the master run that is testing earlier merges,
 * or when a failure stops reaching the notification job. When the model quota
 * is used up (#2670) the suites are skipped and nobody is notified.
 */

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on: { pull_request?: unknown; pull_request_target?: unknown; push?: { branches?: string[] }; workflow_dispatch?: unknown };
  concurrency: { group: string; 'cancel-in-progress': boolean | string };
  jobs: Record<string, Job>;
}

const workflow = parseYaml(
  readFileSync(resolve(import.meta.dirname, '../.github/workflows/midscene-e2e.yml'), 'utf8'),
) as Workflow;

const REPOSITORY = 'deepcoldy/botmux';
// deploy-report also depends on a job output, which this harness leaves empty.
const SUITE_JOBS = ['model-check', 'dashboard', 'feishu-queue', 'feishu', 'midscene-report'];
const NOTIFY_JOB = 'notify-failure';

interface GithubContext {
  event_name: string;
  repository: string;
  ref_name: string;
  run_id: number;
  event: Record<string, unknown>;
}

let nextRunId = 1000;

function masterPush(): GithubContext {
  return { event_name: 'push', repository: REPOSITORY, ref_name: 'master', run_id: nextRunId++, event: {} };
}

function manualRun(ref = 'master'): GithubContext {
  return { event_name: 'workflow_dispatch', repository: REPOSITORY, ref_name: ref, run_id: nextRunId++, event: { inputs: {} } };
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

type Result = 'success' | 'failure' | 'skipped';

/**
 * The jobs GitHub starts for this event. A job that runs ends with
 * `outcomes[id]` (default success) and sets `outputs[id]`; a skipped job has
 * no outputs.
 */
function jobsThatRun(
  github: GithubContext,
  outcomes: Record<string, Result> = {},
  outputs: Record<string, Record<string, string>> = {},
): string[] {
  const results: Record<string, Result> = {};
  const visit = (id: string): Result => {
    if (results[id]) return results[id];
    const job = workflow.jobs[id];
    const needs = job.needs === undefined ? [] : [job.needs].flat();
    const needResults = needs.map(visit);
    const success = () => needResults.every((result) => result === 'success');
    const failure = () => needResults.some((result) => result === 'failure');
    const functions = { always: () => true, cancelled: () => false, failure, success, format };
    const condition = unwrap(job.if ?? 'success()');
    const context = {
      github,
      inputs: (github.event.inputs as Record<string, unknown> | undefined) ?? {},
      needs: Object.fromEntries(needs.map((need, i) => [
        need,
        { result: needResults[i], outputs: needResults[i] === 'skipped' ? {} : outputs[need] ?? {} },
      ])),
    };
    let runs = isTruthy(evaluateExpression(condition, context, functions));
    // Without a status function GitHub adds success(): a job whose needs did
    // not all succeed is skipped.
    if (!STATUS_FUNCTION.test(condition)) runs = runs && success();
    return (results[id] = runs ? (outcomes[id] ?? 'success') : 'skipped');
  };
  return Object.keys(workflow.jobs).filter((id) => visit(id) !== 'skipped');
}

describe('Midscene E2E runs after merge on master', () => {
  it('pull requests start no run; master pushes and manual runs do', () => {
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on.push?.branches).toEqual(['master']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('a later merge never cancels the master run testing earlier merges', () => {
    const first = concurrency(masterPush());
    expect(concurrency(masterPush()).group).toBe(first.group);
    expect(first.cancelInProgress).toBe(false);
  });

  it('manual runs neither join the master group nor each other', () => {
    const master = concurrency(masterPush()).group;
    expect(concurrency(manualRun()).group).not.toBe(master);
    expect(concurrency(manualRun()).group).not.toBe(concurrency(manualRun()).group);
  });

  it('master pushes and manual runs start every suite; a green run notifies nobody', () => {
    for (const github of [masterPush(), manualRun(), manualRun('fix/branch')]) {
      expect(jobsThatRun(github)).toEqual(SUITE_JOBS);
    }
  });

  it('a failed master run reaches the notification job, whichever suite failed', () => {
    for (const failed of ['model-check', 'dashboard', 'feishu-queue', 'feishu', 'midscene-report']) {
      expect(jobsThatRun(masterPush(), { [failed]: 'failure' }), failed).toContain(NOTIFY_JOB);
    }
  });

  it('a failed manual run comments on no pull request', () => {
    expect(jobsThatRun(manualRun(), { feishu: 'failure' })).not.toContain(NOTIFY_JOB);
  });

  it('an exhausted model quota skips every suite, the slot wait and the notification', () => {
    const exhausted = { 'model-check': { quota_exhausted: 'true', quota_reset: '11-15 16:00:00 UTC' } };
    for (const github of [masterPush(), manualRun()]) {
      expect(jobsThatRun(github, {}, exhausted)).toEqual(['model-check']);
    }
    // A model check that fails for another reason still notifies.
    expect(jobsThatRun(masterPush(), { 'model-check': 'failure' })).toEqual(['model-check', NOTIFY_JOB]);
  });
});

describe('Midscene model quota wiring (#2670)', () => {
  const jobStep = (jobId: string, stepId: string) => workflow.jobs[jobId].steps!.find((step) => step.id === stepId)!;
  const jobOutput = (jobId: string, name: string, steps: Record<string, unknown>) =>
    interpolate(workflow.jobs[jobId].outputs![name], { steps }, { format });

  it('the model-check job exports the preflight\'s quota flag and lets an exhausted quota pass', () => {
    const steps = { model: { outputs: { quota_exhausted: 'true', quota_reset: '11-15 16:00:00 UTC' } } };
    expect(jobOutput('model-check', 'quota_exhausted', steps)).toBe('true');
    expect(jobOutput('model-check', 'quota_reset', steps)).toBe('11-15 16:00:00 UTC');
    expect(jobStep('model-check', 'model').run).toMatch(/check-midscene-model\.mjs --allow-quota-exhausted\b/);
  });

  it('the Feishu job, which checks again after the slot wait, fails on the quota but exports the flag', () => {
    const steps = { model: { outputs: { quota_exhausted: 'true', quota_reset: '11-15 16:00:00 UTC' } } };
    expect(jobOutput('feishu', 'quota_exhausted', steps)).toBe('true');
    expect(jobStep('feishu', 'model').run).toMatch(/check-midscene-model\.mjs\s*$/);
  });

  it('the notification receives the results and the Feishu quota flag', () => {
    const notifyStep = workflow.jobs[NOTIFY_JOB].steps!.find((step) => step.run?.includes('midscene-notify-failure.mjs'))!;
    const needs = {
      'model-check': { result: 'success', outputs: {} },
      dashboard: { result: 'success', outputs: {} },
      'feishu-queue': { result: 'success', outputs: {} },
      feishu: { result: 'failure', outputs: { quota_exhausted: 'true', quota_reset: '11-15 16:00:00 UTC' } },
      'midscene-report': { result: 'success', outputs: {} },
      'deploy-report': { result: 'success', outputs: {} },
    };
    const env = Object.fromEntries(Object.entries(notifyStep.env ?? {}).map(([key, value]) => [
      key,
      interpolate(String(value), { github: masterPush(), needs, runner: { temp: '/tmp' } }, { format }),
    ]));
    expect(env).toMatchObject({
      MODEL_CHECK_RESULT: 'success',
      FEISHU_RESULT: 'failure',
      FEISHU_QUOTA_EXHAUSTED: 'true',
      QUOTA_RESET: '11-15 16:00:00 UTC',
    });
  });

  it('the fallback for a pruned Pages report names the site artifact this run uploads', () => {
    const reportSteps = workflow.jobs['midscene-report'].steps!;
    const upload = reportSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@') && step.with?.path?.endsWith('/midscene-site'));
    const uploaded = upload?.with?.name;
    expect(uploaded).toBeTruthy();
    const summary = reportSteps.find((step) => step.run?.includes('render-midscene-summary.mjs'))!.run!;
    expect(summary.match(/--site-artifact-name\s+(\S+)/)?.[1]).toBe(uploaded);
    const notifyStep = workflow.jobs[NOTIFY_JOB].steps!.find((step) => step.run?.includes('midscene-notify-failure.mjs'))!;
    expect(notifyStep.env?.SITE_ARTIFACT_NAME).toBe(uploaded);
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
