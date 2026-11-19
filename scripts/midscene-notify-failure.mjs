#!/usr/bin/env node
// Tell the authors of the merged pull requests when Midscene E2E fails on master.
//
// Midscene runs after merge, not on pull requests: the Feishu live suite
// drives one shared set of bots, and pull requests queued for hours behind
// each other. A master run is pending while another one runs, and GitHub keeps
// only the newest pending run, so one run can cover several merges. This
// script finds that range (since the last master run that reached a result),
// collects the pull requests merged in it, and comments on each one with the
// failed cases and the published report, mentioning the author and the
// repository owner. A push without a pull request gets a commit comment.
//
// Failures the Midscene model quota explains (HTTP 429, #2670) say nothing
// about the merged code, so they get one line in the run summary instead of
// comments. A run with other failures still comments, without the quota rows.

import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isQuotaFailureMessage, quotaNote, quotaResetTime } from './midscene-quota.mjs';

// Comment bodies are bounded; a broken run can fail every case.
const MAX_LISTED_CASES = 20;

/**
 * The head SHA of the newest earlier master push run that reached a result.
 * Cancelled runs (superseded while pending) never tested their commits, so
 * their range belongs to this run.
 * @param {Array<{ id: number, head_sha: string, event: string, status: string, conclusion: string | null }>} runs newest first
 * @param {number} selfRunId
 */
export function previousTestedSha(runs, selfRunId) {
  for (const run of runs) {
    if (run.id >= selfRunId || run.event !== 'push' || run.status !== 'completed') continue;
    if (run.conclusion === 'success' || run.conclusion === 'failure') return run.head_sha;
  }
  return null;
}

/**
 * Pull requests merged into `base` by these commits, oldest first, once each.
 * @param {Array<{ sha: string, pulls: Array<{ number: number, merged_at: string | null, base: { ref: string }, user: { login: string } | null, html_url: string, title: string }> }>} commits
 */
export function mergedPullRequests(commits, base) {
  const seen = new Map();
  for (const { sha, pulls } of commits) {
    for (const pull of pulls) {
      if (!pull.merged_at || pull.base?.ref !== base || seen.has(pull.number)) continue;
      seen.set(pull.number, { number: pull.number, author: pull.user?.login ?? null, title: pull.title, url: pull.html_url, sha });
    }
  }
  return [...seen.values()];
}

/**
 * Cases worth naming: failed first, then the ones the run never reached.
 * When the Feishu job never ran (it waited out the live slot), every Feishu
 * case is "not run" for the same reason; listing them says nothing more.
 * @param {{ cases?: Array<{ status?: string }> } | null | undefined} manifest
 * @param {{ feishuRan?: boolean }} [options]
 *        feishuRan=false drops the "not run" rows. Pass it when the Feishu job
 *        never started, so its cases are all "not run" for that one reason.
 */
export function problemCases(manifest, { feishuRan = true } = {}) {
  const cases = Array.isArray(manifest?.cases) ? manifest.cases : [];
  return [
    ...cases.filter((testCase) => testCase.status === 'failed'),
    ...(feishuRan ? cases.filter((testCase) => testCase.status === 'not-run') : []),
  ];
}

/**
 * Whether the Feishu job ran, from the feishu-queue job's result
 * (`needs.feishu-queue.result`: success | failure | cancelled | skipped).
 * The Feishu job needs the queue job, so a queue that failed (waited out the
 * slot) or was cancelled (the run was cancelled while waiting) means Feishu
 * never started. Any other value is treated as "ran": an unexpected result
 * must not hide rows that might be informative.
 * @param {string | undefined} queueResult
 * @returns {boolean}
 */
export function feishuJobRan(queueResult) {
  return queueResult !== 'failure' && queueResult !== 'cancelled';
}

/**
 * Why the run counts as failed, from the job results, or null when it did not.
 * @param {{ modelCheck?: string, dashboard?: string, feishuQueue?: string, feishu?: string, report?: string }} results
 */
export function failureReasons(results) {
  const reasons = [];
  if (results.modelCheck === 'failure') reasons.push('Midscene 模型服务预检失败');
  if (results.dashboard === 'failure') reasons.push('Dashboard Midscene 失败');
  if (results.feishuQueue === 'failure') {
    reasons.push('等待飞书 live 席位超时，飞书用例未运行（席位排队问题，不是本次合入的回归；需要结果时在 master 上手动 dispatch）');
  }
  if (results.feishu === 'failure') reasons.push('Feishu live Midscene 失败');
  if (results.report === 'failure') reasons.push('报告生成失败');
  return reasons;
}

