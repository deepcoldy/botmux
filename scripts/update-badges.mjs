#!/usr/bin/env node
// Writes the shields.io endpoint files behind three README badges. Run by
// .github/workflows/badges.yml, which publishes them on the `badges` branch.
//   npm-downloads.json  last-month downloads of botmux plus every package it ships
//   ci.json             latest finished master CI run
//   midscene.json       latest finished master Midscene E2E run
//
// usage: node scripts/update-badges.mjs <out-dir>
// env:   GITHUB_REPOSITORY, GITHUB_TOKEN
//
// GitHub's own workflow badges paint a cancelled run red. A pending master run
// is cancelled whenever a newer merge arrives, so the native CI badge read
// "failing" most of the time with no failed run; cancelled runs are skipped
// here. A Midscene run whose suites were all skipped (the model quota preflight,
// #2670) concludes success, so it reports "skipped" instead of passing.
// A badge whose source cannot be read keeps its previous file.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEISHU_JOB_NAME } from './feishu-live-queue.mjs';

export const MAIN_PACKAGE = 'botmux';
// Published by release.yml alongside botmux, but not one of its dependencies.
export const EXTRA_PACKAGES = ['botmux-workflow-core'];
export const CI_WORKFLOW = 'ci.yml';
export const MIDSCENE_WORKFLOW = 'midscene-e2e.yml';
export const DASHBOARD_JOB_NAME = 'Dashboard Midscene';
export const SUITE_JOB_NAMES = [DASHBOARD_JOB_NAME, FEISHU_JOB_NAME];

const badge = (label, message, color) => ({ schemaVersion: 1, label, message, color });

const SUFFIXES = ['', 'k', 'M', 'G'];

/** A count in shields.io's style: 999, 1.2k, 17k, 1M (not 1000k), 1.3M. */
export function formatCount(n) {
  let power = 0;
  while (power < SUFFIXES.length - 1 && Math.round(n / 1000 ** power) >= 1000) power += 1;
  if (power === 0) return String(n);
  const scaled = n / 1000 ** power;
  const oneDecimal = scaled.toFixed(1);
  return scaled < 10 && !oneDecimal.endsWith('0') ? `${oneDecimal}${SUFFIXES[power]}` : `${Math.round(scaled)}${SUFFIXES[power]}`;
}

/** botmux, its platform binary packages (optionalDependencies named botmux-*), and the extras. */
export function npmPackages(manifest) {
  const platforms = Object.keys(manifest.optionalDependencies ?? {}).filter((name) => name.startsWith(`${MAIN_PACKAGE}-`));
  return [...new Set([MAIN_PACKAGE, ...platforms, ...EXTRA_PACKAGES])];
}

/**
 * @param {Record<string, { downloads: number } | null>} points npm's bulk last-month response
 * @param {string[]} packages
 */
export function npmDownloadsBadge(points, packages) {
  if (!(points?.[MAIN_PACKAGE]?.downloads > 0)) throw new Error(`npm returned no downloads for ${MAIN_PACKAGE}`);
  const missing = packages.filter((name) => typeof points[name]?.downloads !== 'number');
  if (missing.length) throw new Error(`npm returned no downloads for ${missing.join(', ')}`);
  const total = packages.reduce((sum, name) => sum + points[name].downloads, 0);
  return badge('downloads', `${formatCount(total)}/month`, 'brightgreen');
}

/**
 * The newest run that reached a result. Cancelled runs were superseded and tested nothing.
 * @param {Array<{ status: string, conclusion: string | null }>} runs newest first
 */
export function latestFinishedRun(runs) {
  return runs.find((run) => run.status === 'completed' && run.conclusion && !['cancelled', 'skipped'].includes(run.conclusion));
}

export function ciBadge(run) {
  return run.conclusion === 'success' ? badge('CI', 'passing', 'brightgreen') : badge('CI', 'failing', 'red');
}

/**
 * A failed run still passes when every suite passed (only the report upload broke),
 * but not when a suite never ran because the Feishu live slot wait gave up.
 * @param {{ conclusion: string }} run
 * @param {Array<{ name: string, conclusion: string | null }>} jobs
 */
export function midsceneBadge(run, jobs) {
  const suites = jobs.filter((job) => SUITE_JOB_NAMES.includes(job.name));
  if (suites.length === 0) throw new Error(`no ${SUITE_JOB_NAMES.join(' / ')} job in the run; were they renamed?`);
  const label = 'Midscene E2E';
  const passing = badge(label, 'passing', 'brightgreen');
  const failing = badge(label, 'failing', 'red');
  if (suites.some((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out')) return failing;
  if (suites.every((job) => job.conclusion === 'success')) return passing;
  if (run.conclusion !== 'success') return failing;
  return suites.some((job) => job.conclusion === 'success') ? passing : badge(label, 'skipped', 'lightgrey');
}

async function getJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function updateBadges({ outDir, env, fetchImpl = fetch }) {
  const github = (route) => getJson(fetchImpl, `https://api.github.com/repos/${env.GITHUB_REPOSITORY}${route}`, {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  const finishedMasterRun = async (workflow) => {
    const { workflow_runs: runs } = await github(`/actions/workflows/${workflow}/runs?branch=master&event=push&status=completed&per_page=50`);
    const run = latestFinishedRun(runs);
    if (!run) throw new Error(`no finished master run of ${workflow} among the last ${runs.length}`);
    return run;
  };
  const sources = {
    'npm-downloads.json': async () => {
      const packages = npmPackages(await getJson(fetchImpl, `https://registry.npmjs.org/${MAIN_PACKAGE}/latest`));
      return npmDownloadsBadge(await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-month/${packages.join(',')}`), packages);
    },
    'ci.json': async () => ciBadge(await finishedMasterRun(CI_WORKFLOW)),
    'midscene.json': async () => {
      const run = await finishedMasterRun(MIDSCENE_WORKFLOW);
      return midsceneBadge(run, (await github(`/actions/runs/${run.id}/jobs?per_page=100`)).jobs);
    },
  };
  const failed = [];
  for (const [file, build] of Object.entries(sources)) {
    try {
      const data = await build();
      await writeFile(path.join(outDir, file), `${JSON.stringify(data, null, 2)}\n`);
      console.log(`${file}: ${data.label} ${data.message}`);
    } catch (error) {
      failed.push(file);
      console.log(`::warning::${file} keeps its previous value: ${error.message}`);
    }
  }
  if (failed.length === Object.keys(sources).length) throw new Error('no badge could be updated');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.log('usage: node scripts/update-badges.mjs <out-dir>');
    process.exit(2);
  }
  updateBadges({ outDir, env: process.env }).catch((error) => {
    console.log(`::error::${error.stack ?? error.message}`);
    process.exit(1);
  });
}
