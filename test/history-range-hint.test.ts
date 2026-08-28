/**
 * Range guidance in `botmux history` output (`rangeHint`).
 *
 * Why this exists: an agent reading history has to decide **how wide** to
 * search, and the pain report was concrete — in a thread session the model kept
 * searching only inside the topic while the context it needed sat in the
 * surrounding group chat, so it silently answered with a partial picture.
 *
 * The decisive fact is `sessionScope` (this session's own scope), NOT the chat's
 * `chat_mode`: a `/t` thread opened inside a 普通群 keeps `chat_mode='group'`
 * while its session is thread-scope. An agent reasoning from the group type
 * would wrongly conclude "I may search the whole chat" — and `--scope ambient`
 * would still be the required command. Both `--scope` gates in cmdHistory key
 * on `isChatScope` for exactly that reason, so the hint must too.
 *
 * cmdHistory itself is a large CLI function bound to live Lark calls, so rather
 * than stub the whole world this test re-evaluates the SHIPPED rangeHint
 * expression out of `dist/cli.js` against every (isChatScope, effectiveScope)
 * combination. That keeps the assertion anchored to the compiled artifact the
 * daemon actually runs — if someone edits the mapping in src without rebuilding,
 * or drops a branch, this fails.
 *
 * Run:  bun run vitest run test/history-range-hint.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST_CLI = join(process.cwd(), 'dist', 'cli.js');

/** Re-evaluate the compiled `rangeHint` ternary with controlled inputs. */
function makeRangeHintFn(): (isChatScope: boolean, effectiveScope: string) => string {
  const src = readFileSync(DIST_CLI, 'utf8');
  const start = src.indexOf('const rangeHint =');
  expect(start, 'rangeHint must be present in dist/cli.js — rebuild if this fails').toBeGreaterThan(-1);
  const end = src.indexOf('console.log(JSON.stringify({', start);
  expect(end).toBeGreaterThan(start);
  const expr = src.slice(start, end).trim().replace(/;$/, '');
  // eslint-disable-next-line no-new-func
  return new Function('isChatScope', 'effectiveScope', `${expr}; return rangeHint;`) as any;
}

describe('botmux history — rangeHint range guidance', () => {
  let rangeHint: (isChatScope: boolean, effectiveScope: string) => string;

  beforeAll(() => {
    if (!existsSync(DIST_CLI)) throw new Error(`${DIST_CLI} missing — run \`bun run build\` first`);
    rangeHint = makeRangeHintFn();
  });

  it('every scope combination produces non-empty guidance', () => {
    const combos: Array<[boolean, string]> = [
      [true, 'chat'],
      [false, 'thread'],
      [false, 'ambient'],
      [false, 'chat'],
    ];
    for (const [isChatScope, effectiveScope] of combos) {
      const out = rangeHint(isChatScope, effectiveScope);
      expect(out, `combo ${isChatScope}/${effectiveScope}`).toBeTruthy();
      expect(out).toContain('范围');
    }
  });

  it('thread-scope default tells the agent HOW to widen — the actual reported pain', () => {
    const out = rangeHint(false, 'thread');
    expect(out).toContain('只返回当前话题内');
    // The whole point: name the escape hatch, not just the current limitation.
    expect(out).toContain('botmux history --scope ambient --limit 20');
    // Widening reads messages outside the topic, so the privacy caveat must ride along.
    expect(out).toContain('隐私边界');
  });

  it('describes an OBSERVABLE trigger, not daemon-side invocations the model never sees', () => {
    // `/t` (parseForceTopicInvocation) is consumed by the daemon and stripped
    // before the prompt is built, so the model has never seen that token. Naming
    // it would read as an instruction the model cannot act on. The trigger must
    // be phrased as something visible from inside the session instead.
    for (const [ics, es] of [[true, 'chat'], [false, 'thread'], [false, 'ambient'], [false, 'chat']] as Array<[boolean, string]>) {
      const out = rangeHint(ics, es);
      expect(out, `combo ${ics}/${es} must not cite /t`).not.toMatch(/`\/t`|\/t\s|\/topic/);
    }
    // And the thread branch must still give the agent a way to recognize the case.
    expect(rangeHint(false, 'thread')).toContain('话题内的内容不足以说明任务背景');
  });

  it('chat-scope says ambient/thread do not apply, so the agent does not burn a failing call', () => {
    const out = rangeHint(true, 'chat');
    expect(out).toContain('chat-scope');
    expect(out).toContain('不适用');
    // cmdHistory hard-exits on `--scope ambient` in a chat-scope session; the
    // hint must pre-empt that instead of letting the agent discover it by error.
    expect(out).toContain('--scope ambient');
  });

  it('ambient result says it is OUTSIDE the topic and how to get back in', () => {
    const out = rangeHint(false, 'ambient');
    expect(out).toContain('话题之外');
    expect(out).toContain('已排除本话题');
    expect(out).toContain('botmux history');
  });

  it('thread session reading --scope chat is told the result includes the topic', () => {
    const out = rangeHint(false, 'chat');
    expect(out).toContain('整群');
    expect(out).toContain('含本话题内');
  });

  it('guidance is plain text — JSON consumers get no stray markdown emphasis', () => {
    for (const [ics, es] of [[true, 'chat'], [false, 'thread'], [false, 'ambient'], [false, 'chat']] as Array<[boolean, string]>) {
      expect(rangeHint(ics, es), `combo ${ics}/${es}`).not.toContain('**');
    }
  });

  it('thread and chat guidance are distinct (a single shared string would defeat the purpose)', () => {
    expect(rangeHint(false, 'thread')).not.toBe(rangeHint(true, 'chat'));
    expect(rangeHint(false, 'ambient')).not.toBe(rangeHint(false, 'thread'));
  });
});