const isDashboardCase = (testCase) => testCase.project === 'dashboard-smoke';
const isFeishuCase = (testCase) => typeof testCase.project === 'string' && testCase.project.startsWith('feishu-');

/**
 * Split the run's failures into those the model quota explains and the rest.
 * A suite counts as explained only when it has failed cases and every one of
 * them failed on the quota, or (Feishu) its own preflight found the quota gone
 * after it waited for the slot. Anything else — a timeout, a build step, a case
 * failing for another reason — stays a real failure.
 * @param {{
 *   results: { modelCheck?: string, dashboard?: string, feishuQueue?: string, feishu?: string, report?: string },
 *   feishuQuotaExhausted?: boolean,
 *   manifest?: { cases?: Array<{ project?: string, status?: string, failure?: string | null }> } | null,
 *   feishuRan?: boolean,
 * }} input
 */
export function assessFailures({ results, feishuQuotaExhausted = false, manifest, feishuRan = true }) {
  const failed = (Array.isArray(manifest?.cases) ? manifest.cases : []).filter((testCase) => testCase.status === 'failed');
  const quotaCases = failed.filter((testCase) => isQuotaFailureMessage(testCase.failure));
  const explainedByQuota = (cases) => cases.length > 0 && cases.every((testCase) => isQuotaFailureMessage(testCase.failure));
  const dashboardQuota = results.dashboard === 'failure' && explainedByQuota(failed.filter(isDashboardCase));
  const feishuQuota = results.feishu === 'failure'
    && (feishuQuotaExhausted || explainedByQuota(failed.filter(isFeishuCase)));
  const reasons = failureReasons({
    ...results,
    dashboard: dashboardQuota ? 'quota' : results.dashboard,
    feishu: feishuQuota ? 'quota' : results.feishu,
  });
  const quotaHit = dashboardQuota || feishuQuota || quotaCases.length > 0;
  return {
    reasons,
    // Nothing left to tell the authors: the summary line is the whole report.
    quotaOnly: reasons.length === 0 && quotaHit,
    quotaCases,
    cases: problemCases(manifest, { feishuRan }).filter((testCase) => !quotaCases.includes(testCase)),
  };
}

// Backslashes first: `a\|b` must not become `a\\|b`, whose pipe splits the cell.
const escapeCell = (value) =>
  String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Hidden marker naming the run, so a re-run of the job does not comment twice. */
export const runMarker = (runId) => `<!-- midscene-notify run=${runId} -->`;

/** Whether one of `comments` was already posted for this run. */
export function alreadyNotified(comments, runId) {
  const marker = runMarker(runId);
  return Array.isArray(comments) && comments.some((comment) => String(comment?.body ?? '').includes(marker));
}

export function commentBody({ mentions, reasons, cases, reportUrl, siteArtifactName = '', runUrl, range, pulls, self, runId, quotaCases = 0, quotaReset = null }) {
  const lines = [];
  const who = [...new Set(mentions.filter(Boolean))].map((login) => `@${login}`).join(' ');
  lines.push(`${who ? `${who} ` : ''}合入 master 后的 Midscene E2E 失败：${reasons.join('；')}。`);
  lines.push('');
  if (pulls.length > 1) {
    const others = pulls.filter((pull) => pull.number !== self).map((pull) => `#${pull.number}`);
    lines.push(`这次运行覆盖 ${range}，同批合入的还有 ${others.join(' ')}，失败不一定由本 PR 引起。`);
  } else {
    lines.push(`这次运行覆盖 ${range}。`);
  }
  lines.push('');
  if (cases.length > 0) {
    lines.push('| 用例 | 跑道 | 状态 | 失败信息 |', '|:--|:--|:--|:--|');
    for (const testCase of cases.slice(0, MAX_LISTED_CASES)) {
      const failure = escapeCell(testCase.failure).slice(0, 200);
      lines.push(`| ${escapeCell(testCase.name)} | ${escapeCell(testCase.project)} | ${testCase.status} | ${failure} |`);
    }
    if (cases.length > MAX_LISTED_CASES) lines.push('', `另有 ${cases.length - MAX_LISTED_CASES} 个用例未列出，见报告。`);
    lines.push('');
  }
  if (quotaCases > 0) {
    lines.push(`${quotaNote(quotaReset)}：另有 ${quotaCases} 个用例因此失败，未列出；上面的失败也可能受其影响。`, '');
  }
  if (reportUrl) {
    lines.push(`- Midscene 报告（截图、回放、录像）：${reportUrl}`);
    // Pages keeps only the newest master runs, so this link is gone after a
    // few more merges; the run's site artifact holds the same report.
    if (siteArtifactName) lines.push(`  - Pages 只保留最近几次运行的报告，链接 404 时到运行页的 Artifacts 下载 \`${siteArtifactName}\`（同一份报告，解压后用静态服务打开）`);
  }
  lines.push(`- 运行与 Summary：${runUrl}`);
  if (runId !== undefined) lines.push('', runMarker(runId));
  return `${lines.join('\n')}\n`;
}

