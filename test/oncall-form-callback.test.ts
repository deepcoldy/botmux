import { loadOncallPresetOptions } from '../src/services/oncall-preset-options.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: {} as any } },
  reply: vi.fn(), update: vi.fn(), withdraw: vi.fn(), membership: vi.fn(), mode: vi.fn(), ephemeral: vi.fn(), remove: vi.fn(), sender: vi.fn(), detail: vi.fn(), forward: vi.fn(), merge: vi.fn(), thread: vi.fn(), chat: vi.fn(),
}));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/client.js', () => ({ getChatModeStrict: mocks.mode, sendEphemeralCard: mocks.ephemeral,
  deleteEphemeralCard: mocks.remove, deleteMessage: mocks.withdraw, replyMessage: mocks.reply, updateMessage: mocks.update, resolveSender: mocks.sender, getMessageDetail: mocks.detail,
  forwardMessage: mocks.forward, mergeForwardMessages: mocks.merge, isBotInChat: mocks.membership, listThreadMessagesWithContext: mocks.thread, listChatMessagesUntil: mocks.chat }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
import { attachOncallGroupButton, recordOncallGroupDelivery, handleOncallGroupAction, handleOncallFormAction, snapshotOncallConversation, forwardOncallConversation, reconcileOncallReplyCard, retryPendingOncallHandoffs, refreshOncallSessionCard } from '../src/im/lark/oncall-group.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { larkApiError } from '../src/im/lark/lark-errors.js';
let dir: string; let fetcher: ReturnType<typeof vi.fn>;
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_source', rootId: 'om_root', messageId: 'om_reply', questionId: 'om_question', answer: 'answer' };
const event = (action: string, draft?: any, owner = 'ou_owner') => ({ operator: { open_id: owner },
  context: { open_chat_id: 'oc_source', open_message_id: draft?.messageId ?? 'om_reply' },
  action: { value: { action, ...(draft ? { draftId: draft.id, version: draft.version } : {}) } } }) as any;
const category = { id: 34, name: 'category', tenant_id: 12, type_action: 'create_chat', workflow_id: 10 };
const response = (data: any) => new Response(JSON.stringify({ code: 0, data }));
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'oncall-form-callback-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'private_card' };
  mocks.membership.mockResolvedValue(true); mocks.mode.mockResolvedValue('group'); mocks.sender.mockResolvedValue({ email: 'owner@example.test' });
  mocks.detail.mockResolvedValue({ body: { content: 'question' } }); mocks.ephemeral.mockResolvedValue('om_private');
  mocks.reply.mockResolvedValue('om_public'); mocks.update.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined); mocks.forward.mockResolvedValue('om_forwarded');
  mocks.withdraw.mockResolvedValue(true);
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, typeId: 999, region: 'legacy', emailDomain: 'example.test' } }));
  const store = new OncallGroupStore(dir); store.registerTurn('app', 'session', source.questionId); store.recordSource({ ...source, cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) });
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'secret'); fetcher = vi.fn().mockImplementation(async () => response({ region: { cn: [category] } })); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function draft() { return new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_owner', source, choices: { regions: { cn: [category] } }, region: 'cn', typeId: 34, priority: 'P2', description: 'question', messageId: 'om_private' }); }

describe('direct Oncall confirmation', () => {
  it('adds native confirmation only to the direct create action, with named destination and forwarding scope', async () => {
    fetcher.mockImplementation(async (url: string) => response(url.includes('/tenant/') ? { id: 12, name: '测试业务线' } : { region: { legacy: [{ ...category, id: 999, name: '付款问题' }] } }));
    await loadOncallPresetOptions(dir, 'app', 12);
    const compose = () => JSON.parse(attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [] } }), mocks.bot.config.oncallGroup, source.chatId, 'group',
      { appId: 'app', sessionId: 'session', questionId: source.questionId, phase: 'final', messageId: source.messageId })).body.elements[0].columns.at(-1).elements[0];
    mocks.bot.config.oncallGroup.flowMode = 'direct'; mocks.bot.config.oncallGroup.forwardMode = 'none';
    const button = compose();
    expect(button.confirm).toMatchObject({ title: { tag: 'plain_text' }, text: { tag: 'plain_text' } });
    expect(button.confirm.text.content).toContain('测试业务线'); expect(button.confirm.text.content).toContain('付款问题');
    expect(button.behaviors).toEqual([{ type: 'callback', value: { action: 'oncall_group_create' } }]);
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    mocks.bot.config.oncallGroup.flowMode = 'classify'; expect(compose().confirm).toBeUndefined();
    const groups = new OncallGroupStore(dir); groups.claim(source, 'ou_owner', { messageIds: [], cutoffMs: Date.now(), forwardMode: 'none' });
    groups.finish(source, { status: 'succeeded', openChatId: 'oc_created' }, groups.getRequest(source)!.attemptId);
    mocks.bot.config.oncallGroup.flowMode = 'direct';
    expect(compose().confirm).toBeUndefined(); expect(compose().behaviors[0].type).toBe('open_url');
  });
});

