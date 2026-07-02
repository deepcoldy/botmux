/**
 * Source-level guard for /goal-style raw-passthrough cold-start ownership.
 *
 * startInitialPassthroughSession() is a daemon.ts closure (not exported), so
 * ownership semantics are pinned the same way dashboard-attention-signals
 * pins handleThreadReply ordering: by asserting on the source.
 *
 * What must hold (PR #157 review blocker):
 *  - Ownership is the CALLER's decision. The function must NOT re-fill an
 *    explicitly-undefined ownerOpenId from the sender (`args.ownerOpenId ??
 *    senderOpenId` was the bug: a foreign-bot cold start got the bot as
 *    owner, so daemon-generated footers woke that bot again and owner-gated
 *    surfaces leaked to a bot).
 *  - The args type keeps ownerOpenId / ownerUnionId / creatorOpenId REQUIRED
 *    (may be undefined) so a new call site can't silently omit them.
 *  - The thread-reply injection point keeps the foreign-bot guard on BOTH
 *    ownerOpenId and ownerUnionId.
 *
 * Run: pnpm vitest run test/initial-passthrough-ownership.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

function fnRegion(name: string, span = 6000): string {
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${name} not found in daemon.ts`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('startInitialPassthroughSession ownership', () => {
  const region = fnRegion('startInitialPassthroughSession');

  it('never falls back from an explicit undefined owner to the sender', () => {
    expect(region).not.toContain('ownerOpenId ??');
    expect(region).not.toContain('creatorOpenId ??');
    expect(region).not.toContain('ownerUnionId ??');
  });

  it('declares ownership args as required (string | undefined), not optional', () => {
    expect(region).toContain('ownerOpenId: string | undefined;');
    expect(region).toContain('ownerUnionId: string | undefined;');
    expect(region).toContain('creatorOpenId: string | undefined;');
    expect(region).not.toContain('ownerOpenId?:');
    expect(region).not.toContain('creatorOpenId?:');
  });

  it('assigns session ownership straight from the caller-provided args', () => {
    expect(region).toContain('session.ownerOpenId = ownerOpenId;');
    expect(region).toContain('session.ownerUnionId = ownerUnionId;');
    expect(region).toContain('session.creatorOpenId = creatorOpenId;');
  });

  it('hands a registration loser to the post-rollback winner with live passthrough semantics', () => {
    expect(region).toContain('rollbackRejectedSessionAndGetWinner(activeSessions, creationKey, ds)');
    expect(region).toContain('deliverPassthroughToExistingSession(winner, cmd, commandContent, anchor, larkAppId)');
  });
});

describe('startInitialPassthroughSession call sites', () => {
  it('thread-reply injection keeps the foreign-bot guard on owner fields', () => {
    expect(src).toContain('ownerOpenId: isForeignBot ? undefined : threadSenderOpenId');
    expect(src).toMatch(/ownerUnionId: isForeignBot \? undefined :/);
  });

  it('every call site passes ownership explicitly', () => {
    // Each call must spell out ownerOpenId — TypeScript enforces this for
    // typed call sites; this guard catches `as any`-style escapes too.
    const calls = src.split('await startInitialPassthroughSession({').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      const body = call.slice(0, call.indexOf('});'));
      expect(body).toContain('cmd,');
      expect(body).toContain('ownerOpenId:');
      expect(body).toContain('creatorOpenId:');
    }
  });
});

describe('registration loser command handoff', () => {
  it('routes new-topic and thread daemon commands through the current winner', () => {
    expect(src).toContain(
      'rollbackRejectedSessionAndGetWinner(activeSessions, commandKey, commandDs)',
    );
    expect(src).toContain(
      'rollbackRejectedSessionAndGetWinner(activeSessions, commandKey, threadCommandDs)',
    );
    expect(src).toContain(
      'await handleCommand(cmd, anchor, { ...parsed, content: commandContent }, commandDeps, larkAppId)',
    );
    expect(src).toContain(
      'await handleCommand(cmd, anchor, cmdMessage, commandDeps, larkAppId)',
    );
  });

  it('prepared message handoff skips duplicate resolve, identity-learning, and hook effects', () => {
    const start = src.indexOf('async function handleThreadReply(');
    const end = src.indexOf('/**\n * 文档评论入口', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).toContain('if (!prepared) await resolveNonsupportMessage(data, larkAppId);');
    expect(region).toContain('if (!prepared) learnFromMentions(larkAppId, parsed.mentions);');
    expect(region).toMatch(/if \(!prepared\) \{[\s\S]*emitHookEvent\('thread\.reply'/);
  });
});
