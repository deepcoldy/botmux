/**
 * Tests for resolveRelayTargetRouting — the picker's target-landing decision.
 * resolveRegularGroupMode is mocked so we control the 普通群 mode directly
 * without standing up a bot registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveRegularGroupModeMock = vi.fn();
vi.mock('../src/services/chat-reply-mode-store.js', () => ({
  resolveRegularGroupMode: (...args: any[]) => resolveRegularGroupModeMock(...args),
}));

import { resolveRelayTargetRouting } from '../src/im/lark/relay-target-routing.js';

describe('resolveRelayTargetRouting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRegularGroupModeMock.mockReturnValue('chat');
  });

  const base = { larkAppId: 'cli_app', chatId: 'oc_chat' };

  it('rejects p2p chats', () => {
    const r = resolveRelayTargetRouting({ ...base, chatMode: 'p2p', message: { messageId: 'om_m' } });
    expect(r).toEqual({ reject: 'p2p' });
  });

  it('real-thread reply → thread-scope anchored at rootId (any group type)', () => {
    const r = resolveRelayTargetRouting({
      ...base,
      chatMode: 'group',
      message: { messageId: 'om_m', rootId: 'om_root', threadId: 'omt_1' },
    });
    expect(r).toEqual({ scope: 'thread', anchor: 'om_root' });
  });

  it('话题群 top-level (no thread_id) → thread-scope anchored at messageId', () => {
    const r = resolveRelayTargetRouting({ ...base, chatMode: 'topic', message: { messageId: 'om_m' } });
    expect(r).toEqual({ scope: 'thread', anchor: 'om_m' });
  });

  it('普通群 new-topic mode → thread-scope anchored at messageId', () => {
    resolveRegularGroupModeMock.mockReturnValue('new-topic');
    const r = resolveRelayTargetRouting({ ...base, chatMode: 'group', message: { messageId: 'om_m' } });
    expect(r).toEqual({ scope: 'thread', anchor: 'om_m' });
  });

  it('普通群 shared mode → thread-scope anchored at messageId (divergence from decideRouting)', () => {
    resolveRegularGroupModeMock.mockReturnValue('shared');
    const r = resolveRelayTargetRouting({ ...base, chatMode: 'group', message: { messageId: 'om_m' } });
    expect(r).toEqual({ scope: 'thread', anchor: 'om_m' });
  });

  it('普通群 flat (chat) mode top-level → chat-scope anchored at chatId', () => {
    resolveRegularGroupModeMock.mockReturnValue('chat');
    const r = resolveRelayTargetRouting({ ...base, chatMode: 'group', message: { messageId: 'om_m' } });
    expect(r).toEqual({ scope: 'chat', anchor: 'oc_chat' });
  });

  it('real-thread takes precedence over flat regular-group mode', () => {
    resolveRegularGroupModeMock.mockReturnValue('chat');
    const r = resolveRelayTargetRouting({
      ...base,
      chatMode: 'group',
      message: { messageId: 'om_m', rootId: 'om_root', threadId: 'omt_1' },
    });
    expect(r).toEqual({ scope: 'thread', anchor: 'om_root' });
  });
});
