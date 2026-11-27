import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: { session: { dataDir: '' } }, remote: '' as '' | 'sso' | 'devbox',
  bot: { config: { brand: 'feishu', oncallGroup: {} as any } }, reply: vi.fn(), update: vi.fn(), withdraw: vi.fn(),
  sender: vi.fn(), detail: vi.fn(), thread: vi.fn(), merge: vi.fn(), membership: vi.fn(), invite: vi.fn(), mode: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/platform/binding.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/platform/binding.js')>(),
  platformMachineBaseUrl: () => mocks.remote === 'sso' ? 'https://sso.example.test' : null,
}));
vi.mock('../src/platform/devbox-dashboard-export.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/platform/devbox-dashboard-export.js')>(),
  devboxDashboardBaseUrl: () => mocks.remote === 'devbox' ? 'https://devbox.example.test' : null,
}));
vi.mock('../src/global-config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/global-config.js')>(),
  isRemoteAccessEnabled: () => mocks.remote === 'sso',
}));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('../src/im/lark/client.js', () => ({ replyMessage: mocks.reply, updateMessage: mocks.update, deleteMessage: mocks.withdraw,
  getMessageDetail: mocks.detail, getChatModeStrict: mocks.mode, getChatInviteLink: mocks.invite,
  listThreadMessagesWithContext: mocks.thread, mergeForwardMessages: mocks.merge, forwardMessage: vi.fn(), isBotInChat: mocks.membership }));
