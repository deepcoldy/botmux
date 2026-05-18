/**
 * Unit tests for buildQuoteHint — the helper shared by handleNewTopic and
 * handleThreadReply that turns a parent_id on the inbound event into a
 * "[用户引用了消息 ...]" prompt prefix.
 *
 * Run:  pnpm vitest run test/quote-hint.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildQuoteHint } from '../src/im/lark/quote-hint.js';

describe('buildQuoteHint', () => {
  it('returns empty string when parent_id is absent', () => {
    const out = buildQuoteHint({ messageId: 'om_self' }, 'chat', 'oc_chat');
    expect(out).toBe('');
  });

  it('emits hint with the quoted message_id for a chat-scope quote-reply', () => {
    const out = buildQuoteHint({ parentId: 'om_quoted', messageId: 'om_self' }, 'chat', 'oc_chat');
    expect(out).toBe('[用户引用了消息 用 botmux quoted om_quoted 查看]\n');
  });

  it('emits hint when thread-scope user quotes a non-root sibling', () => {
    const out = buildQuoteHint({ parentId: 'om_sibling', messageId: 'om_self' }, 'thread', 'om_root');
    expect(out).toBe('[用户引用了消息 用 botmux quoted om_sibling 查看]\n');
  });

  it('suppresses hint when parent_id is the thread root (plain thread reply, not a user-visible quote)', () => {
    const out = buildQuoteHint({ parentId: 'om_root', messageId: 'om_self' }, 'thread', 'om_root');
    expect(out).toBe('');
  });

  it('suppresses hint when parent_id collapses to the current message id (defensive)', () => {
    const out = buildQuoteHint({ parentId: 'om_self', messageId: 'om_self' }, 'chat', 'oc_chat');
    expect(out).toBe('');
  });

  it('does NOT suppress when chat-scope anchor coincidentally equals parent_id (chatId vs message_id namespaces never collide in practice, but the check should not gate on it)', () => {
    // anchor is the chatId for chat-scope, oc_xxx — never equal to a message_id (om_xxx).
    // The implementation explicitly uses `null` for threadRoot in chat-scope so this
    // case is impossible to mis-trigger. Verifying the property holds anyway.
    const out = buildQuoteHint({ parentId: 'om_quoted', messageId: 'om_self' }, 'chat', 'om_quoted');
    expect(out).toBe('[用户引用了消息 用 botmux quoted om_quoted 查看]\n');
  });
});
