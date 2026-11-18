import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { session: { dataDir: '' } }, bot: { config: { brand: 'feishu', oncallGroup: {} as any } },
  invite: vi.fn(), update: vi.fn(), detail: vi.fn(), sender: vi.fn(), merge: vi.fn(), membership: vi.fn(), thread: vi.fn(),
  withdraw: vi.fn(), remove: vi.fn(), reply: vi.fn(), warn: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('../src/im/lark/client.js', () => ({
  getChatInviteLink: mocks.invite, updateMessage: mocks.update, getMessageDetail: mocks.detail, replyMessage: mocks.reply,
  isBotInChat: mocks.membership, listThreadMessagesWithContext: mocks.thread, mergeForwardMessages: mocks.merge,
  forwardMessage: vi.fn(), getChatModeStrict: vi.fn().mockResolvedValue('group'), sendEphemeralCard: vi.fn(),
  deleteMessage: mocks.withdraw, deleteEphemeralCard: mocks.remove,
}));

import { handleOncallGroupAction, handleOncallFormAction, retryPendingOncallHandoffs } from '../src/im/lark/oncall-group.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { oncallCreationSource } from '../src/services/oncall-group-client.js';

const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, typeId: 34, region: 'cn', emailDomain: 'example.test' };
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_source', rootId: 'om_question',
  questionId: 'om_question', messageId: 'om_reply', answer: 'test answer', cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) };
const creation = { target, username: 'test.user', region: 'cn', typeId: 34 };
const category = { id: 34, name: 'test category', tenant_id: 12, type_action: 'create_chat', workflow_id: 56 };
const event = (action = 'oncall_group_create', draft?: any) => ({ operator: { open_id: 'ou_owner' },
  context: { open_chat_id: source.chatId, open_message_id: draft?.messageId ?? source.messageId },
  action: { value: { action, ...(draft ? { draftId: draft.id, version: draft.version } : {}) } } }) as any;
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
let dir: string;
let groups: OncallGroupStore;
let fetcher: ReturnType<typeof vi.fn>;
let rows: () => unknown[];
let create: () => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'oncall-create-recovery-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: [source.chatId], flowMode: 'direct', forwardMode: 'merge' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: target }));
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'synthetic-secret');
  groups = new OncallGroupStore(dir); groups.registerTurn('app', 'session', source.questionId); groups.recordSource(source);
  mocks.sender.mockResolvedValue({ email: 'test.user@example.test' }); mocks.detail.mockResolvedValue({ body: { content: 'test question' } });
  mocks.membership.mockResolvedValue(true); mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=synthetic');
  mocks.update.mockResolvedValue(undefined); mocks.withdraw.mockResolvedValue(true);
  mocks.merge.mockResolvedValue({ messageId: 'om_merged', invalidMessageIds: [] });
  mocks.thread.mockImplementation(async () => ({ verifiedThread: true, messages: [
    { message_id: source.questionId, create_time: String(Date.now() - 100), msg_type: 'text' },
    { message_id: source.messageId, create_time: String(Date.now() - 50), msg_type: 'interactive' },
  ] }));
  create = async () => { throw new DOMException('synthetic response loss', 'TimeoutError'); };
  rows = () => [{ id: 123, tenant_id: 12, source_location: oncallCreationSource(groups.getRequest(source)!.attemptId!),
    originator_user: 'test.user', region: 'cn', oncall_question_type_id: 34, chat_id: 'internal-chat' }];
  fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === target.endpoint) return create();
    if (url.includes('/oncall_flow/list')) return response(rows());
    if (url.includes('/chat_id_to_open_chat_id')) return response('oc_created');
    if (url.includes('/workflow/')) return response({ tenant_id: 12, type_id: 34, config: '[]' });
    if (url.includes('/type/multi_region')) return response({ region: { cn: [category] } });
    throw new Error(`Unexpected test request: ${url} ${init?.method}`);
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const createCalls = () => fetcher.mock.calls.filter(([url]) => url === target.endpoint);
const lookupCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/oncall_flow/list'));

