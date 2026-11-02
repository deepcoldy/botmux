import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evaluateExpression, format, interpolate, isTruthy } from './helpers/github-expression.js';

/**
 * 机器可校验的一致性(K4)：读 ci.yml 这份 GitHub 真正执行的 YAML，不是 src 文本。
 *
 * concurrency 的两个值各自代表一个必须在 master 上成立的不变量：
 *   • pull_request → true：同一 PR 推新提交时旧 head 的 run 让位（省 runner、不排队）。
 *   • 其余触发（目前只有 master push）→ false：正在跑的 run 跑完。写成常量 true 时，
 *     每次合入都取消上一次，master 上一次完整 CI 都跑不完（10-30 起连续一天如此）。
 *
 * 失败形状是「报成功、master 一整天没有全绿 run」，无人会看见红灯，所以这里钉住。
 * `on:` 出现新触发器时也必须在这里表态：新事件若落到 false 分支（merge_group 会），
 * 排队语义可能与期望相反，因此未知事件一律判红而不是静默取默认值。
 */
const CI = parseYaml(readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf-8')) as {
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': boolean | string };
};

const unwrap = (value: string) => value.replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1');

/** cancel-in-progress 在给定事件下的取值，按 Actions 的表达式语义求值。 */
/** 每个事件真实的 ref 形状：PR 是 refs/pull/N/merge，master push 是 refs/heads/master。 */
const REF = { pull_request: 'refs/pull/2636/merge', push: 'refs/heads/master' } as const;

function cancelInProgress(eventName: keyof typeof REF) {
  const cancel = CI.concurrency['cancel-in-progress'];
  const context = { github: { event_name: eventName, workflow: 'CI', ref: REF[eventName] }, inputs: {} };
  return {
    group: interpolate(CI.concurrency.group, context, { format }),
    cancel: typeof cancel === 'string'
      ? isTruthy(evaluateExpression(unwrap(cancel), context, { format }))
      : cancel === true,
  };
}

/** 每个触发器在 master 上应得的 cancel 语义。加触发器必须同时在这里登记。 */
const EXPECTED: Record<string, boolean> = {
  pull_request: true,
  push: false,
};

describe('ci.yml concurrency per trigger', () => {
  it('only declares the triggers whose concurrency semantics are pinned here', () => {
    expect(Object.keys(CI.on ?? {}).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('runs ci.yml only on pull requests and on master pushes', () => {
    const on = CI.on as { push?: { branches?: string[] } };
    expect(on.push?.branches).toEqual(['master']);
  });

  for (const [event, expected] of Object.entries(EXPECTED)) {
    it(`${expected ? 'replaces' : 'does not cancel'} in-progress work on ${event}`, () => {
      expect(cancelInProgress(event as keyof typeof REF).cancel).toBe(expected);
    });
  }

  it('keeps pull requests and master in separate groups', () => {
    expect(cancelInProgress('pull_request').group).not.toBe(cancelInProgress('push').group);
  });
});
