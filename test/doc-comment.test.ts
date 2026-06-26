import { describe, expect, it } from 'vitest';

import {
  parseDocRef,
  chunkCommentText,
  DOC_COMMENT_MAX_CHARS,
  markBotAuthoredReply,
  isBotAuthoredReply,
  hasBotSentinel,
  commentTriggerAllowed,
  BOT_REPLY_SENTINEL,
} from '../src/im/lark/doc-comment.js';

describe('parseDocRef', () => {
  it('parses a docx URL', () => {
    expect(parseDocRef('https://xxx.feishu.cn/docx/AbCd1234efGH5678ijKL')).toEqual({ kind: 'docx', token: 'AbCd1234efGH5678ijKL' });
  });
  it('parses a wiki URL', () => {
    expect(parseDocRef('https://xxx.feishu.cn/wiki/WnodeTOKEN1234567890')).toEqual({ kind: 'wiki', token: 'WnodeTOKEN1234567890' });
  });
  it('parses sheets / base / docs URLs', () => {
    expect(parseDocRef('https://x.feishu.cn/sheets/SHEETtoken1234567890')?.kind).toBe('sheets');
    expect(parseDocRef('https://x.feishu.cn/base/BASEtoken12345678901')?.kind).toBe('base');
    expect(parseDocRef('https://x.feishu.cn/docs/OLDdoctoken1234567890')?.kind).toBe('docs');
  });
  it('treats a bare long token as docx', () => {
    expect(parseDocRef('AbCd1234efGH5678ijKL')).toEqual({ kind: 'docx', token: 'AbCd1234efGH5678ijKL' });
  });
  it('returns null for unrecognizable input', () => {
    expect(parseDocRef('hello world')).toBeNull();
    expect(parseDocRef('short')).toBeNull();
  });
  it('ignores query strings and trailing path', () => {
    expect(parseDocRef('https://x.feishu.cn/docx/AbCd1234efGH5678ijKL?from=share')?.token).toBe('AbCd1234efGH5678ijKL');
  });
});

describe('chunkCommentText', () => {
  it('returns a single chunk when under the cap', () => {
    expect(chunkCommentText('hello')).toEqual(['hello']);
  });
  it('splits long text into multiple chunks under the cap', () => {
    const long = 'x'.repeat(DOC_COMMENT_MAX_CHARS * 2 + 100);
    const chunks = chunkCommentText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DOC_COMMENT_MAX_CHARS);
    expect(chunks.join('')).toBe(long);
  });
  it('prefers breaking on newline boundaries', () => {
    const head = 'a'.repeat(DOC_COMMENT_MAX_CHARS - 50);
    const tail = 'b'.repeat(200);
    const chunks = chunkCommentText(`${head}\n${tail}`);
    expect(chunks[0]).toBe(head);
  });
});

describe('bot-authored reply tracking (self-loop guard)', () => {
  it('marks and detects a reply id', () => {
    expect(isBotAuthoredReply('reply_xyz_unique_1')).toBe(false);
    markBotAuthoredReply('reply_xyz_unique_1');
    expect(isBotAuthoredReply('reply_xyz_unique_1')).toBe(true);
  });
  it('ignores empty ids', () => {
    markBotAuthoredReply('');
    expect(isBotAuthoredReply('')).toBe(false);
    expect(isBotAuthoredReply(undefined)).toBe(false);
  });
  it('detects the invisible sentinel in bot-authored text', () => {
    expect(hasBotSentinel(`some reply${BOT_REPLY_SENTINEL}`)).toBe(true);
    expect(hasBotSentinel('a normal user comment')).toBe(false);
    expect(hasBotSentinel(undefined)).toBe(false);
  });
});

describe('commentTriggerAllowed (mention-only trigger gate)', () => {
  const SELF = 'ou_selfbot';

  it("'all' mode triggers on any comment, regardless of mentions", () => {
    expect(commentTriggerAllowed('all', [], SELF)).toBe(true);
    expect(commentTriggerAllowed('all', ['ou_someone_else'], SELF)).toBe(true);
    // even when the bot's own open_id isn't known yet
    expect(commentTriggerAllowed('all', [], undefined)).toBe(true);
  });

  it("'mention-only' triggers when the comment @s this bot", () => {
    expect(commentTriggerAllowed('mention-only', [SELF], SELF)).toBe(true);
    expect(commentTriggerAllowed('mention-only', ['ou_other', SELF], SELF)).toBe(true);
  });

  it("'mention-only' does NOT trigger when the comment only @s other people (the reported bug)", () => {
    // 用户报的现象：评论只 @ 同事、没 @bot，却被触发。根因是早先信了事件级
    // is_mentioned（=「有任意 @」）。这里证明仅按正文 @person 列表判定后不再误触发。
    expect(commentTriggerAllowed('mention-only', ['ou_qiaoxiang'], SELF)).toBe(false);
    expect(commentTriggerAllowed('mention-only', ['ou_a', 'ou_b'], SELF)).toBe(false);
  });

  it("'mention-only' does NOT trigger when the comment @s nobody", () => {
    expect(commentTriggerAllowed('mention-only', [], SELF)).toBe(false);
  });

  it("'mention-only' drops conservatively when the bot's own open_id is unknown", () => {
    // 启动期 open_id 尚未探到：宁可漏触发也不误触发（调用方会先 await ensureBotOpenId）。
    expect(commentTriggerAllowed('mention-only', [SELF], undefined)).toBe(false);
    expect(commentTriggerAllowed('mention-only', [SELF], '')).toBe(false);
  });
});