describe('personal Oncall form callbacks', () => {
  it.each(['topic', 'p2p'])('rejects unsupported %s containers without publishing a form or a ticket', async mode => {
    mocks.mode.mockResolvedValue(mode);
    expect((await handleOncallGroupAction(event('oncall_group_create'), 'app')).toast.type).toBe('error');
    expect(mocks.ephemeral).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends the form only to the verified clicker and cancellation never creates a ticket', async () => {
    expect((await handleOncallGroupAction(event('oncall_group_create'), 'app')).toast.type).toBe('info');
    expect(mocks.ephemeral).toHaveBeenCalledWith('app', 'oc_source', 'ou_owner', expect.any(String));
    const d = draft();
    expect((await handleOncallFormAction(event('oncall_group_form_cancel', d), 'app')).toast.type).toBe('info');
    expect(fetcher.mock.calls.every(call => !call[1]?.method || call[1].method === 'GET')).toBe(true);
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
  });
  it('rejects a different owner, stale version and changed configuration before any platform write', async () => {
    const d = draft();
    expect((await handleOncallFormAction(event('oncall_group_form_submit', d, 'ou_other'), 'app')).toast.type).toBe('error');
    expect((await handleOncallFormAction(event('oncall_group_form_submit', { ...d, version: 99 }), 'app')).toast.type).toBe('error');
    mocks.bot.config.oncallGroup.formDisplay = 'native';
    expect((await handleOncallFormAction(event('oncall_group_form_submit', d), 'app')).toast.type).toBe('error');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps a rejected classified request on the form path instead of using the legacy fixed category', async () => {
    const store = new OncallGroupStore(dir); store.claim(source); store.finish(source, { status: 'failed' }, store.getRequest(source)!.attemptId);
    await handleOncallGroupAction(event('oncall_group_create'), 'app');
    expect(mocks.ephemeral).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.every(call => !call[1]?.method || call[1].method === 'GET')).toBe(true);
  });
  it('allows an authenticated owner to cancel and remove a personal form after the feature is disabled', async () => {
    const d = draft(); mocks.bot.config.oncallGroup.enabled = false;
    expect((await handleOncallFormAction(event('oncall_group_form_cancel', d), 'app')).toast.type).toBe('info');
    expect(mocks.remove).toHaveBeenCalledWith('app', 'om_private');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('restores the existing group link after feedback and does not reactivate an older source', () => {
    const store = new OncallGroupStore(dir); store.claim(source); store.finish(source, { status: 'succeeded', openChatId: 'oc_created' }, store.getRequest(source)!.attemptId);
    const base = { schema: '2.0', body: { elements: [] } };
    const restored = reconcileOncallReplyCard('app', source.messageId, base);
    const button = restored.body.elements[0].columns.at(-1).elements.find((e: any) => e.tag === 'button');
    expect(button.behaviors[0].type).toBe('open_url'); expect(button.behaviors[0].default_url).toContain('oc_created');
    store.registerTurn('app', 'session', 'om_next'); store.recordSource({ ...source, questionId: 'om_next', messageId: 'om_new' });
    expect(reconcileOncallReplyCard('app', source.messageId, restored).body.elements[0].columns.at(-1).elements[0].behaviors[0].default_url).toContain('oc_created');
  });
  it('restores the prior selection and version when replacement card publication fails', async () => {
    const d = draft(); mocks.ephemeral.mockRejectedValueOnce(new Error('send failed'));
    const e = event('oncall_group_form_priority', d); e.action.option = 'P1';
    expect((await handleOncallFormAction(e, 'app')).toast.type).toBe('error');
    await new OncallFormStore(dir).use('app', d.id, 'ou_owner', async current => {
      expect(current.priority).toBe('P2'); expect(current.version).toBe(d.version); expect(current.messageId).toBe('om_private');
    });
  });
  it('refreshes every card in the session after creating its shared group', async () => {
    const base = { schema: '2.0', body: { elements: [] } };
    const groups = new OncallGroupStore(dir);
    const second = { ...source, questionId: 'om_next', messageId: 'om_newest', turnNumber: 2, cardJson: JSON.stringify(base) };
    groups.registerTurn('app', 'session', second.questionId); groups.recordSource(second);
    groups.claim(second, 'ou_owner', { messageIds: [], cutoffMs: Date.now(), forwardMode: 'none' });
    groups.finish(second, { status: 'succeeded', openChatId: 'oc_created' }, groups.getRequest(second)!.attemptId);
    await refreshOncallSessionCard(second);
    expect(mocks.update.mock.calls.map(call => call[1]).sort()).toEqual(['om_newest', 'om_reply']);
    for (const [, , raw] of mocks.update.mock.calls) {
      const button = JSON.parse(raw).body.elements[0].columns.at(-1).elements[0];
      expect(button.behaviors[0]).toMatchObject({ type: 'open_url', default_url: expect.stringContaining('oc_created') });
    }
    expect(groups.getRequest(source)?.openChatId).toBe('oc_created');
    expect(groups.pendingHandoffs('app')).toHaveLength(0);
    const fresh = attachOncallGroupButton(JSON.stringify(base), mocks.bot.config.oncallGroup, source.chatId, 'group',
      { appId: 'app', sessionId: 'new_session', questionId: 'om_fresh', phase: 'final' });
    expect(JSON.parse(fresh).body.elements[0].columns.at(-1).elements[0].behaviors[0].type).toBe('callback');
  });
  it('retains session state when an older round redraws after a newer one', () => {
    const base = { schema: '2.0', body: { elements: [] } };
    const groups = new OncallGroupStore(dir);
    groups.registerTurn('app', 'session', 'om_next');
    groups.recordSource({ ...source, questionId: 'om_next', messageId: 'om_newest', turnNumber: 2 });
    groups.claim(source, 'ou_owner', { messageIds: [], cutoffMs: Date.now(), forwardMode: 'none' });
    groups.finish(source, { status: 'succeeded', openChatId: 'oc_created' }, groups.getRequest(source)!.attemptId);
    recordOncallGroupDelivery(dir, { ...source, turnNumber: 1, card: base });
    expect(groups.latest('app', 'session')?.messageId).toBe('om_newest');
    const card = reconcileOncallReplyCard('app', source.messageId, base);
    expect(card.body.elements[0].columns.at(-1).elements[0].behaviors[0].default_url).toContain('oc_created');
  });
});

describe('original conversation handoff', () => {
  it('stops an initial handoff when disabled during a send and resumes only the remainder after re-enabling', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    mocks.bot.config.oncallGroup.flowMode = 'direct';
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_reply', create_time: '200' },
    ] });
    fetcher.mockResolvedValue(response({ oncall_flow_id: '123', open_chat_id: 'oc_created' }));
    mocks.forward.mockImplementationOnce(async () => { mocks.bot.config.oncallGroup.enabled = false; return 'om_firstReceipt'; });
    await handleOncallGroupAction(event('oncall_group_create'), 'app');
    expect(mocks.forward.mock.calls.map(call => call[1])).toEqual(['om_question']);
    mocks.bot.config.oncallGroup.enabled = true;
    await retryPendingOncallHandoffs('app');
    expect(mocks.forward.mock.calls.map(call => call[1])).toEqual(['om_question', 'om_reply']);
  });
  it('isolates a registered new session before its first reply card has been published', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    new OncallGroupStore(dir).registerTurn('app', 'new-session', 'om_newquestion', { chatId: source.chatId, rootId: source.rootId });
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_reply', create_time: '200' },
      { message_id: 'om_newquestion', create_time: '300' }, { message_id: 'om_newfile', create_time: '400' },
    ] });
    expect((await snapshotOncallConversation(source)).messageIds).toEqual(['om_question', 'om_reply']);
  });
  it('collects all rounds and excludes a later new session in the same topic', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const groups = new OncallGroupStore(dir);
    const second = { ...source, questionId: 'om_q2', messageId: 'om_a2' };
    groups.registerTurn('app', 'session', second.questionId); groups.recordSource(second);
    const fresh = { ...source, sessionId: 'fresh', questionId: 'om_q3', messageId: 'om_a3' };
    groups.registerTurn('app', 'fresh', fresh.questionId); groups.recordSource(fresh);
    groups.recordSource({ ...source, messageId: 'om_lateOld' });
    const control = new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_owner', source,
      choices: { regions: {} }, region: '', priority: 'P2', description: '', messageId: 'om_form' });
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_reply', create_time: '200' },
      { message_id: control.messageId, create_time: '250' }, { message_id: 'om_q2', create_time: '300' },
      { message_id: 'om_image', create_time: '350' }, { message_id: 'om_a2', create_time: '400' },
      { message_id: 'om_q3', create_time: '500' }, { message_id: 'om_a3', create_time: '600' },
      { message_id: 'om_lateOld', create_time: '550' },
    ] });
    expect((await snapshotOncallConversation(second)).messageIds).toEqual(['om_question', 'om_reply', 'om_q2', 'om_image', 'om_a2']);
    expect((await snapshotOncallConversation(fresh)).messageIds).toEqual(['om_q3', 'om_a3']);
  });
  it('adopts the per-question record and forwards only missing earlier rounds at the original cutoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const groups = new OncallGroupStore(dir);
    const second = { ...source, questionId: 'om_q2', messageId: 'om_a2', cardJson: source.cardJson };
    groups.registerTurn('app', 'session', second.questionId); groups.recordSource(second);
    const key = createHash('sha256').update(JSON.stringify(['app', source.chatId, second.questionId])).digest('hex');
    mkdirSync(join(dir, 'oncall-groups', 'requests'), { recursive: true });
    writeFileSync(join(dir, 'oncall-groups', 'requests', key + '.json'), JSON.stringify({ status: 'succeeded', questionId: second.questionId,
      sourceMessageId: second.messageId, openChatId: 'oc_created', attemptId: 'attempt', submittedAtMs: 500, forwardMode: 'merge',
      messageIdsSnapshot: ['om_q2', 'om_a2'], forwarded: ['om_q2', 'om_a2'], forwardedMessageIds: { om_q2: 'om_oldbatch', om_a2: 'om_oldbatch' } }));
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_reply', create_time: '200' },
      { message_id: 'om_q2', create_time: '300' }, { message_id: 'om_a2', create_time: '400' }, { message_id: 'om_later', create_time: '600' },
    ] });
    mocks.merge.mockResolvedValue({ messageId: 'om_newbatch', invalidMessageIds: [] });
    expect(groups.getRequest(source)?.conversationScopePending).toBe(true);
    await forwardOncallConversation(second);
    expect(mocks.merge.mock.calls.map(call => call[1])).toEqual([['om_question', 'om_reply']]);
    const restored = new OncallGroupStore(dir);
    expect(restored.getRequest(source)).toMatchObject({ openChatId: 'oc_created', conversationScopePending: false, forwardedMessageIds: { om_q2: 'om_oldbatch', om_a2: 'om_oldbatch' } });
    expect(restored.getRequest(source)?.messageIdsSnapshot).toEqual(['om_question', 'om_reply', 'om_q2', 'om_a2']);
    await forwardOncallConversation(source);
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resolves a legacy uncertain batch with its original UUID before forwarding missing prior rounds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const groups = new OncallGroupStore(dir);
    const second = { ...source, questionId: 'om_q2', messageId: 'om_a2' };
    groups.registerTurn('app', 'session', second.questionId); groups.recordSource(second);
    const key = createHash('sha256').update(JSON.stringify(['app', source.chatId, second.questionId])).digest('hex');
    mkdirSync(join(dir, 'oncall-groups', 'requests'), { recursive: true });
    writeFileSync(join(dir, 'oncall-groups', 'requests', key + '.json'), JSON.stringify({ status: 'succeeded', questionId: second.questionId,
      sourceMessageId: second.messageId, openChatId: 'oc_created', attemptId: 'attempt', submittedAtMs: 500, forwardMode: 'merge',
      messageIdsSnapshot: ['om_q2', 'om_a2'], forwarding: { messageId: 'om_q2', messageIds: ['om_q2', 'om_a2'], startedAtMs: 500 } }));
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_reply', create_time: '200' },
      { message_id: 'om_q2', create_time: '300' }, { message_id: 'om_a2', create_time: '400' },
    ] });
    mocks.merge.mockResolvedValue({ messageId: 'om_batch', invalidMessageIds: [] });
    await forwardOncallConversation(second);
    expect(mocks.merge.mock.calls.map(call => call[1])).toEqual([['om_q2', 'om_a2'], ['om_question', 'om_reply']]);
    const originalUuid = createHash('sha256').update(JSON.stringify(['attempt', ['merge', ['om_q2', 'om_a2']]])).digest('hex').slice(0, 32);
    expect(mocks.merge.mock.calls[0][3]).toBe(originalUuid);
    expect(groups.getRequest(second)?.forwarded).toHaveLength(4);
  });
  it('includes non-triggering public image and attachment messages in chronological order and excludes a later turn', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_root', create_time: '50' }, { message_id: 'om_question', create_time: '100' },
      { message_id: 'om_image', create_time: '200', msg_type: 'image' }, { message_id: 'om_reply', create_time: '300' },
      { message_id: 'om_file', create_time: '400', msg_type: 'file' }, { message_id: 'om_later', create_time: '1100' },
    ] });
    expect(await snapshotOncallConversation(source)).toEqual({ forwardMode: 'individual', cutoffMs: 1000, messageIds: ['om_question', 'om_image', 'om_reply', 'om_file'] });
  });
  it('does not forward neighbouring sessions from a chat time window or an unverified thread fallback', async () => {
    const messages = [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_foreign', create_time: '200' },
      { message_id: 'om_reply', create_time: '300' }, { message_id: 'om_file', parent_id: 'om_question', create_time: '400' },
    ];
    mocks.chat.mockResolvedValue(messages);
    expect((await snapshotOncallConversation({ ...source, rootId: undefined })).messageIds).toEqual(['om_question', 'om_reply', 'om_file']);
    mocks.thread.mockResolvedValue({ verifiedThread: false, messages });
    expect((await snapshotOncallConversation(source)).messageIds).toEqual(['om_question', 'om_reply', 'om_file']);
  });
  it('keeps an uncertain forward durable, retries with the same uuid inside the window, and blocks expired retries', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const store = new OncallGroupStore(dir); store.claim(source, 'ou_owner', { messageIds: ['om_question', 'om_reply'], cutoffMs: 1000 });
    const attempt = store.getRequest(source)!.attemptId; store.finish(source, { status: 'succeeded', openChatId: 'oc_created' }, attempt);
    mocks.forward.mockRejectedValueOnce(new Error('timeout')); await forwardOncallConversation(source);
    expect(store.getRequest(source)?.forwarding?.messageId).toBe('om_question');
    await forwardOncallConversation(source);
    expect(mocks.forward.mock.calls[0][3]).toBe(mocks.forward.mock.calls[1][3]);
    expect(store.getRequest(source)?.forwarded).toEqual(['om_question', 'om_reply']);
    store.finish(source, { status: 'succeeded', forwarded: [], forwarding: { messageId: 'om_question', startedAtMs: 1000 } }, attempt);
    vi.setSystemTime(1000 + 60 * 60_000); const count = mocks.forward.mock.calls.length;
    await forwardOncallConversation(source);
    expect(mocks.forward).toHaveBeenCalledTimes(count); expect(store.getRequest(source)?.forwardingBlocked).toBe(true);
  });
});


