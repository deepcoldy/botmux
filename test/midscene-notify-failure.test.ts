import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alreadyNotified,
  assessFailures,
  commentBody,
  failureReasons,
  feishuJobRan,
  mergedPullRequests,
  notify,
  previousTestedSha,
  problemCases,
} from '../scripts/midscene-notify-failure.mjs';

const run = (id: number, head_sha: string, conclusion: string | null, event = 'push', status = 'completed') => ({
  id,
  head_sha,
  event,
  status,
  conclusion,
});

const pull = (number: number, login: string, merged = true, base = 'master') => ({
  number,
  merged_at: merged ? '2026-10-30T00:00:00Z' : null,
  base: { ref: base },
  user: { login },
  html_url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
});

describe('Midscene master failure notification', () => {
  it('starts the range after the last master run that tested something', () => {
    const runs = [
      run(900, 'self', null, 'push', 'in_progress'),
      run(890, 'superseded', 'cancelled'),
      run(880, 'manual', 'failure', 'workflow_dispatch'),
      run(870, 'tested', 'failure'),
      run(860, 'older', 'success'),
    ];
    expect(previousTestedSha(runs, 900)).toBe('tested');
    // A later run (a re-run listed above) never bounds an earlier one.
    expect(previousTestedSha([run(950, 'later', 'success'), ...runs], 900)).toBe('tested');
    expect(previousTestedSha([run(890, 'superseded', 'cancelled')], 900)).toBeNull();
  });

  it('collects each pull request merged into master once, skipping unmerged and other bases', () => {
    const pulls = mergedPullRequests(
      [
        { sha: 'a', pulls: [pull(1, 'alice'), pull(9, 'x', false)] },
        { sha: 'b', pulls: [pull(1, 'alice'), pull(2, 'bob', true, 'release')] },
        { sha: 'c', pulls: [pull(3, 'carol')] },
      ],
      'master',
    );
    expect(pulls.map((p) => [p.number, p.author, p.sha])).toEqual([
      [1, 'alice', 'a'],
      [3, 'carol', 'c'],
    ]);
  });

  it('names failed cases before cases that never ran, and nothing else', () => {
    const cases = problemCases({
      cases: [
        { name: 'ok', status: 'success' },
        { name: 'late', status: 'not-run' },
        { name: 'bad', status: 'failed' },
        { name: 'off', status: 'skipped' },
      ],
    });
    expect(cases.map((c) => c.name)).toEqual(['bad', 'late']);
    expect(problemCases(null)).toEqual([]);
    // The Feishu job never started: its cases are not run for that one reason.
    expect(problemCases({ cases: [{ name: 'late', status: 'not-run' }, { name: 'bad', status: 'failed' }] }, { feishuRan: false }).map((c) => c.name)).toEqual(['bad']);
  });

  it('knows the Feishu job ran only when the queue job neither failed nor was cancelled', () => {
    // The Feishu job needs the queue job: these two mean it never started.
    expect(feishuJobRan('failure')).toBe(false);
    expect(feishuJobRan('cancelled')).toBe(false);
    // It acquired the slot and ran (even if later interrupted).
    expect(feishuJobRan('success')).toBe(true);
    // An absent or unanticipated value keeps listing rows rather than hiding them.
    expect(feishuJobRan(undefined)).toBe(true);
    expect(feishuJobRan('skipped')).toBe(true);

    const manifest = { cases: [{ name: 'late', status: 'not-run' }, { name: 'bad', status: 'failed' }] };
    for (const queueResult of ['failure', 'cancelled'] as const) {
      expect(problemCases(manifest, { feishuRan: feishuJobRan(queueResult) }).map((c) => c.name)).toEqual(['bad']);
    }
    expect(problemCases(manifest, { feishuRan: feishuJobRan('success') }).map((c) => c.name)).toEqual(['bad', 'late']);
  });

  it('counts a queue timeout as a failure, and a green or skipped run as none', () => {
    expect(failureReasons({ dashboard: 'success', feishuQueue: 'success', feishu: 'success', report: 'success' })).toEqual([]);
    expect(failureReasons({ dashboard: 'success', feishuQueue: 'failure', feishu: 'skipped', report: 'success' })).toHaveLength(1);
    expect(failureReasons({ dashboard: 'failure', feishu: 'failure' })).toHaveLength(2);
  });

  it('mentions the author and the owner once each and points at the report and the run', () => {
    const pulls = [
      { number: 1, author: 'alice', title: '', url: '', sha: 'a' },
      { number: 3, author: 'carol', title: '', url: '', sha: 'c' },
    ];
    const body = commentBody({
      mentions: ['alice', 'deepcoldy', 'alice'],
      reasons: ['Feishu live Midscene 失败'],
      cases: [{ name: 'a | b', project: 'feishu-core-claude', status: 'failed', failure: 'timed\nout' }],
      reportUrl: 'https://example.test/report/',
      runUrl: 'https://example.test/run/1',
      range: 'aaa…ccc',
      pulls,
      self: 1,
    });
    expect(body.match(/@alice/g)).toHaveLength(1);
    expect(body).toContain('@deepcoldy');
    expect(body).toContain('#3');
    expect(body).not.toContain('#1 ');
    // The table survives a pipe or a newline in a case name or failure.
    expect(body).toContain('| a \\| b | feishu-core-claude | failed | timed out |');
    expect(body).toContain('https://example.test/report/');
    expect(body).toContain('https://example.test/run/1');
  });

  it('keeps a backslash before a pipe from un-escaping it', () => {
    const body = commentBody({
      mentions: [],
      reasons: ['x'],
      cases: [{ name: 'a\\|b', project: 'p', status: 'failed', failure: '' }],
      reportUrl: '',
      runUrl: 'u',
      range: 'r',
      pulls: [],
      self: null,
    });
    const row = body.split('\n').find((line) => line.includes('a\\'))!;
    // Unescaped pipes delimit cells: still exactly five (four columns).
    expect(row.match(/(?<!\\)(?:\\\\)*\|/g)).toHaveLength(5);
    expect(row).toContain('a\\\\\\|b');
  });

  it('recognises its own comment for the same run only', () => {
    const body = commentBody({ mentions: [], reasons: ['x'], cases: [], reportUrl: '', runUrl: 'u', range: 'r', pulls: [], self: null, runId: 42 });
    expect(alreadyNotified([{ body: 'unrelated' }, { body }], 42)).toBe(true);
    expect(alreadyNotified([{ body }], 43)).toBe(false);
    expect(alreadyNotified(undefined, 42)).toBe(false);
  });

  it('leaves the report link out when nothing was published', () => {
    const body = commentBody({
      mentions: ['deepcoldy'],
      reasons: ['Dashboard Midscene 失败'],
      cases: [],
      reportUrl: '',
      runUrl: 'https://example.test/run/2',
      range: 'abc',
      pulls: [],
      self: null,
    });
    expect(body).not.toContain('报告（');
    expect(body).toContain('https://example.test/run/2');
  });
});

