#!/usr/bin/env node
// Fail closed if the repo branch ruleset does not require the unit-test
// aggregator. After the suite moved out of `build`, a ruleset that still
// lists only `build` lets a red shard merge — the PR page can be all-green
// on optional checks while the only required context never ran tests.
//
// Reads the public ruleset API (this repo is public). GITHUB_TOKEN is used
// when present for a higher rate limit, then falls back to unauthenticated.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_MERGE_CONTEXTS = Object.freeze(['build', 'test']);

export function collectRequiredContexts(rulesets) {
  const have = new Set();
  for (const rs of rulesets) {
    if (rs.enforcement && rs.enforcement !== 'active') continue;
    if (rs.target && rs.target !== 'branch') continue;
    for (const rule of rs.rules ?? []) {
      if (rule.type !== 'required_status_checks') continue;
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (typeof check.context === 'string' && check.context) have.add(check.context);
      }
    }
  }
  return have;
}

export function missingRequiredContexts(rulesets, required = REQUIRED_MERGE_CONTEXTS) {
  const have = collectRequiredContexts(rulesets);
  return required.filter(ctx => !have.has(ctx));
}

async function githubJson(path, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'botmux-ci-ruleset-assert',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = body; }
  return { ok: res.ok, status: res.status, json };
}

async function githubJsonWithFallback(path) {
  const token = process.env.GITHUB_TOKEN || '';
  let result = await githubJson(path, token);
  if (!result.ok && token) result = await githubJson(path, '');
  if (!result.ok) {
    throw new Error(`GET ${path} failed: ${result.status}`);
  }
  return result.json;
}

export async function loadActiveBranchRulesets(repo) {
  const list = await githubJsonWithFallback(`/repos/${repo}/rulesets`);
  if (!Array.isArray(list)) {
    throw new Error(`unexpected ruleset list for ${repo}`);
  }
  const details = [];
  for (const rs of list.filter(item => item.target === 'branch')) {
    details.push(await githubJsonWithFallback(`/repos/${repo}/rulesets/${rs.id}`));
  }
  return details;
}

function formatMissing(repo, missing, have) {
  return [
    `ruleset on ${repo} is missing required status check(s): ${missing.join(', ')}`,
    `currently required: ${have.size ? [...have].join(', ') : '(none)'}`,
    '',
    '`build` no longer runs the unit suite. Add context `test` (the aggregator',
    'job name in .github/workflows/ci.yml) to ruleset "Require CI green on master",',
    'keeping `build`. Repo → Settings → Rules → that ruleset → Required checks.',
  ].join('\n');
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'deepcoldy/botmux';
  const rulesets = await loadActiveBranchRulesets(repo);
  const missing = missingRequiredContexts(rulesets);
  if (missing.length) {
    console.error(formatMissing(repo, missing, collectRequiredContexts(rulesets)));
    process.exit(1);
  }
  console.log(`ruleset on ${repo} requires ${REQUIRED_MERGE_CONTEXTS.join(' + ')}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await main();
}
