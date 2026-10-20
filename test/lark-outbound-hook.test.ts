import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  request: vi.fn(),
  emitHookEvent: vi.fn(),
  sharing: false,
  observePublished: vi.fn(),
  getObservedMessage: vi.fn(),
}));

vi.mock('../src/services/group-context-settings-store.js', () => ({ getGroupContextSettings: () => ({ enabled: mocks.sharing }) }));
vi.mock('../src/services/group-context-runtime.js', () => ({ observePublishedGroupMessage: mocks.observePublished }));
vi.mock('../src/services/group-context-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/group-context-store.js')>(),
  getGroupContextMessage: mocks.getObservedMessage,
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({
    im: { v1: { message: { create: mocks.create, reply: mocks.reply } } },
    request: mocks.request,
  }),
  getAllBots: () => [],
  getBot: vi.fn(),
  formatLarkError: (value: unknown) => String(value),
  loadBotConfigs: () => [],
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: mocks.emitHookEvent,
}));

import { replyMessage, sendMessage, urgentMessage } from '../src/im/lark/client.js';

describe('Lark outbound hook provider replay suppression', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_send' } });
    mocks.reply.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } });
    mocks.request.mockReset().mockResolvedValue({ code: 0 });
    mocks.emitHookEvent.mockReset();
    mocks.sharing = false;
    mocks.observePublished.mockReset();
    mocks.getObservedMessage.mockReset();
  });

  it('keeps the ordinary first-send hook', async () => {
    await sendMessage('app', 'oc_chat', 'answer', 'text', 'stable-uuid', { sessionId: 'sid' });

    expect(mocks.emitHookEvent).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).toHaveBeenCalledWith('outbound.send', expect.objectContaining({
      messageId: 'om_send',
      uuid: 'stable-uuid',
      sessionId: 'sid',
    }));
  });

  it('records published content without relying on self-message echo only when opted in', async () => {
    await sendMessage('app', 'oc_chat', 'not recorded');
    expect(mocks.observePublished).not.toHaveBeenCalled();
    mocks.sharing = true;
    await sendMessage('app', 'oc_chat', 'shared conclusion');
    expect(mocks.observePublished).toHaveBeenCalledWith('app', expect.objectContaining({
      message_id: 'om_send', chat_id: 'oc_chat', body: { content: '{"text":"shared conclusion"}' },
    }), undefined, { conversationScope: 'main' });
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_parent', conversationScope: 'main' });
    await replyMessage('app', 'om_parent', 'shared reply');
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.objectContaining({ message_id: 'om_reply', chat_id: 'oc_chat' }), undefined, {});
  });

  it('carries actual publication destination when provider receipts omit topic metadata', async () => {
    mocks.sharing = true;
    await sendMessage('app', 'oc_chat', 'flat');
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'main' });
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockImplementation((_app, _chat, messageId) => ({ messageId, conversationScope: 'main' }));
    await replyMessage('app', 'om_root', 'topic reply', 'text', true);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_root' });
    await replyMessage('app', 'om_quote', 'flat quote', 'text', false);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      {});
  });

  it('allows a native event to classify a sparse reply whose target was historically main', async () => {
    const store = await vi.importActual<typeof import('../src/services/group-context-store.js')>('../src/services/group-context-store.js');
    const runtime = await vi.importActual<typeof import('../src/services/group-context-runtime.js')>('../src/services/group-context-runtime.js');
    const ingest = await import('../src/services/group-context-ingest.js');
    const directory = mkdtempSync(join(tmpdir(), 'botmux-sparse-reply-'));
    const previousDirectory = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = directory;
    store._resetGroupContextStoreForTest();
    try {
      mocks.sharing = true;
      mocks.getObservedMessage.mockImplementation(store.getGroupContextMessage);
      mocks.observePublished.mockImplementation(runtime.observePublishedGroupMessage);
      store.upsertGroupContextMessage('app', { messageId: 'om_parent', chatId: 'oc_chat', conversationScope: 'main', senderId: 'ou_user', senderType: 'user', msgType: 'text', text: 'main starter', createTime: Date.now() - 10 });
      mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
      await replyMessage('app', 'om_parent', 'reply body', 'text', false);
      const sparse = store.getGroupContextMessage('app', 'oc_chat', 'om_reply')!;
      expect(sparse).toMatchObject({ conversationScope: undefined, parentId: 'om_parent' });
      ingest.setGroupContextSettingsResolver(() => ({ enabled: true }));
      ingest.ingestGroupContextEvent('app', {
        sender: { sender_type: 'app', sender_id: { app_id: 'app' } },
        message: { message_id: 'om_reply', chat_id: 'oc_chat', chat_type: 'group', message_type: 'text', content: '{"text":"reply body"}', create_time: String(sparse.createTime), root_id: 'om_parent', parent_id: 'om_parent', thread_id: 'omt_created_later' },
      });
      expect(store.getGroupContextMessage('app', 'oc_chat', 'om_reply')).toMatchObject({ conversationScope: 'thread', rootId: 'om_parent', threadId: 'omt_created_later' });
      expect(mocks.request).not.toHaveBeenCalled();
    } finally {
      ingest.setGroupContextSettingsResolver(undefined);
      store._resetGroupContextStoreForTest();
      if (previousDirectory === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('inherits an observed native topic when reply_in_thread is omitted', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_nested', rootId: 'om_root', threadId: 'omt_topic', conversationScope: 'thread' });
    await replyMessage('app', 'om_nested', 'inherited topic', 'text', false);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_topic' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('inherits the current native topic of a starter originally observed in main chat', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_seed', threadId: 'omt_later', conversationScope: 'main' });
    await replyMessage('app', 'om_seed', 'inherited topic', 'text', false);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_seed', threadId: 'omt_later' });
  });

  it('leaves an unknown sparse root-only reply unclassified', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat', root_id: 'om_reply_tree' } });
    await replyMessage('app', 'om_unknown', 'unknown destination', 'text', false);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined, {});
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('does not invent a canonical root for a forced-thread reply to an unknown nested target', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    await replyMessage('app', 'om_unknown_nested', 'topic reply', 'text', true);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread' });
  });

  it('keeps the observed canonical root for a forced-thread reply to a nested target', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_nested', rootId: 'om_root', conversationScope: 'thread' });
    await replyMessage('app', 'om_nested', 'topic reply', 'text', true);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_root' });
  });

  it('uses a known main quote as the new topic seed instead of its quoted reply-tree root', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_quote', rootId: 'om_quoted', conversationScope: 'main' });
    await replyMessage('app', 'om_quote', 'new topic reply', 'text', true);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_quote' });
  });

  it('uses authoritative native receipt metadata before the observed target destination', async () => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat', root_id: 'om_actual', thread_id: 'omt_actual' } });
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_target', rootId: 'om_prior', threadId: 'omt_prior', conversationScope: 'thread' });
    await replyMessage('app', 'om_target', 'native answer', 'text', false);
    expect(mocks.observePublished).toHaveBeenLastCalledWith('app', expect.any(Object), undefined,
      { conversationScope: 'thread', rootId: 'om_actual', threadId: 'omt_actual' });
  });

  it('does not turn a recording failure into a failed send or a duplicate publication', async () => {
    mocks.sharing = true;
    mocks.observePublished.mockImplementation(() => { throw new Error('disk busy'); });
    await expect(sendMessage('app', 'oc_chat', 'answer')).resolves.toBe('om_send');
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it.each(['send', 'reply'] as const)('records an explicit native author only after a successful plain text %s', async kind => {
    mocks.sharing = true;
    mocks.getObservedMessage.mockReturnValue({ messageId: 'om_parent', conversationScope: 'main' });
    const groupContextAuthorOrigin = { appId: 'app', chatId: 'oc_chat', sessionId: 'sid', turnId: 'om_turn', epoch: 'native' };
    let acknowledge!: (value: unknown) => void;
    (kind === 'send' ? mocks.create : mocks.reply).mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const publishing = kind === 'send'
      ? sendMessage('app', 'oc_chat', 'Native text', 'text', undefined, undefined, { groupContextAuthorOrigin })
      : replyMessage('app', 'om_parent', 'Native text', 'text', false, undefined, undefined, { groupContextAuthorOrigin });
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    expect(mocks.observePublished).not.toHaveBeenCalled();
    acknowledge({ code: 0, data: { message_id: 'om_native' } });
    await publishing;
    expect(mocks.observePublished).toHaveBeenCalledWith('app', expect.objectContaining({
      message_id: 'om_native', chat_id: 'oc_chat', body: { content: '{"text":"Native text"}' },
    }), groupContextAuthorOrigin, kind === 'send' ? { conversationScope: 'main' } : {});
    expect(mocks.emitHookEvent.mock.calls.at(-1)?.[1]).not.toHaveProperty('groupContextAuthorOrigin');
    mocks.observePublished.mockClear();
    (kind === 'send' ? mocks.create : mocks.reply).mockRejectedValueOnce(new Error('provider failed'));
    const failed = kind === 'send'
      ? sendMessage('app', 'oc_chat', 'Not published', 'text', undefined, undefined, { groupContextAuthorOrigin })
      : replyMessage('app', 'om_parent', 'Not published', 'text', false, undefined, { chatId: 'oc_chat' }, { groupContextAuthorOrigin });
    await expect(failed).rejects.toThrow('provider failed');
    expect(mocks.observePublished).not.toHaveBeenCalled();
  });

  it('does not repeat send/reply hooks while reconciling an accepted provider UUID', async () => {
    await sendMessage(
      'app',
      'oc_chat',
      'answer',
      'text',
      'stable-send',
      { sessionId: 'sid' },
      { suppressHook: true },
    );
    await replyMessage(
      'app',
      'om_parent',
      'answer',
      'text',
      true,
      'stable-reply',
      { sessionId: 'sid' },
      { suppressHook: true },
    );

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });

  it('fences the post-provider hook and forwards its frozen managed origin', async () => {
    const beforeHook = vi.fn(async () => {});
    const hookOrigin = {
      ipcPort: 4310,
      sessionId: 'sid',
      capability: 'ab'.repeat(32),
      turnId: 'turn-1',
      dispatchAttempt: 2,
    };
    await sendMessage(
      'app', 'oc_chat', 'answer', 'text', undefined, { sessionId: 'sid' },
      { beforeHook, hookOrigin },
    );

    expect(beforeHook).toHaveBeenCalledOnce();
    expect(mocks.create.mock.invocationCallOrder[0])
      .toBeLessThan(beforeHook.mock.invocationCallOrder[0]!);
    expect(beforeHook.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.emitHookEvent.mock.invocationCallOrder[0]!);
    expect(mocks.emitHookEvent).toHaveBeenCalledWith(
      'outbound.send',
      expect.objectContaining({ messageId: 'om_send', content: 'answer' }),
      { managedOrigin: hookOrigin },
    );
  });

  it('drops only the hook when authority is revoked after provider acceptance', async () => {
    const beforeHook = vi.fn(async () => { throw new Error('origin rotated'); });
    await expect(sendMessage(
      'app', 'oc_chat', 'answer', 'text', undefined, { sessionId: 'sid' },
      { beforeHook },
    )).resolves.toBe('om_send');
    expect(beforeHook).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });

  it('sends each Buzz mode through the matching PATCH endpoint', async () => {
    for (const mode of ['app', 'sms', 'phone'] as const) {
      await urgentMessage('app', 'om_send', ['ou_user', 'ou_user'], mode);
      expect(mocks.request).toHaveBeenLastCalledWith({
        method: 'PATCH',
        url: `/open-apis/im/v1/messages/om_send/urgent_${mode}`,
        params: { user_id_type: 'open_id' },
        data: { user_id_list: ['ou_user'] },
      });
    }
  });
});
