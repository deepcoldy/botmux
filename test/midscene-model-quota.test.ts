/**
 * Midscene 模型额度耗尽（HTTP 429，#2670）的识别与模型预检的输出标记。
 * 预检把「额度耗尽」与其它失败分开报：写 quota_exhausted / quota_reset 到 step
 * outputs，带 --allow-quota-exhausted 时退出 0（让工作流跳过用例），否则仍失败。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runModelPreflight } from '../scripts/check-midscene-model.mjs';
import { isQuotaExhaustedResponse, isQuotaFailureMessage, quotaResetTime } from '../scripts/midscene-quota.mjs';

// 2026-11-01 master 上 Midscene 实际拿到的 429 回包（id 已换掉）。
const QUOTA_BODY = JSON.stringify({
  error: {
    message: 'Your token-plan 1-month quota has been exhausted. The quota will reset at 11-15 16:00:00 UTC.',
    id: 'req-1',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
});
const RATE_LIMIT_BODY = JSON.stringify({ error: { message: 'Rate limit reached for requests per minute.', code: 'rate_limit_exceeded' } });
// 报告 manifest 里的失败信息：Midscene 错误的第一行，截到 200 字。
const QUOTA_CASE_FAILURE = 'AI model request failed after 3 retries (4/4 attempts). Last error: failed to call AI model service (model-x): 429 Your token-plan 1-month quota has been exhausted. The quota will reset at 11-15…';

describe('quota recognition', () => {
  it('needs HTTP 429 and quota wording; a plain rate limit is not a quota', () => {
    expect(isQuotaExhaustedResponse(429, QUOTA_BODY)).toBe(true);
    expect(isQuotaExhaustedResponse(429, '{"error":{"message":"You exceeded your current quota"}}')).toBe(true);
    expect(isQuotaExhaustedResponse(429, RATE_LIMIT_BODY)).toBe(false);
    expect(isQuotaExhaustedResponse(500, QUOTA_BODY)).toBe(false);
  });

  it('recognises a quota case failure from the truncated first line only', () => {
    expect(isQuotaFailureMessage(QUOTA_CASE_FAILURE)).toBe(true);
    expect(isQuotaFailureMessage('Node "feishu.runScenario" timed out after 1800000ms.')).toBe(false);
    expect(isQuotaFailureMessage('failed to call AI model service: 429 Rate limit reached')).toBe(false);
    expect(isQuotaFailureMessage(null)).toBe(false);
  });

  it('reads a complete reset time and refuses a truncated one', () => {
    expect(quotaResetTime(QUOTA_BODY)).toBe('11-15 16:00:00 UTC');
    expect(quotaResetTime(QUOTA_CASE_FAILURE)).toBeNull();
    expect(quotaResetTime('quota resets at 2026-11-15T16:00:00Z.')).toBe('2026-11-15T16:00:00Z');
  });
});

describe('check-midscene-model preflight', () => {
  let dir: string;
  let env: Record<string, string>;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'midscene-preflight-'));
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary'), '');
    env = {
      MIDSCENE_MODEL_BASE_URL: 'https://model.example.test/v1/',
      MIDSCENE_MODEL_API_KEY: 'key-not-for-logs',
      MIDSCENE_MODEL_NAME: 'model-x',
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    };
    logs = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const respond = (status: number, body = '') => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const run = (status: number, body: string, args: string[] = []) =>
    runModelPreflight({ env, args, fetchImpl: respond(status, body).fetchImpl, log: (line: string) => logs.push(line) });
  const outputs = () => readFileSync(join(dir, 'output'), 'utf8');
  const summary = () => readFileSync(join(dir, 'summary'), 'utf8');

  it('passes and says the quota is fine when the model answers', async () => {
    const { calls, fetchImpl } = respond(200, '{}');
    expect(await runModelPreflight({ env, fetchImpl, log: (line: string) => logs.push(line) })).toBe(0);
    expect(calls).toEqual(['https://model.example.test/v1/chat/completions']);
    expect(outputs()).toBe('quota_exhausted=false\n');
    expect(summary()).toBe('');
  });

  it('marks an exhausted quota and, when allowed, passes with a summary line naming the reset', async () => {
    expect(await run(429, QUOTA_BODY, ['--allow-quota-exhausted'])).toBe(0);
    expect(outputs()).toBe('quota_exhausted=true\nquota_reset=11-15 16:00:00 UTC\n');
    expect(summary()).toContain('额度耗尽');
    expect(summary()).toContain('11-15 16:00:00 UTC');
    expect(logs.some((line) => line.startsWith('::warning::'))).toBe(true);
  });

  it('still fails on an exhausted quota without the flag, keeping the mark for the notification', async () => {
    expect(await run(429, QUOTA_BODY)).toBe(1);
    expect(outputs()).toContain('quota_exhausted=true\n');
  });

  it('treats a rate limit or a server error as a real failure, without echoing the provider body', async () => {
    expect(await run(429, RATE_LIMIT_BODY, ['--allow-quota-exhausted'])).toBe(1);
    expect(outputs()).toBe('quota_exhausted=false\n');
    expect(await run(503, 'internal detail for upstream-host.example', ['--allow-quota-exhausted'])).toBe(1);
    expect(logs.join('\n')).toContain('HTTP 503');
    expect(logs.join('\n')).not.toContain('upstream-host.example');
    expect(summary()).toBe('');
  });
});