function githubClient(env, fetchImpl) {
  return async (route, init = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${route} returned HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  };
}

async function readManifest(file) {
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.log(`No usable manifest at ${file}: ${error.message}`);
    return null;
  }
}

/**
 * Comment on the pull requests a failed master run covers.
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: typeof fetch }} options
 */
export async function notify({ env, fetchImpl = fetch }) {
  const github = githubClient(env, fetchImpl);
  const results = {
    modelCheck: env.MODEL_CHECK_RESULT,
    dashboard: env.DASHBOARD_RESULT,
    feishuQueue: env.QUEUE_RESULT,
    feishu: env.FEISHU_RESULT,
    report: env.REPORT_RESULT,
  };
  if (failureReasons(results).length === 0) {
    console.log('No failed Midscene job; nothing to notify.');
    return;
  }
  const manifest = await readManifest(env.MANIFEST_PATH && path.resolve(env.MANIFEST_PATH));
  const assessment = assessFailures({
    results,
    feishuQuotaExhausted: env.FEISHU_QUOTA_EXHAUSTED === 'true',
    manifest,
    feishuRan: feishuJobRan(env.QUEUE_RESULT),
  });
  const quotaReset = env.QUOTA_RESET || quotaResetTime(assessment.quotaCases.map((testCase) => testCase.failure).join('\n'));
  if (assessment.quotaOnly) {
    const note = `${quotaNote(quotaReset)}：本次 Midscene 失败都由此引起，不评论合入的 PR。`;
    console.log(note);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${note}\n`);
    return;
  }
  const { reasons } = assessment;
  const selfRunId = Number(env.GITHUB_RUN_ID);
  const headSha = env.GITHUB_SHA;
  const branch = env.GITHUB_REF_NAME;
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${selfRunId}`;
  const workflow = env.NOTIFY_WORKFLOW_FILE ?? 'midscene-e2e.yml';
  const reportUrl = env.REPORT_PUBLISHED === 'true' ? env.REPORT_SITE_URL : '';
  const siteArtifactName = env.SITE_ARTIFACT_NAME ?? '';

  const { workflow_runs: runs } = await github(
    `/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=50`,
  );
  const baseSha = previousTestedSha(runs, selfRunId);
  let shas = [headSha];
  if (baseSha && baseSha !== headSha) {
    const compare = await github(`/compare/${baseSha}...${headSha}`);
    // A force-push or an unrelated base leaves no sensible range.
    if (compare.status === 'ahead' && compare.commits.length > 0) shas = compare.commits.map((commit) => commit.sha);
  }
  const commits = [];
  for (const sha of shas) commits.push({ sha, pulls: await github(`/commits/${sha}/pulls`) });
  const pulls = mergedPullRequests(commits, branch);
  const range = shas.length > 1 ? `${shas[0].slice(0, 9)}…${headSha.slice(0, 9)}（${shas.length} 个提交）` : headSha.slice(0, 9);
  const { cases } = assessment;
  const quota = { quotaCases: assessment.quotaCases.length, quotaReset };

  // NOTIFY_DRY_RUN=1 prints the comments instead of posting them.
  const post = async (route, body) => {
    // A re-run of this job must not mention everyone again.
    if (alreadyNotified(await github(`${route}?per_page=100`), selfRunId)) {
      console.log(`${route}: already notified for run ${selfRunId}; skipping.`);
      return;
    }
    if (env.NOTIFY_DRY_RUN === '1') console.log(`--- POST ${route}\n${body}`);
    else await github(route, { method: 'POST', body: JSON.stringify({ body }) });
  };
  if (pulls.length === 0) {
    const body = commentBody({ mentions: [owner], reasons, cases, reportUrl, siteArtifactName, runUrl, range, pulls, self: null, runId: selfRunId, ...quota });
    await post(`/commits/${headSha}/comments`, body);
    console.log(`No merged pull request in ${range}; commented on ${headSha}.`);
    return;
  }
  for (const pull of pulls) {
    const body = commentBody({ mentions: [pull.author, owner], reasons, cases, reportUrl, siteArtifactName, runUrl, range, pulls, self: pull.number, runId: selfRunId, ...quota });
    await post(`/issues/${pull.number}/comments`, body);
    console.log(`Commented on #${pull.number} (${pull.author}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  notify({ env: process.env }).catch((error) => {
    console.log(`::error::${error.stack ?? error.message}`);
    process.exit(1);
  });
}
