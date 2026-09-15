/**
 * fork-destination-store + chat-reply-mode-store 协作语义回归（issue #1400）。
 *
 * `/fork --create` 建群后：
 *   - fork 流程用 source:'fork-pin' + force 钉 per-chat chat-topic，marker 保留；
 *   - 用户之后显式 /reply-mode（含切回 new-topic，即使与 per-bot 默认同值）必须
 *     force 落 per-chat 条目并摘除 marker —— 显式群级设置永远优先；
 *   - restore 兜底只从「group + chat-scope + forkedFrom」的子会话行重建 marker
 *     （同群子话题 fork 是 thread-scope，不能误标）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const entry: any = { larkAppId: 'app', regularGroupReplyMode: 'new-topic' };

vi.mock('../src/bot-registry.js', () => ({
  // bot.config 与磁盘条目共用同一对象：setChatReplyMode 的内存态更新对
  // getExplicitChatReplyMode 立即可见。
  getBot: () => ({ config: entry }),
}));

vi.mock('../src/services/config-store.js', () => ({
  // In-memory read-modify-write：只执行 mutate，不落盘。
  rmwBotEntry: vi.fn(async (_appId: string, mutate: (e: any) => any) => {
    const out = mutate(entry);
    return { ok: true, result: out?.result };
  }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  markForkDestinationChat,
  unmarkForkDestinationChat,
  isForkDestinationChat,
  markForkDestinationChatsFromSessions,
  __clearForkDestinationChatsForTest,
} from '../src/services/fork-destination-store.js';
import {
  setChatReplyMode,
  getExplicitChatReplyMode,
} from '../src/services/chat-reply-mode-store.js';

const APP = 'app';
const CHAT = 'oc_fork';

beforeEach(() => {
  __clearForkDestinationChatsForTest();
  entry.regularGroupReplyMode = 'new-topic';
  delete entry.chatReplyModes;
});

describe('fork-destination-store — marker basics', () => {
  it('mark / isMarked / unmark are idempotent and bot-scoped', () => {
    expect(isForkDestinationChat(APP, CHAT)).toBe(false);
    markForkDestinationChat(APP, CHAT);
    markForkDestinationChat(APP, CHAT);
    expect(isForkDestinationChat(APP, CHAT)).toBe(true);
    // 同群另一个 bot 不受影响（marker 带 app 维度）。
    expect(isForkDestinationChat('app-other', CHAT)).toBe(false);
    unmarkForkDestinationChat(APP, CHAT);
    expect(isForkDestinationChat(APP, CHAT)).toBe(false);
  });
});

describe('markForkDestinationChatsFromSessions — restore 兜底', () => {
  it('marks group chat-scope forked child rows only', () => {
    markForkDestinationChatsFromSessions([
      { forkedFrom: 'sess-parent', scope: 'chat', chatType: 'group', chatId: 'oc_a', larkAppId: APP },
      // 同群 /fork 子话题：thread-scope，不能标记。
      { forkedFrom: 'sess-parent', scope: 'thread', chatType: 'group', chatId: 'oc_b', larkAppId: APP },
      // 普通会话（无 forkedFrom）。
      { scope: 'chat', chatType: 'group', chatId: 'oc_c', larkAppId: APP },
      // p2p fork。
      { forkedFrom: 'sess-parent', scope: 'chat', chatType: 'p2p', chatId: 'oc_d', larkAppId: APP },
      // 缺关键字段。
      { forkedFrom: 'sess-parent', scope: 'chat', chatId: undefined, larkAppId: APP },
    ]);
    expect(isForkDestinationChat(APP, 'oc_a')).toBe(true);
    expect(isForkDestinationChat(APP, 'oc_b')).toBe(false);
    expect(isForkDestinationChat(APP, 'oc_c')).toBe(false);
    expect(isForkDestinationChat(APP, 'oc_d')).toBe(false);
  });
});

describe('setChatReplyMode — fork pin 与用户显式切换的优先级', () => {
  it('fork-pin force-persists chat-topic even when it equals the per-bot default and keeps the marker', async () => {
    entry.regularGroupReplyMode = 'chat-topic';   // 与钉模式同值
    markForkDestinationChat(APP, CHAT);

    const r = await setChatReplyMode(APP, CHAT, 'chat-topic', {
      force: true,
      source: 'fork-pin',
    });

    expect(r.ok).toBe(true);
    // 没有 force 时会被 redundant 规则删掉；force 保证显式条目存在。
    expect(getExplicitChatReplyMode(APP, CHAT)).toBe('chat-topic');
    expect(isForkDestinationChat(APP, CHAT)).toBe(true);
  });

  it('explicit user switch to new-topic (even == per-bot default) persists the entry and releases the marker', async () => {
    // fork 先钉过（per-bot 默认恰为 new-topic）。
    markForkDestinationChat(APP, CHAT);
    entry.chatReplyModes = { [CHAT]: 'chat-topic' };

    // 用户显式切回 new-topic：/reply-mode 路径带 force。
    const r = await setChatReplyMode(APP, CHAT, 'new-topic', { force: true });

    expect(r.ok).toBe(true);
    expect(isForkDestinationChat(APP, CHAT)).toBe(false);
    expect(getExplicitChatReplyMode(APP, CHAT)).toBe('new-topic');
  });

  it('non-force legacy write of the default value stays tidy but still releases the marker', async () => {
    markForkDestinationChat(APP, CHAT);
    const r = await setChatReplyMode(APP, CHAT, 'new-topic');
    expect(r.ok).toBe(true);
    expect(isForkDestinationChat(APP, CHAT)).toBe(false);
    expect(getExplicitChatReplyMode(APP, CHAT)).toBeUndefined();
  });
});