describe('topic classification card and group handoff', () => {
  async function open() {
    mocks.bot.config.oncallGroup.formDisplay = 'thread_card'; mocks.mode.mockResolvedValue('topic');
    const result = await handleOncallGroupAction(event('oncall_group_create'), 'app');
    expect(result.toast.type).toBe('info');
    const current = new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_owner', source, choices: { regions: { cn: [category] } }, region: 'cn', priority: 'P2', description: 'question' });
    expect(current.visibility).toBe('thread'); expect(current.messageId).toBe('om_public');
    return current;
  }
  it('publishes a second ordinary card in the same topic and restricts interaction to its initiator', async () => {
    const d = await open();
    expect(mocks.reply).toHaveBeenCalledWith('app', 'om_reply', expect.any(String), 'interactive', true, d.id);
    expect(mocks.ephemeral).not.toHaveBeenCalled();
    expect((await handleOncallFormAction(event('oncall_group_form_submit', d, 'ou_other'), 'app')).toast.type).toBe('error');
    expect(fetcher.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
  });
  it('persists selection before ACK and recovers a lost post-ACK publication without applying stale input', async () => {
    const d = await open(); const e = event('oncall_group_form_category', d); e.action.option = '34';
    const result = await handleOncallFormAction(e, 'app');
    expect(result.toast.type).toBe('info'); expect(mocks.update).not.toHaveBeenCalled();
    const submit = result.deferredCard.data.elements.at(-1).actions[0];
    expect(submit.disabled).toBe(false); expect(submit.value.version).toBe(1);
    await new OncallFormStore(dir).use('app', d.id, 'ou_owner', async current => {
      expect(current.version).toBe(1); expect(current.typeId).toBe(34);
    });
    // Simulate the deferred PATCH being lost: an old view only recovers state.
    e.action.option = 'invalid';
    const recovered = await handleOncallFormAction(e, 'app');
    expect(recovered.deferredCard.data).toEqual(result.deferredCard.data);
    expect(mocks.update).not.toHaveBeenCalled();
    await handleOncallGroupAction(event('oncall_group_create'), 'app');
    expect(mocks.reply).toHaveBeenCalledTimes(1); expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it('replays a cancelled terminal card after a lost post-ACK update without creating a ticket', async () => {
    const d = await open(); const e = event('oncall_group_form_cancel', d);
    const cancelled = await handleOncallFormAction(e, 'app');
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.update.mockRejectedValueOnce(new Error('lost terminal update'));
    await expect(cancelled.afterAck()).rejects.toThrow();
    const recovered = await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    await recovered.afterAck();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true);
    expect((await handleOncallFormAction(event('oncall_group_form_cancel', d, 'ou_other'), 'app')).toast.type).toBe('error');
  });
  it('creates the selected category, waits for membership, resumes after restart and forwards only the original conversation', async () => {
    const d = await open(); const choose = event('oncall_group_form_category', d); choose.action.option = '34';
    await handleOncallFormAction(choose, 'app');
    const selected = { ...d, version: 1 };
    fetcher.mockImplementation(async (url: string, init: any) => url.endsWith('/chat/')
      ? response({ oncall_flow_id: '123', open_chat_id: 'oc_created' })
      : url.includes('/workflow/') ? response({ tenant_id: 12, type_id: 34, config: '[]' })
        : response({ region: { cn: [{ ...category, question_type_stage_list: ['doc_search', 'self_diagnose'] }] } }));
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_question', create_time: '100' }, { message_id: 'om_image', create_time: '200', msg_type: 'image' },
      { message_id: 'om_reply', create_time: '300' }, { message_id: 'om_file', create_time: '400', msg_type: 'file' },
      { message_id: 'om_public', create_time: '500', msg_type: 'interactive', body: { content: JSON.stringify({ elements: [{ tag: 'action', actions: [{ tag: 'select_static' }] }] }) } },
    ] });
    mocks.membership.mockResolvedValue(false);
    const result = await handleOncallFormAction(event('oncall_group_form_submit', selected), 'app');
    expect(result.toast.type).toBe('warning'); expect(mocks.forward).not.toHaveBeenCalled();
    await result.afterAck();
    expect(mocks.withdraw).toHaveBeenCalledWith('app', d.messageId);
    expect(mocks.update.mock.calls.every(call => call[1] !== d.messageId)).toBe(true);
    const store = new OncallGroupStore(dir); expect(store.getRequest(source)).toMatchObject({ status: 'succeeded', openChatId: 'oc_created', handoffError: 'waiting_for_bot' });
    expect(store.pendingHandoffs('app')).toHaveLength(1);
    mocks.membership.mockResolvedValue(true); await retryPendingOncallHandoffs('app'); await refreshOncallSessionCard(source);
    expect(mocks.forward.mock.calls.map(call => call[1])).toEqual(['om_question', 'om_image', 'om_reply', 'om_file']);
    expect(store.pendingHandoffs('app')).toHaveLength(0);
    const creates = fetcher.mock.calls.filter(call => call[0].endsWith('/chat/'));
    expect(creates).toHaveLength(1); expect(JSON.parse(creates[0][1].body)).toMatchObject({ type_id: 34, region: 'cn', priority: 'P2' });
    expect(mocks.update.mock.calls.some(call => call[1] === 'om_reply' && call[2].includes('openChatId=oc_created'))).toBe(true);
    // A late callback only retries retirement, never creates another group.
    const closed = await handleOncallFormAction(event('oncall_group_form_submit', selected), 'app');
    mocks.withdraw.mockResolvedValueOnce(false);
    await expect(closed.afterAck()).rejects.toThrow();
    await closed.afterAck();
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/chat/'))).toHaveLength(1);
  });
});


