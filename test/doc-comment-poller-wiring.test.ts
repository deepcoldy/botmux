// test/doc-comment-poller-wiring.test.ts
//
// retryPendingDocCommentDeliveries / pollWatchedDocComments 都没导出、跑通要 mock 整条
// daemon，所以按仓库已有做法（doc-comment-drop-signal）用**源码形状**钉接线：光给
// recordDocWatchActivity 写单测证明不了 daemon 真在接纳成功/读取失败时调了它。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

function regionBetween(startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  expect(start, `锚点失效: ${startAnchor}`).toBeGreaterThan(-1);
  const end = src.indexOf(endAnchor, start);
  expect(end, `锚点失效: ${endAnchor}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe('文档评论 poller 运行态接线（源码形状）', () => {
  const retryRegion = regionBetween(
    'async function retryPendingDocCommentDeliveries',
    'async function pollWatchedDocComments(',
  );
  const pollRegion = regionBetween(
    'async function pollWatchedDocComments(',
    'function normalizeDocNativeSubscriptionsBeforeSessionRestore',
  );

  it('pending 重试真接纳后记一次 dispatched', () => {
    expect(retryRegion).toContain("outcome: 'dispatched'");
  });

  it('--all 轮询真接纳后记 dispatched，且只在 handleDocComment 返回 ok 之后（不能提前记成功）', () => {
    expect(pollRegion).toContain("outcome: 'dispatched'");
    const dispatchIdx = pollRegion.indexOf('const ok = await handleDocComment(');
    const recordIdx = pollRegion.indexOf("outcome: 'dispatched'");
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(dispatchIdx);
  });

  it('应用身份读文档失败时记 poll-failed 并带真实错误信息（功能「配着」却静默失效最需要可见）', () => {
    expect(pollRegion).toContain("outcome: 'poll-failed'");
    expect(pollRegion).toContain('error: message');
  });
});
