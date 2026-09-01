/**
 * Unit tests for ambient chat history filtering.
 *
 * Run: pnpm vitest run test/ambient-history.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { filterAmbientChatMessages } from '../src/im/lark/client.js';

function msg(id: string, createTime: string, rootId?: string) {
  return { message_id: id, create_time: createTime, ...(rootId ? { root_id: rootId } : {}) };
}

describe('filterAmbientChatMessages', () => {
  it('excludes current thread root/replies and messages created at or after the root', () => {
    const out = filterAmbientChatMessages([
      msg('m1', '1000'),
      msg('m2', '2000'),
      msg('root', '3000'),
      msg('reply', '3100', 'root'),
      msg('later', '4000'),
    ], 20, { beforeCreateTime: '3000', excludeRootMessageId: 'root' });

    expect(out.map(m => m.message_id)).toEqual(['m1', 'm2']);
  });

  it('caps after filtering so callers get the newest ambient tail', () => {
    const out = filterAmbientChatMessages([
      msg('m1', '1000'),
      msg('m2', '2000'),
      msg('m3', '2500'),
      msg('root', '3000'),
      msg('reply', '3100', 'root'),
    ], 2, { beforeCreateTime: '3000', excludeRootMessageId: 'root' });

    expect(out.map(m => m.message_id)).toEqual(['m2', 'm3']);
  });

  it('keeps messages with malformed timestamps instead of dropping context', () => {
    const out = filterAmbientChatMessages([
      msg('m1', 'not-a-number'),
      msg('root', '3000'),
    ], 20, { beforeCreateTime: '3000', excludeRootMessageId: 'root' });

    expect(out.map(m => m.message_id)).toEqual(['m1']);
  });
});
