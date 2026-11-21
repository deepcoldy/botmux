import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  reply: vi.fn(),
  forward: vi.fn(),
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
    im: { v1: { message: { create: mocks.create, reply: mocks.reply, forward: mocks.forward } } },
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

import { forwardMessage, replyMessage, sendMessage, sendUserMessage, urgentMessage } from '../src/im/lark/client.js';

describe('Lark outbound hook provider replay suppression', () => {
  it.each(['create', 'reply'] as const)('preserves the provider rejection code from %s for report recovery', async method => {
    mocks[method].mockResolvedValueOnce({ code: 230002, msg: 'bot not in chat' });
    const action = method === 'create' ? sendMessage('app', 'oc_chat', 'body') : replyMessage('app', 'om_root', 'body');
    await expect(action).rejects.toMatchObject({ code: 230002 });
    expect(mocks.emitHookEvent).not.toHaveBeenCalled();
  });

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

  it.each(['send', 'reply'] as const)('records the content acknowledged by the provider for %s, prose as written', async kind => {
    mocks.sharing = true;
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_chat' } });
    const raw = '协作说明：[协作技能](/home/alice/.agents/skills/collaboration/SKILL.md)';
    const action = kind === 'send' ? sendMessage('app', 'oc_chat', raw) : replyMessage('app', 'om_parent', raw);
    await action;
    const wire = (kind === 'send' ? mocks.create : mocks.reply).mock.calls[0][0].data.content;
    expect(JSON.parse(wire).text).toBe(raw);
    expect(mocks.observePublished.mock.calls[0][1].body.content).toBe(wire);
    expect(mocks.emitHookEvent.mock.calls[0][1].content).toBe(JSON.parse(wire).text);
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

describe('Lark send gate retry keeps one dedupe uuid', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.create.mockReset();
    mocks.reply.mockReset();
    mocks.forward.mockReset();
    mocks.request.mockReset();
    mocks.emitHookEvent.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  const transient502 = () => Object.assign(new Error('Request failed with status code 502'), {
    isAxiosError: true, response: { status: 502, data: {} },
  });

  it.each(['create', 'reply'] as const)('%s retried after a lost response reuses the same uuid', async method => {
    mocks[method]
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_ok' } });
    const action = method === 'create'
      ? sendMessage('app-retry-uuid', 'oc_chat', 'body')
      : replyMessage('app-retry-uuid', 'om_root', 'body');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(action).resolves.toBe('om_ok');

    expect(mocks[method]).toHaveBeenCalledTimes(2);
    const uuids = mocks[method].mock.calls.map(c => c[0].data.uuid);
    expect(uuids[0]).toEqual(expect.any(String));
    expect(uuids[0]).not.toBe('');
    expect(uuids[1]).toBe(uuids[0]);
    expect(uuids[0]).toMatch(/^[A-Za-z0-9_-]{1,50}$/);
  });

  // A per-operation constant would also satisfy the retry tests above, so each
  // primitive that mints a token needs its own cross-call independence check.
  it.each(['send', 'reply', 'forward', 'dm'] as const)('separate %s calls without a caller uuid do not share one', async operation => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    mocks.forward.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    const call = operation === 'send' ? () => sendMessage('app-retry-uuid', 'oc_chat', 'a')
      : operation === 'reply' ? () => replyMessage('app-retry-uuid', 'om_root', 'a')
        : operation === 'forward' ? () => forwardMessage('app-retry-uuid', 'om_src', 'oc_dest')
          : () => sendUserMessage('app-retry-uuid', 'ou_user', 'a');
    await call();
    await call();
    const uuids = operation === 'forward'
      ? mocks.forward.mock.calls.map(c => c[0].params.uuid)
      : operation === 'reply'
        ? mocks.reply.mock.calls.map(c => c[0].data.uuid)
        : mocks.create.mock.calls.map(c => c[0].data.uuid);
    expect(uuids[0]).toEqual(expect.any(String));
    expect(uuids[1]).not.toBe(uuids[0]);
  });

  it.each(['send', 'reply'] as const)('%s does not leak the generated uuid into the outbound hook', async operation => {
    mocks.create.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    mocks.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_x' } });
    if (operation === 'send') {
      await sendMessage('app-retry-uuid', 'oc_chat', 'a', 'text', undefined, { sessionId: 's' });
    } else {
      await replyMessage('app-retry-uuid', 'om_root', 'a', 'text', false, undefined, { sessionId: 's' });
    }
    // The wire must still carry a token; only the hook payload stays clean.
    const wire = operation === 'send'
      ? mocks.create.mock.calls[0][0].data.uuid
      : mocks.reply.mock.calls[0][0].data.uuid;
    expect(wire).toEqual(expect.any(String));
    expect(mocks.emitHookEvent).toHaveBeenCalledOnce();
    expect(mocks.emitHookEvent.mock.calls[0][1].uuid).toBeUndefined();
  });

  it('a caller-supplied uuid is sent unchanged on every gate retry', async () => {
    mocks.create
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_ok' } });
    const action = sendMessage('app-retry-uuid', 'oc_chat', 'body', 'text', 'caller-uuid');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(action).resolves.toBe('om_ok');
    expect(mocks.create.mock.calls.map(c => c[0].data.uuid)).toEqual(['caller-uuid', 'caller-uuid']);
  });

  it('thread reply keeps reply_in_thread and the uuid across a retry', async () => {
    mocks.reply
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_ok' } });
    const action = replyMessage('app-retry-uuid', 'om_root', 'body', 'text', true);
    await vi.advanceTimersByTimeAsync(10_000);
    await action;
    const [first, second] = mocks.reply.mock.calls.map(c => c[0].data);
    expect(first.reply_in_thread).toBe(true);
    expect(second.reply_in_thread).toBe(true);
    // Assert the shape first: comparing only `second.uuid === first.uuid` would
    // pass with both undefined, so it cannot prove the wire token exists.
    expect(first.uuid).toEqual(expect.any(String));
    expect(first.uuid).toMatch(/^[A-Za-z0-9_-]{1,50}$/);
    expect(second.uuid).toBe(first.uuid);
  });

  it('forward retried after a lost response reuses the same uuid in params', async () => {
    mocks.forward
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_fwd' } });
    const action = forwardMessage('app-retry-uuid', 'om_src', 'oc_dest');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(action).resolves.toBe('om_fwd');

    expect(mocks.forward).toHaveBeenCalledTimes(2);
    const params = mocks.forward.mock.calls.map(c => c[0].params);
    expect(params[0].receive_id_type).toBe('chat_id');
    expect(params[0].uuid).toEqual(expect.any(String));
    expect(params[0].uuid).toMatch(/^[A-Za-z0-9_-]{1,50}$/);
    expect(params[1].uuid).toBe(params[0].uuid);
  });

  it('sendUserMessage retry reuses one uuid', async () => {
    mocks.create
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_dm' } });
    const action = sendUserMessage('app-retry-uuid', 'ou_user', 'hi');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(action).resolves.toBe('om_dm');
    const uuids = mocks.create.mock.calls.map(c => c[0].data.uuid);
    expect(uuids[0]).toEqual(expect.any(String));
    expect(uuids[1]).toBe(uuids[0]);
  });

  // requestOptions takes a DIFFERENT wire branch (generic c.request instead of
  // the SDK create). Deadline DMs (codex notifier, card delivery) all go through
  // it, so it needs its own retry-reuse anchor.
  it('sendUserMessage retry on the deadline request branch reuses one uuid', async () => {
    mocks.request
      .mockRejectedValueOnce(transient502())
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_dm_deadline' } });
    const action = sendUserMessage('app-retry-uuid', 'ou_user', 'hi', 'text', undefined, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(action).resolves.toBe('om_dm_deadline');
    expect(mocks.request).toHaveBeenCalledTimes(2);
    const uuids = mocks.request.mock.calls.map(c => c[0].data.uuid);
    expect(uuids[0]).toEqual(expect.any(String));
    expect(uuids[1]).toBe(uuids[0]);
  });
});
