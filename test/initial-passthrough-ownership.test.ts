/**
 * Source-level guard for /goal-style raw-passthrough cold-start ownership.
 *
 * startInitialPassthroughSession() is a daemon.ts closure (not exported), and a
 * bot-started cold start sits behind the slash gates of both entries, so the
 * ownership invariant is pinned on the source.
 *
 * What must hold (PR #157 review blocker):
 *  - Ownership is the CALLER's decision. The function must NOT re-fill an
 *    explicitly-undefined ownerOpenId from the sender (`args.ownerOpenId ??
 *    senderOpenId` was the bug: a foreign-bot cold start got the bot as
 *    owner, so daemon-generated footers woke that bot again and owner-gated
 *    surfaces leaked to a bot).
 *  - The thread-reply injection point keeps the foreign-bot guard on BOTH
 *    ownerOpenId and ownerUnionId.
 *
 * The new-topic twin (handleNewTopic) is exercised for real in
 * listener-foreign-bot-owner-behavior.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

function fnRegion(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found in daemon.ts`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\nasync function ', start + 1);
  return src.slice(start, end > start ? end : undefined);
}

describe('raw-passthrough cold-start ownership', () => {
  // 源码结构护栏(K2)：会话 owner 是 daemon 认证的身份，owner-gated 面（restart/report/卡片）以它为准。
  // 冷启动 passthrough 的 owner 必须完全由调用方决定，函数内不得用 sender 回填；thread 入口在外部 bot
  // 发起时必须压掉 owner。startInitialPassthroughSession / executeThreadSlash 是 daemon.ts 闭包，bot 发起的
  // 冷启动被两个入口的 slash 闸门挡在现有 harness 之外。PR #157 review blocker：`ownerOpenId ?? senderOpenId`
  // 让外部 bot 成了 owner。
  it('takes session ownership only from the caller, and the thread entry withholds it from foreign bots', () => {
    const coldStart = fnRegion('startInitialPassthroughSession');
    expect(coldStart).not.toMatch(/\b(ownerOpenId|ownerUnionId|creatorOpenId)\s*\?\?/);
    expect(coldStart).toMatch(/session\.ownerOpenId\s*=\s*ownerOpenId\s*;/);
    expect(coldStart).toMatch(/session\.ownerUnionId\s*=\s*ownerUnionId\s*;/);

    const threadEntry = fnRegion('executeThreadSlash');
    const call = threadEntry.slice(threadEntry.indexOf('await startInitialPassthroughSession({'));
    expect(call).toMatch(/ownerOpenId:\s*isForeignBotSender\s*\?\s*undefined\s*:/);
    expect(call).toMatch(/ownerUnionId:\s*isForeignBotSender\s*\?\s*undefined\s*:/);
  });
});
