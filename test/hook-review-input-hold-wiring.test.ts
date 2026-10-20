import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Hook review input hold', () => {
  // 源码结构护栏(K2)：Codex Hook 审核菜单接管 Enter/方向键时，自动投递的远程输入会误选
  // 「Trust all」（越过 hook 信任审批）或被菜单吞掉。菜单识别（shouldHoldInputForHookReview）
  // 在 test/stuck-detector.test.ts 有行为测试，但「写入前必须先查 hold」的闸口在 worker.ts
  // 闭包里（普通队列 flush 与绕过队列直写的 raw_input 两条路径），没有行为 seam。来历：#976。
  it('re-checks the hold right before both literal-write paths and parks input while it is set', () => {
    const flushStart = worker.indexOf('async function flushPending(): Promise<void>');
    expect(flushStart).toBeGreaterThanOrEqual(0);
    const flush = worker.slice(flushStart, worker.indexOf('\n}\n', flushStart));
    expect(flush).toMatch(/refreshHookReviewInputHold\([\s\S]*?if \(hookReviewInputHold\)/);

    const rawStart = worker.indexOf("case 'raw_input': {");
    expect(rawStart).toBeGreaterThanOrEqual(0);
    const raw = worker.slice(rawStart, worker.indexOf("case 'rename_session':", rawStart));
    const rawGate = raw.slice(0, raw.indexOf('deliverRawInput('));
    expect(rawGate).toMatch(/refreshHookReviewInputHold\([\s\S]*\bhookReviewInputHold\b[\s\S]*\.enqueueRaw\(/);
  });
});