describe('Oncall forwarding delivery mode', () => {
  it('does not read conversation history when forwarding is disabled', async () => {
    mocks.bot.config.oncallGroup.forwardMode = 'none';
    mocks.thread.mockRejectedValueOnce(new Error('history unavailable'));
    expect(await snapshotOncallConversation(source)).toMatchObject({ messageIds: [], forwardMode: 'none' });
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled();
  });
  it.each(['direct', 'classify'])('creates a group through %s without forwarding or waiting for membership', async flowMode => {
    mocks.bot.config.oncallGroup = { ...mocks.bot.config.oncallGroup, flowMode, forwardMode: 'none' };
    fetcher.mockImplementation(async (url: string) => url.endsWith('/chat/')
      ? response({ oncall_flow_id: '123', open_chat_id: 'oc_created' })
      : url.includes('/workflow/') ? response({ tenant_id: 12, type_id: 34, config: '[]' })
        : response({ region: { cn: [category] } }));
    if (flowMode === 'direct') await handleOncallGroupAction(event('oncall_group_create'), 'app');
    else expect((await handleOncallFormAction(event('oncall_group_form_submit', draft()), 'app')).toast.type).toBe('success');
    const request = new OncallGroupStore(dir).getRequest(source)!;
    expect(request).toMatchObject({ status: 'succeeded', openChatId: 'oc_created', forwardMode: 'none', messageIdsSnapshot: [] });
    expect(request.handoffError).toBeUndefined();
    expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.forward).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled(); expect(mocks.membership).not.toHaveBeenCalled();
    // A restarted worker must retain the submitted mode, even if configuration changed.
    mocks.bot.config.oncallGroup.forwardMode = 'individual';
    await forwardOncallConversation(source); await retryPendingOncallHandoffs('app');
    expect(new OncallGroupStore(dir).pendingHandoffs('app')).toEqual([]);
    expect(mocks.forward).not.toHaveBeenCalled(); expect(mocks.membership).not.toHaveBeenCalled();
    const card = JSON.parse(attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [] } }), mocks.bot.config.oncallGroup,
      source.chatId, 'group', { appId: 'app', sessionId: 'session', questionId: source.questionId, phase: 'final', messageId: source.messageId }));
    const elements = card.body.elements[0].columns.at(-1).elements;
    expect(elements.filter((e: any) => e.tag === 'button')).toHaveLength(1);
    expect(elements[0].behaviors[0]).toMatchObject({ type: 'open_url', default_url: expect.stringContaining('oc_created') });
  });

  const seed = (ids: string[], mode: 'merge' | 'individual') => {
    const store = new OncallGroupStore(dir); store.claim(source, 'ou_owner', { messageIds: ids, cutoffMs: Date.now(), forwardMode: mode });
    store.finish(source, { status: 'succeeded', openChatId: 'oc_created' }, store.getRequest(source)!.attemptId); return store;
  };
  const handoffElements = () => JSON.parse(attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    mocks.bot.config.oncallGroup, source.chatId, 'group', {
      appId: 'app', sessionId: 'session', questionId: source.questionId, phase: 'final', messageId: source.messageId,
    })).body.elements[0].columns.at(-1).elements;

  it.each([
    larkApiError('forward message', { code: 230070, msg: 'restricted' }),
    { response: { data: { code: 230070, msg: 'restricted' } } },
  ])('skips a restricted original without blocking later messages or treating it as delivered (%#)', async error => {
    const store = seed(['om_question', 'om_restricted', 'om_reply'], 'individual');
    mocks.forward.mockResolvedValueOnce('om_first').mockRejectedValueOnce(error).mockResolvedValueOnce('om_last');
    await forwardOncallConversation(source);
    const request = new OncallGroupStore(dir).getRequest(source)!;
    expect(mocks.forward.mock.calls.map(call => call[1])).toEqual(['om_question', 'om_restricted', 'om_reply']);
    expect(request.forwarded).toEqual(['om_question', 'om_reply']);
    expect(request.forwardedMessageIds).toEqual({ om_question: 'om_first', om_reply: 'om_last' });
    expect(request.restrictedMessageIds).toEqual(['om_restricted']);
    expect(request.forwarding).toBeUndefined();
    expect(request.cardRefreshPending).toBe(true);

    // A restarted reconciler and even a stale retry callback must not resend
    // successful originals or retry a known restricted one.
    await retryPendingOncallHandoffs('app');
    expect(store.pendingHandoffs('app')).toEqual([]);
    const result = await handleOncallGroupAction(event('oncall_group_forward'), 'app');
    expect(result.toast.type).toBe('success');
    expect(mocks.forward).toHaveBeenCalledTimes(3);
    const elements = handoffElements();
    expect(elements.filter((item: any) => item.tag === 'button')).toHaveLength(1);
    expect(elements.some((item: any) => item.tag === 'markdown')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves a temporary failure after a restricted message and retries only the uncertain original with its UUID', async () => {
    const store = seed(['om_restricted', 'om_reply'], 'individual');
    mocks.forward.mockRejectedValueOnce(larkApiError('forward message', { code: 230070 }))
      .mockRejectedValueOnce(new Error('lost receipt'));
    await forwardOncallConversation(source);
    const pending = store.getRequest(source)!;
    expect(pending.restrictedMessageIds).toEqual(['om_restricted']);
    expect(pending.forwarding?.messageId).toBe('om_reply');
    expect(handoffElements().filter((item: any) => item.tag === 'button')).toHaveLength(2);
    await retryPendingOncallHandoffs('app');
    expect(mocks.forward.mock.calls.map(call => call[1])).toEqual(['om_restricted', 'om_reply', 'om_reply']);
    expect(mocks.forward.mock.calls[1][3]).toBe(mocks.forward.mock.calls[2][3]);
    expect(store.getRequest(source)?.forwarded).toEqual(['om_reply']);
    expect(store.pendingHandoffs('app')).toEqual([]);
  });

  it('does not label an entire restricted merge as delivered or silently discard its other originals', async () => {
    const store = seed(['om_question', 'om_reply'], 'merge');
    mocks.merge.mockRejectedValueOnce(larkApiError('merge forward messages', { code: 230070 }));
    await forwardOncallConversation(source);
    const request = new OncallGroupStore(dir).getRequest(source)!;
    expect(request.handoffError).toBe('restricted_merge');
    expect(request.forwarded ?? []).toEqual([]);
    expect(request.restrictedMessageIds ?? []).toEqual([]);
    expect(request.messageIdsSnapshot).toEqual(['om_question', 'om_reply']);
    expect(request.forwarding).toBeUndefined();
    expect(request.cardRefreshPending).toBe(true);
    // A failed card update retries the presentation, never the rejected merge.
    mocks.update.mockRejectedValueOnce(new Error('card update unavailable'));
    await retryPendingOncallHandoffs('app');
    expect(store.pendingHandoffs('app')).toHaveLength(1);
    await retryPendingOncallHandoffs('app');
    await forwardOncallConversation(source);
    expect(store.pendingHandoffs('app')).toEqual([]);
    expect(mocks.merge).toHaveBeenCalledTimes(1);
    expect(mocks.forward).not.toHaveBeenCalled();
    const elements = handoffElements();
    expect(elements.filter((item: any) => item.tag === 'button')).toHaveLength(1);
    expect(elements.some((item: any) => item.tag === 'markdown')).toBe(true);
    expect((await handleOncallGroupAction(event('oncall_group_forward'), 'app')).toast.type).toBe('error');
  });

  it('freezes merge mode at submission, chunks by 100 and resumes an uncertain batch with the same UUID', async () => {
    const ids = Array.from({ length: 102 }, (_, i) => `om_m${i}`); const store = seed(ids, 'merge');
    mocks.merge.mockResolvedValueOnce({ messageId: 'om_batch1', invalidMessageIds: [] }).mockRejectedValueOnce(new Error('lost receipt'));
    await forwardOncallConversation(source);
    expect(store.getRequest(source)?.forwarded).toHaveLength(100);
    expect(mocks.merge.mock.calls.map(call => call[1].length)).toEqual([100, 2]);
    mocks.bot.config.oncallGroup.forwardMode = 'none';
    mocks.merge.mockResolvedValueOnce({ messageId: 'om_batch2', invalidMessageIds: [] });
    await retryPendingOncallHandoffs('app');
    expect(mocks.merge.mock.calls[2][3]).toBe(mocks.merge.mock.calls[1][3]);
    expect(store.getRequest(source)?.forwarded).toEqual(ids);
    expect(store.pendingHandoffs('app')).toHaveLength(0); expect(mocks.forward).not.toHaveBeenCalled();
  });
  it('marks only valid merged originals as delivered and preserves missing originals for retry', async () => {
    const store = seed(['om_q', 'om_missing'], 'merge');
    mocks.merge.mockResolvedValueOnce({ messageId: 'om_batch', invalidMessageIds: ['om_missing'] });
    await forwardOncallConversation(source);
    expect(store.getRequest(source)?.forwarded).toEqual(['om_q']);
    expect(store.getRequest(source)?.forwardedMessageIds).toEqual({ om_q: 'om_batch' });
    expect(store.pendingHandoffs('app')).toHaveLength(1);
    mocks.merge.mockResolvedValueOnce({ messageId: 'om_recovered', invalidMessageIds: [] });
    await forwardOncallConversation(source); expect(mocks.merge.mock.calls.at(-1)![1]).toEqual(['om_missing']);
    expect(store.getRequest(source)?.forwarded).toEqual(['om_q', 'om_missing']);
  });
});