// 报告 manifest 里额度耗尽的失败信息（Midscene 错误第一行，截到 200 字）。
const QUOTA_FAILURE = 'AI model request failed after 3 retries (4/4 attempts). Last error: failed to call AI model service (model-x): 429 Your token-plan 1-month quota has been exhausted. The quota will reset at 11-15…';
const quotaCase = (name: string, project = 'feishu-core-clis') => ({ name, project, status: 'failed', failure: QUOTA_FAILURE });
const otherCase = (name: string, failure: string, project = 'feishu-core-claude') => ({ name, project, status: 'failed', failure });
const passedCase = (name: string, project = 'feishu-core-claude') => ({ name, project, status: 'success', failure: null });

describe('Midscene failures the model quota explains (#2670)', () => {
  const results = { modelCheck: 'success', dashboard: 'success', feishuQueue: 'success', feishu: 'failure', report: 'success' };

  it('leaves a run quiet when every failed case failed on the quota', () => {
    const verdict = assessFailures({ results, manifest: { cases: [quotaCase('Kimi'), quotaCase('Grok'), passedCase('Claude')] } });
    expect(verdict).toMatchObject({ reasons: [], quotaOnly: true });
    expect(verdict.quotaCases).toHaveLength(2);
  });

  it('leaves a run quiet when the Feishu job found the quota gone after waiting for the slot', () => {
    expect(assessFailures({ results, feishuQuotaExhausted: true, manifest: null })).toMatchObject({ reasons: [], quotaOnly: true });
  });

  it('keeps real failures: other cases are listed without the quota rows, and the quota is noted', () => {
    // The d2abdcf7f run: 23 quota failures, 4 timeouts, 1 replanning failure.
    const cases = [
      ...Array.from({ length: 23 }, (_, i) => quotaCase(`quota ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => otherCase(`slow ${i}`, 'Node "feishu.runScenario" timed out after 1800000ms.')),
      otherCase('Claude basic bot flow', 'Replanned 20 times, exceeding the limit.'),
    ];
    const verdict = assessFailures({ results, manifest: { cases } });
    expect(verdict.quotaOnly).toBe(false);
    expect(verdict.reasons).toEqual(['Feishu live Midscene 失败']);
    expect(verdict.cases.map((c: { name: string }) => c.name)).toEqual(['slow 0', 'slow 1', 'slow 2', 'slow 3', 'Claude basic bot flow']);
    expect(verdict.quotaCases).toHaveLength(23);
  });

  it('does not let quota rows in one suite excuse another suite or the slot wait', () => {
    const manifest = { cases: [quotaCase('Kimi')] };
    // Dashboard failed without failed cases (a build step, say): a real failure.
    expect(assessFailures({ results: { ...results, dashboard: 'failure' }, manifest }).reasons).toEqual(['Dashboard Midscene 失败']);
    expect(assessFailures({ results: { ...results, feishuQueue: 'failure', feishu: 'skipped' }, manifest }).quotaOnly).toBe(false);
    // Dashboard failed on the quota too: still quiet.
    const both = { cases: [quotaCase('Kimi'), quotaCase('smoke', 'dashboard-smoke')] };
    expect(assessFailures({ results: { ...results, dashboard: 'failure' }, manifest: both }).quotaOnly).toBe(true);
    // A failed model check (not a quota: that job passes on a quota) is reported.
    expect(failureReasons({ modelCheck: 'failure' })).toEqual(['Midscene 模型服务预检失败']);
  });

  it('notes the quota rows it left out of a comment', () => {
    const body = commentBody({ mentions: [], reasons: ['Feishu live Midscene 失败'], cases: [], reportUrl: '', runUrl: 'u', range: 'r', pulls: [], self: null, quotaCases: 23, quotaReset: '11-15 16:00:00 UTC' });
    expect(body).toContain('另有 23 个用例');
    expect(body).toContain('11-15 16:00:00 UTC');
  });
});

describe('notify() against a stubbed GitHub API', () => {
  let dir: string;
  let requests: Array<{ method: string; route: string }>;
  let posted: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'midscene-notify-'));
    writeFileSync(join(dir, 'summary'), '');
    requests = [];
    posted = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const route = url.replace('https://api.github.com/repos/o/r', '');
    const method = init?.method ?? 'GET';
    requests.push({ method, route });
    if (route.startsWith('/actions/workflows/')) return json({ workflow_runs: [] });
    if (route === '/commits/head/pulls') return json([pull(7, 'alice')]);
    if (route.startsWith('/issues/7/comments') && method === 'GET') return json([]);
    if (route === '/issues/7/comments' && method === 'POST') {
      posted.push(JSON.parse(String(init?.body)).body);
      return json({});
    }
    throw new Error(`unexpected ${method} ${route}`);
  }) as unknown as typeof fetch;

  function runWith(env: Record<string, string>, cases: unknown[]) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ cases }));
    return notify({
      env: {
        GITHUB_REPOSITORY: 'o/r', GITHUB_REPOSITORY_OWNER: 'o', GITHUB_RUN_ID: '100', GITHUB_SHA: 'head', GITHUB_REF_NAME: 'master',
        GITHUB_SERVER_URL: 'https://github.example', GITHUB_TOKEN: 't', GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        MANIFEST_PATH: join(dir, 'manifest.json'),
        MODEL_CHECK_RESULT: 'success', DASHBOARD_RESULT: 'success', QUEUE_RESULT: 'success', FEISHU_RESULT: 'failure', REPORT_RESULT: 'success',
        ...env,
      },
      fetchImpl,
    });
  }
  const posts = () => requests.filter((request) => request.method === 'POST');

  it('posts nothing and writes the summary line when the quota explains the failure', async () => {
    await runWith({}, [quotaCase('Kimi'), quotaCase('Grok')]);
    expect(requests).toEqual([]);
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toMatch(/额度耗尽.*不评论合入的 PR/);
  });

  it('posts nothing for a Feishu job that hit the quota at its own preflight', async () => {
    await runWith({ FEISHU_QUOTA_EXHAUSTED: 'true', QUOTA_RESET: '11-15 16:00:00 UTC' }, []);
    expect(posts()).toEqual([]);
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('11-15 16:00:00 UTC');
  });

  it('still comments on the merged pull request for a real case failure', async () => {
    await runWith({}, [otherCase('Claude basic bot flow', 'Replanned 20 times, exceeding the limit.'), quotaCase('Kimi')]);
    expect(posts()).toEqual([{ method: 'POST', route: '/issues/7/comments' }]);
    expect(posted[0]).toContain('Claude basic bot flow');
    expect(posted[0]).not.toContain('| Kimi |');
    expect(posted[0]).toContain('另有 1 个用例');
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toBe('');
  });

  it('names the site artifact next to the report link, which Pages prunes after later runs', async () => {
    const failed = [otherCase('Claude basic bot flow', 'Replanned 20 times, exceeding the limit.')];
    await runWith({ REPORT_PUBLISHED: 'true', REPORT_SITE_URL: 'https://example.test/master-run-100/', SITE_ARTIFACT_NAME: 'botmux-midscene-site' }, failed);
    expect(posted[0]).toContain('https://example.test/master-run-100/');
    expect(posted[0]).toContain('botmux-midscene-site');

    // Nothing published: no report link, so nothing to fall back from.
    posted.length = 0;
    await runWith({ REPORT_PUBLISHED: 'false', REPORT_SITE_URL: 'https://example.test/master-run-100/', SITE_ARTIFACT_NAME: 'botmux-midscene-site' }, failed);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain('botmux-midscene-site');
  });
});
