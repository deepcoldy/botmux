import { describe, expect, it } from 'vitest';
import { selectGroupContextConversation } from '../src/services/group-context-scope.js';

type Message = {
  seq: number;
  messageId: string;
  chatId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  conversationScope?: 'main' | 'thread';
  extra?: string;
};
const message = (seq: number, fields: Partial<Message> = {}): Message => ({
  seq, messageId: `message-${seq}`, chatId: 'chat-a', ...fields,
});

describe('selectGroupContextConversation', () => {
  it('defaults to main and requires positive main proof even for legacy flat messages', () => {
    const sources = [
      message(1),
      message(2, { rootId: 'chat-a' }),
      message(3, { rootId: 'quoted-message', conversationScope: 'main' }),
      message(4, { conversationScope: 'thread' }),
      message(5, { threadId: 'native-seed' }),
      message(6, { rootId: 'ambiguous-root' }),
    ];
    expect(selectGroupContextConversation(sources).map(source => source.seq)).toEqual([3]);
  });

  it('uses later routing evidence to classify an earlier visible body without adding later bodies', () => {
    const beforeTurn = message(1, { messageId: 'native-reply', extra: 'visible earlier body' });
    const laterProof = message(2, { messageId: 'native-reply', threadId: 'native-a', extra: 'future body' });
    const bodies = [beforeTurn];
    const evidence = [beforeTurn, laterProof];
    expect(selectGroupContextConversation(bodies, { scope: 'main' }, evidence)).toEqual([]);
    expect(selectGroupContextConversation(bodies, { threadId: 'native-a' }, evidence)).toEqual([beforeTurn]);
    expect(selectGroupContextConversation(bodies, { threadId: 'native-a' }, evidence)[0]).toBe(beforeTurn);
  });

  it('still classifies source identities absent from additional evidence', () => {
    const sources = [message(1, { parentId: 'unknown-target' }), message(2, { conversationScope: 'main' })];
    expect(selectGroupContextConversation(sources, { scope: 'main' }, [message(3, { threadId: 'native-a' })]))
      .toEqual([sources[1]]);
  });

  it('withholds unproven parent-only replies but keeps explicitly main quotes', () => {
    const sources = [
      message(1, { parentId: 'quoted-message' }),
      message(2, { parentId: 'quoted-message', rootId: 'chat-a' }),
      message(3, { parentId: 'quoted-message', conversationScope: 'main' }),
      message(4, { parentId: 'quoted-message', rootId: 'chat-a', conversationScope: 'main' }),
    ];
    expect(selectGroupContextConversation(sources)).toEqual([sources[2], sources[3]]);
  });

  it('interprets a legacy requested root as thread scope without trusting root-only records', () => {
    const sources = [
      message(1, { messageId: 'starter', conversationScope: 'main' }),
      message(2, { rootId: 'starter', conversationScope: 'thread' }),
      message(3, { rootId: 'starter', threadId: 'native-a' }),
      message(4, { rootId: 'starter', conversationScope: 'main' }),
      message(5, { rootId: 'starter' }),
      message(6, { rootId: 'other', conversationScope: 'thread' }),
    ];
    expect(selectGroupContextConversation(sources, { rootId: 'starter' }).map(source => source.seq)).toEqual([1, 2, 3]);
  });

  it('selects a native topic seed without requiring a root', () => {
    const sources = [
      message(1, { threadId: 'native-a' }),
      message(2, { threadId: 'native-b' }),
      message(3),
    ];
    expect(selectGroupContextConversation(sources, { threadId: 'native-a' })).toEqual([sources[0]]);
    expect(selectGroupContextConversation(sources, { rootId: 'native-a' })).toEqual([sources[0]]);
  });

  it('prefers native topic identity when an otherwise matching root conflicts', () => {
    const sources = [
      message(1, { rootId: 'starter', threadId: 'native-a', conversationScope: 'thread' }),
      message(2, { rootId: 'starter', threadId: 'native-b', conversationScope: 'thread' }),
    ];
    expect(selectGroupContextConversation(sources, { scope: 'thread', rootId: 'starter', threadId: 'native-a' }))
      .toEqual([sources[0]]);
  });

  it('recovers identity metadata independent of revision order and returns original rows', () => {
    const sources = [
      message(3, { messageId: 'reply', extra: 'latest' }),
      message(1, { messageId: 'reply', conversationScope: 'thread', rootId: 'starter', threadId: 'native-a' }),
      message(2, { messageId: 'reply' }),
    ];
    const original = structuredClone(sources);
    sources.forEach(Object.freeze);
    Object.freeze(sources);
    const selected = selectGroupContextConversation(sources, { threadId: 'native-a' });
    expect(selected).toEqual(sources);
    expect(selected[0]).toBe(sources[0]);
    expect(selected[0].extra).toBe('latest');
    expect(selectGroupContextConversation(sources)).toEqual([]);
    expect(sources).toEqual(original);
  });

  it('keeps earlier native topic evidence when a later sparse revision claims main scope', () => {
    const sources = [
      message(2, { messageId: 'native-reply', conversationScope: 'main' }),
      message(1, { messageId: 'native-reply', threadId: 'native-a' }),
    ];
    expect(selectGroupContextConversation(sources)).toEqual([]);
    expect(selectGroupContextConversation(sources, { threadId: 'native-a' })).toEqual(sources);
  });

  it('retains main-origin starters in main and permits them explicitly as their topic root', () => {
    const sources = [
      message(2, { messageId: 'starter', conversationScope: 'thread', threadId: 'native-a' }),
      message(1, { messageId: 'starter', conversationScope: 'main' }),
    ];
    expect(selectGroupContextConversation(sources)).toEqual(sources);
    expect(selectGroupContextConversation(sources, { rootId: 'starter', threadId: 'native-a' })).toEqual(sources);
    expect(selectGroupContextConversation(sources, { threadId: 'native-a' })).toEqual([]);
  });

  it('does not share recovered routing across chat identities', () => {
    const sources = [
      message(1, { messageId: 'same', chatId: 'chat-a', conversationScope: 'thread', threadId: 'native-a' }),
      message(2, { messageId: 'same', chatId: 'chat-b', conversationScope: 'main' }),
    ];
    expect(selectGroupContextConversation(sources)).toEqual([sources[1]]);
  });

  it('honors an explicit main request even when legacy routing identifiers are present', () => {
    const sources = [message(1, { conversationScope: 'main' }), message(2, { conversationScope: 'thread', rootId: 'starter' })];
    expect(selectGroupContextConversation(sources, { scope: 'main', rootId: 'starter' })).toEqual([sources[0]]);
    expect(selectGroupContextConversation(sources, { scope: 'thread' })).toEqual([]);
  });
});
