#!/usr/bin/env node
// CI preflight: fail fast when the Midscene vision model is unreachable, before
// a suite spends minutes on browser setup. Used by .github/workflows/midscene-e2e.yml.
//
// An exhausted quota (HTTP 429 naming the quota, #2670) is reported apart from
// other failures through step outputs, so the workflow can skip the suites and
// leave the merged pull requests alone:
//   quota_exhausted=true|false
//   quota_reset=<when the provider says it resets>   (only when known)
// With --allow-quota-exhausted that case exits 0 (the model-check job, whose
// outputs skip the suites); without it the step still fails (a suite job that
// found the quota gone after waiting for the Feishu slot).

import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isQuotaExhaustedResponse, quotaNote, quotaResetTime } from './midscene-quota.mjs';

/**
 * Probe the model once and report the result.
 * @param {{ env: Record<string, string | undefined>, args?: string[], fetchImpl?: typeof fetch, log?: (line: string) => void }} options
 * @returns {Promise<number>} the process exit code
 */
export async function runModelPreflight({ env, args = [], fetchImpl = fetch, log = console.log }) {
  const baseUrl = env.MIDSCENE_MODEL_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl || !env.MIDSCENE_MODEL_API_KEY || !env.MIDSCENE_MODEL_NAME) {
    throw new Error('MIDSCENE_MODEL_BASE_URL, MIDSCENE_MODEL_API_KEY and MIDSCENE_MODEL_NAME are required');
  }
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MIDSCENE_MODEL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.MIDSCENE_MODEL_NAME,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.text();
  const quotaExhausted = !response.ok && isQuotaExhaustedResponse(response.status, body);
  const reset = quotaExhausted ? quotaResetTime(body) : null;

  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, `quota_exhausted=${quotaExhausted}\n${reset ? `quota_reset=${reset}\n` : ''}`);
  }
  if (response.ok) return 0;
  if (!quotaExhausted) {
    // The body is the provider's; keep it out of the public log.
    log(`::error::Model preflight returned HTTP ${response.status}`);
    return 1;
  }
  const allowed = args.includes('--allow-quota-exhausted');
  const note = `${quotaNote(reset)}${allowed ? '，本次跳过 Dashboard 与飞书 live 用例，也不评论合入的 PR' : ''}。`;
  log(`::warning::${note}`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${note}\n`);
  return allowed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runModelPreflight({ env: process.env, args: process.argv.slice(2) }).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.log(`::error::${error.message}`);
      process.exitCode = 1;
    },
  );
}
