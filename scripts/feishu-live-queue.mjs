#!/usr/bin/env node
// First-come-first-served slot for the Feishu live suite.
//
// Every Midscene E2E run drives the same Feishu bots, so only one Feishu job
// may run at a time. A GitHub `concurrency` group keeps one running and one
// pending job and cancels the older pending one whenever a newer run arrives,
// so with three branches in flight the middle one never ran. This script runs
// as its own job ahead of the Feishu job and waits instead:
//   - a run whose queue job succeeded and whose Feishu job has not finished
//     holds the slot (this covers the gap while its Feishu job awaits a runner);
//   - a run whose queue job started earlier and is still waiting is ahead.
// The Feishu job starts once neither exists. Runs from before this queue (no
// queue job) hold the slot while their Feishu job is in progress.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUEUE_JOB_NAME = 'Wait for the Feishu live slot';
export const FEISHU_JOB_NAME = 'Feishu live Midscene (parallel lanes)';

/**
 * The runs keeping this run from the Feishu slot.
 * @param {{ selfRunId: number, selfStartedAt: string, runs: Array<{ id: number, headBranch?: string, htmlUrl?: string, jobs: Array<{ name: string, status: string, conclusion: string | null, started_at: string | null }> }> }} input
 */
export function slotBlockers({ selfRunId, selfStartedAt, runs }) {
  const blockers = [];
  for (const run of runs) {
    if (run.id === selfRunId) continue;
    const queue = run.jobs.find((job) => job.name === QUEUE_JOB_NAME);
    const feishu = run.jobs.find((job) => job.name === FEISHU_JOB_NAME);
    if (!feishu) continue;
    const feishuActive = feishu.status !== 'completed';
    if (queue) {
      if (queue.status === 'completed') {
        if (queue.conclusion === 'success' && feishuActive) blockers.push({ run, reason: 'holds the slot' });
      } else if (queue.status === 'in_progress' && queue.started_at) {
        const ahead =
          queue.started_at < selfStartedAt || (queue.started_at === selfStartedAt && run.id < selfRunId);
        if (ahead) blockers.push({ run, reason: 'is queued ahead' });
      }
    } else if (feishu.status === 'in_progress') {
      blockers.push({ run, reason: 'holds the slot (run from before the queue)' });
    }
  }
  return blockers;
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function runJobs(runId) {
  const { jobs } = await github(`/actions/runs/${runId}/jobs?per_page=100`);
  return jobs;
}

async function main() {
  const selfRunId = Number(process.env.GITHUB_RUN_ID);
  const workflow = process.env.QUEUE_WORKFLOW_FILE ?? 'midscene-e2e.yml';
  const pollMs = Number(process.env.QUEUE_POLL_SECONDS ?? 60) * 1000;
  const maxWaitMs = Number(process.env.QUEUE_MAX_WAIT_MINUTES ?? 280) * 60_000;
  const self = (await runJobs(selfRunId)).find((job) => job.name === QUEUE_JOB_NAME);
  const selfStartedAt = self?.started_at ?? new Date().toISOString();
  const started = Date.now();
  let lastReport = '';
  for (;;) {
    let blockers = [];
    try {
      const { workflow_runs: inProgress } = await github(
        `/actions/workflows/${workflow}/runs?status=in_progress&per_page=100`,
      );
      const runs = [];
      for (const run of inProgress) {
        if (run.id === selfRunId) continue;
        runs.push({ id: run.id, headBranch: run.head_branch, htmlUrl: run.html_url, jobs: await runJobs(run.id) });
      }
      blockers = slotBlockers({ selfRunId, selfStartedAt, runs });
    } catch (error) {
      // A transient API failure must not hand out the slot; keep waiting.
      console.log(`Queue check failed, retrying: ${error.message}`);
      blockers = [{ run: { id: 0, headBranch: '(unknown)' }, reason: 'could not be checked' }];
    }
    if (blockers.length === 0) {
      console.log(`Feishu live slot acquired after ${Math.round((Date.now() - started) / 1000)}s.`);
      return;
    }
    const report = blockers.map(({ run, reason }) => `${run.headBranch} (run ${run.id}) ${reason}`).join('; ');
    if (report !== lastReport) {
      console.log(`Waiting for the Feishu live slot: ${report}`);
      lastReport = report;
    }
    if (Date.now() - started > maxWaitMs) {
      console.log(`::error::Waited ${Math.round(maxWaitMs / 60_000)} minutes for the Feishu live slot: ${report}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.log(`::error::${error.stack ?? error.message}`);
    process.exit(1);
  });
}
