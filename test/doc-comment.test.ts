import { describe, expect, it } from 'vitest';

import {
  parseDocRef,
  chunkCommentText,
  DOC_COMMENT_MAX_CHARS,
  markBotAuthoredReply,
  isBotAuthoredReply,
  hasBotSentinel,
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