describe('uncertain Oncall creation recovery', () => {
  it('recovers response loss into the original session and forwards once, without another create', async () => {
    await handleOncallGroupAction(event(), 'app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'unknown', creation });
    const attempt = groups.getRequest(source)!.attemptId;
    expect(JSON.parse(createCalls()[0][1].body)).toMatchObject({ source_location: oncallCreationSource(attempt!) });
    // Reopen the durable store, as a fresh daemon does after restart.
    groups = new OncallGroupStore(dir);
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', attemptId: attempt, flowId: '123', openChatId: 'oc_created',
      forwardedMessageIds: { om_question: 'om_merged', om_reply: 'om_merged' } });
    expect(mocks.update.mock.calls.some(([, , raw]) => JSON.parse(raw).body.elements.some((item: any) =>
      item.columns?.some((column: any) => column.elements?.some((button: any) => button.behaviors?.[0]?.type === 'open_url'))))).toBe(true);
    await handleOncallGroupAction(event(), 'app');
    await retryPendingOncallHandoffs('app');
    expect(createCalls()).toHaveLength(1); expect(mocks.merge).toHaveBeenCalledTimes(1);
    expect(groups.pendingHandoffs('app')).toEqual([]);
  });

  it('also recovers a pending claim left by a crash without sending any create request', async () => {
    groups.claim(source, 'ou_owner', { messageIds: ['om_question', 'om_reply'], cutoffMs: Date.now(), forwardMode: 'merge' }, creation);
    groups = new OncallGroupStore(dir);
    await retryPendingOncallHandoffs('app');
    expect(fetcher).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60_000);
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)?.status).toBe('succeeded');
    expect(createCalls()).toHaveLength(0); expect(mocks.merge).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing result uncertain and backs off polling without creating again', async () => {
    await handleOncallGroupAction(event(), 'app'); rows = () => [];
    await retryPendingOncallHandoffs('app'); await retryPendingOncallHandoffs('app');
    expect(lookupCalls()).toHaveLength(1); expect(groups.getRequest(source)?.status).toBe('unknown');
    vi.setSystemTime(Date.now() + 60_000); await retryPendingOncallHandoffs('app');
    expect(lookupCalls()).toHaveLength(2); expect(createCalls()).toHaveLength(1);
  });

  it('never guesses a legacy unmarked request from similar questions', async () => {
    groups.claim(source, 'ou_owner'); groups.finish(source, { status: 'unknown' }, groups.getRequest(source)!.attemptId);
    await retryPendingOncallHandoffs('app');
    expect(fetcher).not.toHaveBeenCalled(); expect(groups.getRequest(source)?.status).toBe('unknown');
  });

  it.each(['disabled', 'target_changed', 'lost_owner'] as const)('rejects a late lookup after %s', async change => {
    await handleOncallGroupAction(event(), 'app');
    let release!: () => void;
    let owned = true;
    const normalFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (String(args[0]).includes('/oncall_flow/list')) await new Promise<void>(resolve => { release = resolve; });
      return normalFetch(...args);
    });
    const operation = retryPendingOncallHandoffs('app', () => owned);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (change === 'disabled') mocks.bot.config.oncallGroup.enabled = false;
    if (change === 'target_changed') writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { ...target, tenantId: 99 } }));
    if (change === 'lost_owner') owned = false;
    release(); await operation;
    expect(groups.getRequest(source)?.status).toBe('unknown'); expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('serializes overlapping recovery ticks and preserves a recovered result after a late create timeout', async () => {
    let rejectCreate!: (error: Error) => void;
    create = () => new Promise((_, reject) => { rejectCreate = reject; });
    const originalOperation = handleOncallGroupAction(event(), 'app');
    await vi.waitFor(() => expect(rejectCreate).toBeTypeOf('function'));
    vi.setSystemTime(Date.now() + 60_000);
    let release!: () => void;
    const normalFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (String(args[0]).includes('/oncall_flow/list')) await new Promise<void>(resolve => { release = resolve; });
      return normalFetch(...args);
    });
    const first = retryPendingOncallHandoffs('app');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await retryPendingOncallHandoffs('app'); expect(lookupCalls()).toHaveLength(1);
    release(); await first;
    rejectCreate(new DOMException('synthetic late timeout', 'TimeoutError')); await originalOperation;
    expect(groups.getRequest(source)?.status).toBe('succeeded');
    expect(createCalls()).toHaveLength(1); expect(mocks.merge).toHaveBeenCalledTimes(1);
  });

  it('continues from a durable group binding when the first merge fails', async () => {
    await handleOncallGroupAction(event(), 'app');
    mocks.merge.mockRejectedValueOnce(new Error('synthetic connection loss'));
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', openChatId: 'oc_created' });
    const uuid = mocks.merge.mock.calls[0][3];
    await retryPendingOncallHandoffs('app');
    expect(mocks.merge.mock.calls[1][3]).toBe(uuid);
    expect(groups.pendingHandoffs('app')).toEqual([]); expect(createCalls()).toHaveLength(1);
  });

  it('recovers a classified submission and retires its form, retrying a failed retirement', async () => {
    mocks.bot.config.oncallGroup.flowMode = 'classify'; mocks.bot.config.oncallGroup.formDisplay = 'thread_card';
    const forms = new OncallFormStore(dir);
    const draft = forms.open({ appId: 'app', ownerOpenId: 'ou_owner', source, choices: { regions: { cn: [category] } },
      region: 'cn', typeId: 34, priority: 'P2', description: 'test question', messageId: 'om_form', visibility: 'thread' });
    await handleOncallFormAction(event('oncall_group_form_submit', draft), 'app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'unknown', creation: { formId: draft.id } });
    await handleOncallFormAction(event('oncall_group_form_cancel', draft), 'app');
    expect(await forms.use('app', draft.id, 'ou_owner', async current => !!current.closed)).toBe(false);
    mocks.withdraw.mockResolvedValueOnce(false);
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', formClosePending: true });
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)?.formClosePending).toBe(false);
    expect(await forms.use('app', draft.id, 'ou_owner', async current => current.closed, { allowClosed: true })).toBe(true);
    expect(mocks.withdraw).toHaveBeenCalledWith('app', 'om_form'); expect(createCalls()).toHaveLength(1);
  });

  it('preserves the no-forwarding option on recovery', async () => {
    mocks.bot.config.oncallGroup.forwardMode = 'none';
    await handleOncallGroupAction(event(), 'app'); await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', forwardMode: 'none' });
    expect(mocks.merge).not.toHaveBeenCalled(); expect(createCalls()).toHaveLength(1);
  });

  const classified = () => {
    mocks.bot.config.oncallGroup.flowMode = 'classify'; mocks.bot.config.oncallGroup.formDisplay = 'thread_card';
    const forms = new OncallFormStore(dir);
    const draft = forms.open({ appId: 'app', ownerOpenId: 'ou_owner', source, choices: { regions: { cn: [category] } },
      region: 'cn', typeId: 34, priority: 'P2', description: 'test question', messageId: 'om_form', visibility: 'thread' });
    return { forms, draft };
  };

  it('retires a recovered form that expired after submission, without reopening expired interactions', async () => {
    const { forms, draft } = classified();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 - 10_000);
    await handleOncallFormAction(event('oncall_group_form_submit', draft), 'app');
    vi.setSystemTime(Date.now() + 20_000);
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', formClosePending: false });
    expect(mocks.withdraw).toHaveBeenCalledWith('app', 'om_form');
    await expect(forms.use('app', draft.id, 'ou_owner', async () => true, { allowClosed: true })).rejects.toThrow();
    expect(groups.pendingHandoffs('app')).toEqual([]); expect(createCalls()).toHaveLength(1);
  });

  it('leaves form retirement pending when ownership is lost during its result refresh', async () => {
    const { draft } = classified();
    await handleOncallFormAction(event('oncall_group_form_submit', draft), 'app');
    let owned = true;
    let release!: () => void;
    let updates = 0;
    mocks.update.mockImplementation(async () => {
      if (++updates === 2) await new Promise<void>(resolve => { release = resolve; });
    });
    const operation = retryPendingOncallHandoffs('app', () => owned);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    owned = false; release(); await operation;
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(groups.getRequest(source)?.formClosePending).toBe(true);
    await retryPendingOncallHandoffs('app');
    expect(mocks.withdraw).toHaveBeenCalledWith('app', 'om_form');
    expect(groups.getRequest(source)?.formClosePending).toBe(false);
    expect(createCalls()).toHaveLength(1);
  });

  it('retires the original submitted form after a newer turn is published in the same session', async () => {
    const { draft } = classified();
    await handleOncallFormAction(event('oncall_group_form_submit', draft), 'app');
    const next = { ...source, questionId: 'om_next_question', messageId: 'om_next_reply' };
    groups.registerTurn('app', 'session', next.questionId);
    groups.recordSource(next);
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(next)).toMatchObject({ status: 'succeeded', formClosePending: false });
    expect(mocks.withdraw).toHaveBeenCalledWith('app', 'om_form');
    expect(groups.pendingHandoffs('app')).toEqual([]); expect(createCalls()).toHaveLength(1);
  });
});