import { handleOncallGroupAction, handleOncallFormAction, reconcileNativeOncallSubmissions, retryPendingOncallHandoffs } from '../src/im/lark/oncall-group.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { createNativeOncallLink, readNativeOncallResultCandidates } from '../src/services/oncall-platform.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { buildDashboardUrls } from '../src/core/dashboard-url.js';
const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, emailDomain: 'example.test' };
const category = { id: 34, tenant_id: 12, name: 'custom', type_action: 'create_chat', workflow_id: 10 };
const appId = 'cli_example';
const source: OncallGroupSource = { appId, sessionId: 'session', chatId: 'oc_source', rootId: 'om_q1',
  questionId: 'om_q2', messageId: 'om_a2', answer: 'second answer' };
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
let dir: string, started: number, fetcher: ReturnType<typeof vi.fn>, rows: any[];
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['Date'] });
  mocks.remote = '';
  started = Date.parse('2026-01-01T00:00:00Z'); vi.setSystemTime(started);
  dir = mkdtempSync(join(tmpdir(), 'native-oncall-completion-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'thread_card', forwardMode: 'merge' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ [appId]: target }));
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'service-secret');
  vi.stubEnv('BOTMUX_PUBLIC_URL', undefined);
  mocks.reply.mockResolvedValue('om_form'); mocks.update.mockResolvedValue(undefined); mocks.withdraw.mockResolvedValue(true);
  mocks.mode.mockResolvedValue('topic'); mocks.sender.mockResolvedValue({ email: 'actor@example.test' }); mocks.detail.mockResolvedValue({ body: { content: 'question' } });
  mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture');
  mocks.membership.mockResolvedValue(true); mocks.merge.mockResolvedValue({ messageId: 'om_receipt', invalidMessageIds: [] });
  const groups = new OncallGroupStore(dir);
  const first = { ...source, questionId: 'om_q1', messageId: 'om_a1', answer: 'first answer' };
  for (const item of [first, source]) {
    groups.registerTurn(appId, 'session', item.questionId); groups.recordSource({ ...item, cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) });
  }
  mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
    { message_id: 'om_q1', create_time: String(started - 5000) }, { message_id: 'om_a1', create_time: String(started - 4000) },
    { message_id: 'om_q2', create_time: String(started - 3000) }, { message_id: 'om_a2', create_time: String(started - 2000) },
    { message_id: 'om_file', msg_type: 'file', create_time: String(started - 1000) }, { message_id: 'om_form', create_time: String(started) },
    { message_id: 'om_after', create_time: String(started + 3000) },
  ] });
  rows = [];
  fetcher = vi.fn(async (url: string, init?: RequestInit) => json(url.includes('/workflow/') ? { tenant_id: 12, type_id: 34, config: '[{"base":{"key":"field","type":"input"}}]' }
    : url.includes('/tools/') ? { lark_dialog_url: `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent('https://oncall.example.test/chat?tenant=12')}` }
      : url.includes('/oncall_flow/list') ? queriedRows(init) : url.includes('/chat_id_to_open_chat_id') ? 'oc_destination' : { region: { cn: [category] } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
async function open() {
  const result = await handleOncallGroupAction({ operator: { open_id: 'ou_actor' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId },
    action: { value: { action: 'oncall_group_create' } } } as any, appId);
  expect(result.toast.type).toBe('info');
  return new OncallFormStore(dir).pendingNativeSubmissions(appId)[0];
}
function submitted(d: any) {
  rows = [{ id: 1234, tenant_id: 12, source_location: d.nativeSubmission.attempts[0]!.sourceLocation, originator_user: 'actor',
    oncall_question_type_id: 34, region: 'cn', stage: 'launch_oncall', chat_id: '1234567890123',
    create_time: new Date(started - 45_000).toISOString(), update_time: new Date(started + 2000).toISOString(),
    oncall_start_time: new Date(started + 2000).toISOString() }];
  vi.setSystemTime(started + 5000);
}

function queriedRows(init?: RequestInit) {
  const { filter_fields: filters, page_size: pageSize } = JSON.parse(String(init?.body));
  const lowerBound = filters.find((f: any) => f.field === 'update_time' && f.operator === 'greater_or_equals');
  const upperBound = filters.find((f: any) => f.operator === 'less_or_equals');
  const exact = filters.find((f: any) => f.field === 'source_location');
  const candidateId = filters.find((f: any) => f.field === 'id' && f.operator === 'in');
  const cursor = filters.find((f: any) => f.field === 'id' && f.operator === 'greater_or_equals');
  const cutoff = lowerBound ? Date.parse(`${lowerBound.value.replace(' ', 'T')}+08:00`) : 0;
  const horizon = upperBound ? Date.parse(`${upperBound.value.replace(' ', 'T')}+08:00`) : Infinity;
  return rows.filter(row => (!lowerBound || Date.parse(row.update_time) >= cutoff)
    && (!upperBound || Date.parse(row[upperBound.field]) <= horizon)
    && (!exact || exact.value.includes(row.source_location))
    && (!candidateId || candidateId.value.includes(String(row.id)))
    && (!cursor || row.id >= Number(cursor.value)))
    .sort((a, b) => a.id - b.id).slice(0, pageSize);
}
const current = (d: any) => new OncallFormStore(dir).use(appId, d.id, 'ou_actor', async value => ({ ...value }), { allowClosed: true });

async function reconcileAndDeliver() {
  await reconcileNativeOncallSubmissions(appId);
  await retryPendingOncallHandoffs(appId);
}

describe('native submission completion', () => {
  it('adopts a group from an earlier platform draft and forwards the conversation through launch time once', async () => {
    const d = await open(); submitted(d);
    const page = new URL(new URL(d.nativeFormLink!).searchParams.get('url')!);
    expect([...page.searchParams.keys()][0]).toBe('bm_form');
    expect(page.searchParams.get('bm_form')).toBe(new URL(d.nativeSubmission.attempts[0]!.sourceLocation).searchParams.get('bm_form'));
    expect(d.nativeSubmission.attempts[0]!.sourceLocation).toContain(d.id);
    await reconcileAndDeliver();
    const request = new OncallGroupStore(dir).getRequest(source)!;
    expect(request).toMatchObject({ status: 'succeeded', flowId: '1234', openChatId: 'oc_destination', forwardMode: 'merge', submittedAtMs: started + 2000,
      messageIdsSnapshot: ['om_q1', 'om_a1', 'om_q2', 'om_a2', 'om_file'], forwarded: ['om_q1', 'om_a1', 'om_q2', 'om_a2', 'om_file'] });
    expect(mocks.merge).toHaveBeenCalledOnce(); expect(mocks.withdraw).toHaveBeenCalledWith(appId, d.messageId, expect.objectContaining({ acceptWithdrawn: true }));
    for (const id of ['om_a1', 'om_a2']) {
      const raw = mocks.update.mock.calls.filter(([, message]) => message === id).at(-1)![2];
      const button = JSON.parse(raw).body.elements.at(-1).columns.at(-1).elements[0];
      expect(button.behaviors[0]).toMatchObject({ type: 'open_url', default_url: expect.stringContaining('add_by_link') });
    }
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
    await reconcileAndDeliver(); expect(mocks.merge).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/chat/'))).toHaveLength(0);
  });
  it('waits for submission and never treats an open sidebar as a created group', async () => {
    await open(); await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled(); expect(mocks.withdraw).not.toHaveBeenCalled();
  });
  it.each([false, true])('uses the group creation cutoff even with delayed duty start (recorded: %s)', async dutyStarted => {
    const d = await open();
    submitted(d);
    rows[0].create_chat_time = '2026-01-01T08:00:02';
    rows[0].oncall_start_time = dutyStarted ? '2026-01-01T08:00:04' : null;
    await reconcileAndDeliver();
    const request = new OncallGroupStore(dir).getRequest(source);
    expect(request).toMatchObject({ status: 'succeeded', openChatId: 'oc_destination', submittedAtMs: started + 2000,
      messageIdsSnapshot: ['om_q1', 'om_a1', 'om_q2', 'om_a2', 'om_file'] });
    const raw = mocks.update.mock.calls.filter(([, message]) => message === source.messageId).at(-1)![2];
    expect(raw).toContain('进入人工 Oncall 群');
    expect(mocks.withdraw).toHaveBeenCalledWith(appId, d.messageId, expect.objectContaining({ acceptWithdrawn: true }));
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
    rows[0].oncall_start_time = '2026-01-01T08:00:04';
    vi.setSystemTime(started + 20_000);
    await reconcileAndDeliver();
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('adopts an earlier native submission after a replacement Botmux attempt fails', async () => {
    mocks.bot.config.oncallGroup.customFormMode = 'botmux';
    const initialFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url: string, init?: RequestInit) => url.includes('/workflow/')
      ? json({ tenant_id: 12, type_id: 34, config: JSON.stringify([{ base: { key: 'field', label: '字段', type: 'input' } }]) })
      : initialFetch(url, init));
    const opened = await handleOncallGroupAction({ operator: { open_id: 'ou_actor' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId },
      action: { value: { action: 'oncall_group_create' } } } as any, appId);
    expect(opened.toast.type).toBe('info');
    const active = () => new OncallFormStore(dir).open({ appId, ownerOpenId: 'ou_actor', source,
      choices: { regions: { cn: [category] } }, region: 'cn', typeId: 34, priority: 'P2', description: 'question' });
    const callback = (action: string, draft: any, option?: string): any => ({ operator: { open_id: 'ou_actor' },
      context: { open_chat_id: source.chatId, open_message_id: draft.messageId },
      action: { value: { action, draftId: draft.id, version: draft.version }, ...(option ? { option } : {}) } });
    let d = active();
    for (const priority of ['P0', 'P2']) {
      const changed = await handleOncallFormAction(callback('oncall_group_form_priority', d, priority), appId);
      expect(changed.toast.type).toBe('info');
      await changed.afterAck?.();
      d = active();
      if (priority === 'P0') submitted(d);
    }
    expect(d.botmuxFields).toHaveLength(1);
    expect(d.nativeSubmission.attempts).toHaveLength(1);

    const respond = fetcher.getMockImplementation()!;
    let finishCreate!: (value: Response) => void;
    const pendingCreate = new Promise<Response>(resolve => { finishCreate = resolve; });
    fetcher.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/api/inf/v1/chat/') && init?.method === 'POST'
      ? pendingCreate : respond(url, init));
    const submission = callback('oncall_group_form_botmux_submit', d);
    submission.action.form_value = { oncall_field_0: 'value' };
    const accepted = await handleOncallFormAction(submission, appId);
    expect(accepted.toast.type).toBe('info');
    const settled = accepted.afterAck().catch((error: unknown) => error);
    await vi.waitFor(() => { expect(mocks.withdraw).toHaveBeenCalledOnce(); });
    finishCreate(new Response('{}', { status: 400 }));
    await settled;
    expect(new OncallGroupStore(dir).getRequest(source)?.status).toBe('failed');
    expect((await current(d)).closed).toBe(true);

    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({
      status: 'succeeded', flowId: '1234', openChatId: 'oc_destination',
    });
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/api/inf/v1/chat/') && init?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/oncall_flow/list')).length).toBeGreaterThan(0);
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('still adopts a submitted native form if the default changes to Botmux before reconciliation', async () => {
    const d = await open();
    submitted(d);
    mocks.bot.config.oncallGroup.customFormMode = 'botmux';
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ status: 'succeeded', openChatId: 'oc_destination' });
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it.each(['originator_user', 'tenant_id', 'source_location', 'region'])('rejects a mismatched %s without adoption or forwarding', async key => {
    const d = await open(); submitted(d); rows[0][key] = typeof rows[0][key] === 'number' ? 99 : 'different';
    await reconcileAndDeliver(); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('updates the original answer and forwards once after Oncall changes the category', async () => {
    const d = await open(); submitted(d);
    rows[0].oncall_question_type_id = 99;
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ status: 'succeeded', flowId: '1234', openChatId: 'oc_destination' });
    expect(mocks.update.mock.calls.some(([, message]) => message === source.messageId)).toBe(true);
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('does not guess between two orders submitted from the same form', async () => {
    const d = await open(); submitted(d); rows.push({ ...rows[0], id: 5678 });
    await reconcileAndDeliver(); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('recovers adoption after a failed card update, using the same group and forwarding receipt', async () => {
    const d = await open(); submitted(d); mocks.update.mockRejectedValueOnce(new Error('patch failed'));
    await reconcileAndDeliver();
    const attempt = new OncallGroupStore(dir).getRequest(source)!.attemptId;
    const checks = fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list')).length;
    vi.setSystemTime(started + 70000); await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)!.attemptId).toBe(attempt); expect(mocks.merge).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list'))).toHaveLength(checks);
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it('preserves existing session ownership and never rebinds a pending ordinary request', async () => {
    const d = await open(); submitted(d); const groups = new OncallGroupStore(dir); groups.claim(source, 'ou_other');
    await reconcileAndDeliver(); expect(groups.getRequest(source)).toMatchObject({ status: 'pending', operatorOpenId: 'ou_other' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('honors the no-forward setting while still producing the group invitation', async () => {
    mocks.bot.config.oncallGroup.forwardMode = 'none'; const d = await open(); submitted(d);
    await reconcileAndDeliver(); expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ status: 'succeeded', forwardMode: 'none', messageIdsSnapshot: [] });
  });
  it('does not attach an order after the initiator cancels the original form', async () => {
    const d = await open(); submitted(d);
    await handleOncallFormAction({ operator: { open_id: 'ou_actor' }, context: { open_chat_id: source.chatId, open_message_id: d.messageId },
      action: { value: { action: 'oncall_group_form_cancel', draftId: d.id, version: d.version } } } as any, appId);
    await reconcileAndDeliver(); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it.each(['stale', 'future', 'missing'])('does not adopt a platform ticket with a %s launch time', async kind => {
    const d = await open(); submitted(d);
    rows[0].oncall_start_time = kind === 'missing' ? null
      : new Date(kind === 'stale' ? started - 60_000 : started + 500_000).toISOString();
    // Exercise local validation even if the platform returns a row outside the filter.
    fetcher.mockImplementation(async (url: string) => json(url.includes('/oncall_flow/list') ? rows : 'oc_destination'));
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
});

describe('platform completion protocol', () => {
  it('keeps the correlation identity ahead of long descriptions in the truncated platform source', async () => {
    const href = await createNativeOncallLink(target, 'service-secret', '', '长文本'.repeat(300), 'feishu', fetcher,
      { typeId: 34, region: 'cn', priority: 'P2', formId: 'synthetic-form-id' });
    const page = new URL(href).searchParams.get('url')!;
    expect(new URL(page.slice(0, 200)).searchParams.get('bm_form')).toBe('synthetic-form-id');
  });
  it('matches the same opaque form ID after channel normalization and ignores another form with identical text', async () => {
    const d = await open(); submitted(d);
    const original = new URL(rows[0].source_location); original.searchParams.set('bizFrom', 'lark');
    rows[0].source_location = original.href.slice(0, 200);
    const other = new URL(rows[0].source_location); other.searchParams.set('bm_form', 'different-form');
    rows.push({ ...rows[0], id: 5678, source_location: other.href });
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ flowId: '1234', openChatId: 'oc_destination' });
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('uses the explicit public proxy and looks up the hosted selection by its canonical source', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test/prefix');
    expect(buildDashboardUrls({ host: 'localhost', port: 7891 }).url).toBe('https://sso.example.test/');
    const d = await open();
    const card = JSON.parse(mocks.reply.mock.calls[0]![2]);
    const button = card.elements.at(-1).actions[0];
    const hosted = new URL(new URL(button.url).searchParams.get('url')!);
    expect(hosted.href).toMatch(/^https:\/\/dashboard\.example\.test\/prefix\/oncall\/sidebar\//);
    submitted(d);
    const expected = d.nativeSubmission.attempts[0]!.hostedSourceLocation;
    expect(new URL(expected).searchParams.size).toBe(1);
    rows[0].source_location = expected;
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    const lists = fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list'));
    expect(lists).toHaveLength(2);
    expect(JSON.parse(lists[0]![1].body).filter_fields).toContainEqual({ field: 'source_location', value: [expected], operator: 'in' });
    expect(JSON.parse(lists[1]![1].body).filter_fields).toContainEqual(expect.objectContaining({ field: 'update_time', operator: 'greater_or_equals' }));
    expect(new OncallGroupStore(dir).getRequest(source)?.flowId).toBe('1234');
    expect(mocks.merge).toHaveBeenCalledOnce();
  });

  it('ignores unrelated rows returned by a hosted exact-source query', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    const expected = d.nativeSubmission.attempts[0]!.hostedSourceLocation!;
    rows[0].source_location = expected;
    rows.push({ ...rows[0], id: 5678, source_location: 'https://oncall.example.test/chat?bm_form=other' });
    const respond = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const filters = url.includes('/oncall_flow/list') ? JSON.parse(String(init?.body)).filter_fields : [];
      if (filters.some((filter: any) => filter.field === 'source_location')) return json(rows);
      return respond(url, init);
    });
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1234 });
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)?.flowId).toBe('1234');
    expect(mocks.merge).toHaveBeenCalledOnce();
  });

  it.each([false, true])('rechecks normalized hosted sources before adoption (exact duplicate: %s)', async duplicate => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    const expected = d.nativeSubmission.attempts[0]!.hostedSourceLocation!;
    const exact = { ...rows[0], id: 5678, source_location: expected };
    rows[0].source_location = `${expected}&bizFrom=lark`;
    if (duplicate) rows.push(exact);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)?.flowId).toBe(duplicate ? undefined : '1234');
    expect(mocks.merge).toHaveBeenCalledTimes(duplicate ? 0 : 1);
  });

  it('refreshes the creation horizon before starting a delayed verification', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    rows[0].source_location = d.nativeSubmission.attempts[0]!.hostedSourceLocation!;
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1234 });
    rows.push({ ...rows[0], id: 5678,
      create_time: new Date(started + 10_000).toISOString(), update_time: new Date(started + 10_000).toISOString() });
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('refuses adoption within bounded paginated verification retries', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 101, source_location: d.nativeSubmission.attempts[0]!.hostedSourceLocation! };
    rows = [...Array.from({ length: 100 }, (_, i) => ({ ...rows[0], id: i + 1,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    await reconcileAndDeliver();
    let passes = 0;
    while ((await current(d)).nativeSubmission?.scan && passes < 5) {
      passes++;
      vi.setSystemTime(started + 6_000 + passes * 15_000);
      await reconcileAndDeliver();
      expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
      if (passes === 1) expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 101, verifyRounds: 1 });
    }
    expect(passes).toBeGreaterThan(1);
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it.each(['sso', 'devbox'] as const)('leaves the native AppLink intact when only %s is configured', async remote => {
    mocks.remote = remote;
    expect(buildDashboardUrls({ host: 'localhost', port: 7891 }).url).toBe(`https://${remote}.example.test/`);
    const d = await open();
    const button = JSON.parse(mocks.reply.mock.calls[0]![2]).elements.at(-1).actions[0];
    expect(button.url).toBe(d.nativeFormLink);
    expect(d.nativeSubmission.attempts[0]!.hostedSourceLocation).toBeUndefined();
  });

  it.each([false, true])('resumes after 1000 rows without adopting an ambiguous legacy order (%s)', async duplicate => {
    const d = await open(); submitted(d);
    const wanted = rows[0];
    rows = Array.from({ length: 1000 }, (_, i) => ({ ...wanted, id: i + 1,
      source_location: 'https://oncall.example.test/chat?bm_form=other' }));
    if (duplicate) rows[0] = { ...wanted, id: 1 };
    rows.push(wanted);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 1000 });
    expect(mocks.merge).not.toHaveBeenCalled();
    wanted.update_time = new Date(started + 20_000).toISOString();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    const lists = fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list'));
    expect(lists).toHaveLength(11);
    expect(JSON.parse(lists[10]![1].body).filter_fields).toContainEqual({ field: 'id', value: '1001', operator: 'greater_or_equals' });
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
    if (duplicate) return;
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1234 });
    rows = [wanted];
    vi.setSystemTime(started + 36_000);
    await reconcileAndDeliver();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list'))).toHaveLength(12);
    expect(new OncallGroupStore(dir).getRequest(source)?.flowId).toBe('1234');
    expect(mocks.merge).toHaveBeenCalledOnce();
  });

  it('rechecks an older ID that enters the window after the cursor has passed it', async () => {
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 1001 };
    const duplicate = { ...rows[0], id: 1, update_time: new Date(started - 60_000).toISOString() };
    rows = [duplicate, ...Array.from({ length: 999 }, (_, i) => ({ ...rows[0], id: i + 2,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 1001, flowId: 1001 });
    duplicate.update_time = new Date(started + 6000).toISOString();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1001 });
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    vi.setSystemTime(started + 36_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 1000, flowId: 1, verifyFlowId: 1001 });
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    vi.setSystemTime(started + 51_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('rechecks an older ID that changes between two pages of the first scan', async () => {
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 102 };
    const duplicate = { ...rows[0], id: 1, update_time: new Date(started - 60_000).toISOString() };
    rows = [duplicate, ...Array.from({ length: 100 }, (_, i) => ({ ...rows[0], id: i + 2,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    const respond = fetcher.getMockImplementation()!;
    let firstPage = true;
    fetcher.mockImplementation(async (url, init) => {
      const result = await respond(url, init);
      if (firstPage && url.includes('/oncall_flow/list')) {
        firstPage = false;
        duplicate.update_time = new Date(started + 5000).toISOString();
      }
      return result;
    });
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 102 });
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('restarts verification when an older ID arrives between verification pages', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 102, source_location: d.nativeSubmission.attempts[0]!.hostedSourceLocation! };
    const duplicate = { ...rows[0], id: 1, update_time: new Date(started - 60_000).toISOString() };
    rows = [duplicate, ...Array.from({ length: 100 }, (_, i) => ({ ...rows[0], id: i + 2,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    await reconcileAndDeliver();
    const respond = fetcher.getMockImplementation()!;
    let firstVerificationPage = true;
    fetcher.mockImplementation(async (url, init) => {
      const result = await respond(url, init);
      const filters = url.includes('/oncall_flow/list') ? JSON.parse(String(init?.body)).filter_fields : [];
      if (firstVerificationPage && filters.some((filter: any) => filter.field === 'update_time')) {
        firstVerificationPage = false;
        duplicate.update_time = new Date(started + 22_000).toISOString();
      }
      return result;
    });
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 102, verifyRounds: 1 });
    vi.setSystemTime(started + 36_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('restarts verification after its own 1000-row checkpoint before adopting', async () => {
    mocks.remote = 'sso';
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://dashboard.example.test');
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 1002, source_location: d.nativeSubmission.attempts[0]!.hostedSourceLocation! };
    const duplicate = { ...rows[0], id: 1, update_time: new Date(started - 60_000).toISOString() };
    rows = [duplicate, ...Array.from({ length: 1000 }, (_, i) => ({ ...rows[0], id: i + 2,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    await reconcileAndDeliver();
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 1001, verifyFlowId: 1002, verifyRounds: 0 });
    duplicate.update_time = new Date(started + 22_000).toISOString();
    vi.setSystemTime(started + 36_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1002, verifyRounds: 1 });
    rows = [duplicate, targetRow];
    vi.setSystemTime(started + 51_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('rejects a different single order returned by the verification pass', async () => {
    const d = await open(); submitted(d);
    const targetRow = { ...rows[0], id: 101 };
    rows = [...Array.from({ length: 100 }, (_, i) => ({ ...rows[0], id: i + 1,
      source_location: 'https://oncall.example.test/chat?bm_form=other' })), targetRow];
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 101 });
    rows = [{ ...targetRow, id: 202 }];
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('keeps the scan checkpoint when group ID conversion fails after the last page', async () => {
    const d = await open(); submitted(d);
    const wanted = { ...rows[0], id: 1 };
    rows = [wanted, ...Array.from({ length: 999 }, (_, i) => ({ ...wanted, id: i + 2,
      source_location: 'https://oncall.example.test/chat?bm_form=other' }))];
    await reconcileAndDeliver();
    const checkpoint = (await current(d)).nativeSubmission?.scan;
    expect(checkpoint).toMatchObject({ afterId: 1000, flowId: 1 });
    const respond = fetcher.getMockImplementation()!;
    let failConversion = true;
    fetcher.mockImplementation(async (url, init) => {
      if (failConversion && url.includes('/chat_id_to_open_chat_id')) throw new Error('temporary conversion failure');
      return respond(url, init);
    });
    vi.setSystemTime(started + 21_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toEqual(checkpoint);
    expect(mocks.merge).not.toHaveBeenCalled();
    failConversion = false;
    vi.setSystemTime(started + 82_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toMatchObject({ afterId: 0, verifyFlowId: 1 });
    expect(mocks.merge).not.toHaveBeenCalled();
    rows = [wanted];
    vi.setSystemTime(started + 97_000);
    await reconcileAndDeliver();
    expect((await current(d)).nativeSubmission?.scan).toBeUndefined();
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('queries the verified actor and preparation window with a bounded result set', async () => {
    const d = await open(); submitted(d);
    await readNativeOncallResultCandidates(target, 'service-secret', { sourceLocation: d.nativeSubmission.attempts[0]!.sourceLocation, username: 'actor', typeId: 34, region: 'cn', preparedAtMs: started }, fetcher);
    const call = fetcher.mock.calls.find(([url]) => url.includes('/oncall_flow/list'))!;
    const payload = JSON.parse((call[1] as any).body);
    expect(payload).toMatchObject({ current_page: 1, page_size: 100, filter_fields: expect.arrayContaining([
      { field: 'update_time', value: '2026-01-01 08:00:00', operator: 'greater_or_equals' },
      { field: 'originator_user', value: 'actor', operator: 'equals' },
    ]) });
  });
  it('parses unqualified platform timestamps as China Standard Time even on a UTC host', () => {
    // A UTC daemon must read Beijing wall-clock time the same as a UTC+8 daemon.
    // Run the real function in a TZ=UTC child: a bare Date.parse would shift it.
    const source = `
      import { readNativeOncallResultCandidates } from './src/services/oncall-platform.js';
      const rows = [{ id: 1234, tenant_id: 12, source_location: 'https://oncall.example.test/chat?bm_form=tz-form',
        originator_user: 'actor', oncall_question_type_id: 34, region: 'cn', stage: 'launch_oncall',
        chat_id: '123456789', oncall_start_time: '2026-01-01 08:00:02' }];
      const fetcher = async url => new Response(JSON.stringify({ code: 0,
        data: url.includes('chat_id_to_open_chat_id') ? 'oc_destination' : rows }));
      const matches = await readNativeOncallResultCandidates(
        { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, emailDomain: 'example.test' },
        'secret', { sourceLocation: 'https://oncall.example.test/chat?bm_form=tz-form', username: 'actor', typeId: 34, region: 'cn' }, fetcher);
      process.stdout.write(JSON.stringify(matches[0]?.result));
    `;
    const run = spawnSyncTsEvalWithRepoImports(source, { cwd: process.cwd(), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000 });
    expect(run.status, String(run.stderr)).toBe(0);
    expect(JSON.parse(String(run.stdout)).handoffAtMs).toBe(Date.parse('2026-01-01T00:00:02.000Z'));
  });
});
