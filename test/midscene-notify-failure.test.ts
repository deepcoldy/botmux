import { describe, expect, it } from 'vitest';
import {
  alreadyNotified,
  commentBody,
  failureReasons,
  feishuJobRan,
  mergedPullRequests,
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
