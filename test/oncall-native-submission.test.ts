import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: {} as any } }, reply: vi.fn(), update: vi.fn(), withdraw: vi.fn(),
  sender: vi.fn(), detail: vi.fn(), thread: vi.fn(), merge: vi.fn(), membership: vi.fn(), invite: vi.fn(), mode: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('../src/im/lark/client.js', () => ({ replyMessage: mocks.reply, updateMessage: mocks.update, deleteMessage: mocks.withdraw,
  getMessageDetail: mocks.detail, getChatModeStrict: mocks.mode, getChatInviteLink: mocks.invite,
  listThreadMessagesWithContext: mocks.thread, mergeForwardMessages: mocks.merge, forwardMessage: vi.fn(), isBotInChat: mocks.membership }));
import { handleOncallGroupAction, handleOncallFormAction, retryPendingOncallHandoffs } from '../src/im/lark/oncall-group.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { createNativeOncallLink, readNativeOncallResult } from '../src/services/oncall-platform.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';
const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, emailDomain: 'example.test' };
const category = { id: 34, tenant_id: 12, name: 'custom', type_action: 'create_chat', workflow_id: 10 };
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_source', rootId: 'om_q1',
  questionId: 'om_q2', messageId: 'om_a2', answer: 'second answer' };
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
let dir: string, started: number, fetcher: ReturnType<typeof vi.fn>, rows: any[];
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['Date'] });
  started = Date.parse('2026-01-01T00:00:00Z'); vi.setSystemTime(started);
  dir = mkdtempSync(join(tmpdir(), 'native-oncall-completion-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'thread_card', forwardMode: 'merge' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: target }));
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'service-secret');
  mocks.reply.mockResolvedValue('om_form'); mocks.update.mockResolvedValue(undefined); mocks.withdraw.mockResolvedValue(true);
  mocks.mode.mockResolvedValue('topic'); mocks.sender.mockResolvedValue({ email: 'actor@example.test' }); mocks.detail.mockResolvedValue({ body: { content: 'question' } });
  mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture');
  mocks.membership.mockResolvedValue(true); mocks.merge.mockResolvedValue({ messageId: 'om_receipt', invalidMessageIds: [] });
  const groups = new OncallGroupStore(dir);
  const first = { ...source, questionId: 'om_q1', messageId: 'om_a1', answer: 'first answer' };
  for (const item of [first, source]) {
    groups.registerTurn('app', 'session', item.questionId); groups.recordSource({ ...item, cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) });
  }
  mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
    { message_id: 'om_q1', create_time: String(started - 5000) }, { message_id: 'om_a1', create_time: String(started - 4000) },
    { message_id: 'om_q2', create_time: String(started - 3000) }, { message_id: 'om_a2', create_time: String(started - 2000) },
    { message_id: 'om_file', msg_type: 'file', create_time: String(started - 1000) }, { message_id: 'om_form', create_time: String(started) },
    { message_id: 'om_after', create_time: String(started + 3000) },
  ] });
  rows = [];
  fetcher = vi.fn(async (url: string) => json(url.includes('/workflow/') ? { tenant_id: 12, type_id: 34, config: '[{"base":{"key":"field","type":"input"}}]' }
    : url.includes('/tools/') ? { lark_dialog_url: `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent('https://oncall.example.test/chat?tenant=12')}` }
      : url.includes('/oncall_flow/list') ? rows : url.includes('/chat_id_to_open_chat_id') ? 'oc_destination' : { region: { cn: [category] } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
async function open() {
  const result = await handleOncallGroupAction({ operator: { open_id: 'ou_actor' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId },
    action: { value: { action: 'oncall_group_create' } } } as any, 'app');
  expect(result.toast.type).toBe('info');
  return new OncallFormStore(dir).pendingNativeSubmissions('app')[0];
}
function submitted(d: any) {
  rows = [{ id: 1234, tenant_id: 12, source_location: d.nativeSubmission.sourceLocation, originator_user: 'actor',
    oncall_question_type_id: 34, region: 'cn', stage: 'launch_oncall', chat_id: '1234567890123',
    create_time: new Date(started + 2000).toISOString() }]; vi.setSystemTime(started + 5000);
}
const current = (d: any) => new OncallFormStore(dir).use('app', d.id, 'ou_actor', async value => ({ ...value }), { allowClosed: true });

describe('native submission completion', () => {
  it('adopts the submitted group, updates every answer and forwards all rounds and attachments once', async () => {
    const d = await open(); submitted(d);
    const page = new URL(new URL(d.nativeFormLink!).searchParams.get('url')!);
    expect([...page.searchParams.keys()][0]).toBe('bm_form'); expect(page.searchParams.get('bm_form')).toBe(d.id);
    expect(d.nativeSubmission.sourceLocation).toContain(d.id);
    await retryPendingOncallHandoffs('app');
    const request = new OncallGroupStore(dir).getRequest(source)!;
    expect(request).toMatchObject({ status: 'succeeded', flowId: '1234', openChatId: 'oc_destination', forwardMode: 'merge',
      messageIdsSnapshot: ['om_q1', 'om_a1', 'om_q2', 'om_a2', 'om_file'], forwarded: ['om_q1', 'om_a1', 'om_q2', 'om_a2', 'om_file'] });
    expect(mocks.merge).toHaveBeenCalledOnce(); expect(mocks.withdraw).toHaveBeenCalledWith('app', d.messageId);
    for (const id of ['om_a1', 'om_a2']) {
      const raw = mocks.update.mock.calls.filter(([, message]) => message === id).at(-1)![2];
      const button = JSON.parse(raw).body.elements.at(-1).columns.at(-1).elements[0];
      expect(button.behaviors[0]).toMatchObject({ type: 'open_url', default_url: expect.stringContaining('add_by_link') });
    }
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
    await retryPendingOncallHandoffs('app'); expect(mocks.merge).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/chat/'))).toHaveLength(0);
  });
  it('waits for submission and never treats an open sidebar as a created group', async () => {
    await open(); await retryPendingOncallHandoffs('app');
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled(); expect(mocks.withdraw).not.toHaveBeenCalled();
  });
  it.each(['originator_user', 'tenant_id', 'oncall_question_type_id', 'source_location', 'region'])('rejects a mismatched %s without adoption or forwarding', async key => {
    const d = await open(); submitted(d); rows[0][key] = typeof rows[0][key] === 'number' ? 99 : 'different';
    await retryPendingOncallHandoffs('app'); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('does not guess between two orders submitted from the same form', async () => {
    const d = await open(); submitted(d); rows.push({ ...rows[0], id: 5678 });
    await retryPendingOncallHandoffs('app'); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('recovers adoption after a failed card update, using the same group and forwarding receipt', async () => {
    const d = await open(); submitted(d); mocks.update.mockRejectedValueOnce(new Error('patch failed'));
    await retryPendingOncallHandoffs('app');
    const attempt = new OncallGroupStore(dir).getRequest(source)!.attemptId;
    const checks = fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list')).length;
    vi.setSystemTime(started + 70000); await retryPendingOncallHandoffs('app');
    expect(new OncallGroupStore(dir).getRequest(source)!.attemptId).toBe(attempt); expect(mocks.merge).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/oncall_flow/list'))).toHaveLength(checks);
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it('preserves existing session ownership and never rebinds a pending ordinary request', async () => {
    const d = await open(); submitted(d); const groups = new OncallGroupStore(dir); groups.claim(source, 'ou_other');
    await retryPendingOncallHandoffs('app'); expect(groups.getRequest(source)).toMatchObject({ status: 'pending', operatorOpenId: 'ou_other' });
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('honors the no-forward setting while still producing the group invitation', async () => {
    mocks.bot.config.oncallGroup.forwardMode = 'none'; const d = await open(); submitted(d);
    await retryPendingOncallHandoffs('app'); expect(mocks.thread).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ status: 'succeeded', forwardMode: 'none', messageIdsSnapshot: [] });
  });
  it('does not attach an order after the initiator cancels the original form', async () => {
    const d = await open(); submitted(d);
    await handleOncallFormAction({ operator: { open_id: 'ou_actor' }, context: { open_chat_id: source.chatId, open_message_id: d.messageId },
      action: { value: { action: 'oncall_group_form_cancel', draftId: d.id, version: d.version } } } as any, 'app');
    await retryPendingOncallHandoffs('app'); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it.each(['stale', 'future'])('rejects a %s platform ticket outside the preparation window without adoption', async kind => {
    const d = await open(); submitted(d);
    rows[0].create_time = new Date(kind === 'stale' ? started - 60_000 : started + 500_000).toISOString();
    await retryPendingOncallHandoffs('app');
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
    await retryPendingOncallHandoffs('app');
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ flowId: '1234', openChatId: 'oc_destination' });
    expect(mocks.merge).toHaveBeenCalledOnce();
  });
  it('reads later pages before deciding that a form has one unique order', async () => {
    const d = await open(); submitted(d); const wanted = rows[0];
    const others = Array.from({ length: 100 }, (_, i) => ({ ...wanted, id: 10000 + i, source_location: 'https://oncall.example.test/chat?bm_form=other' }));
    const calls: number[] = [];
    fetcher.mockImplementation(async (url: string, options: any) => {
      if (url.includes('/oncall_flow/list')) { const page = JSON.parse(options.body).current_page; calls.push(page); return json(page === 1 ? others : [wanted]); }
      return json('oc_destination');
    });
    await readNativeOncallResult(target, 'service-secret', { sourceLocation: d.nativeSubmission.sourceLocation, username: 'actor', typeId: 34, region: 'cn' }, fetcher);
    expect(calls).toEqual([1, 2]);
  });
  it('queries the verified actor and preparation window with a bounded result set', async () => {
    const d = await open(); submitted(d);
    await readNativeOncallResult(target, 'service-secret', { sourceLocation: d.nativeSubmission.sourceLocation, username: 'actor', typeId: 34, region: 'cn', preparedAtMs: started }, fetcher);
    const call = fetcher.mock.calls.find(([url]) => url.includes('/oncall_flow/list'))!;
    const payload = JSON.parse((call[1] as any).body);
    expect(payload).toMatchObject({ current_page: 1, page_size: 100, filter_fields: expect.arrayContaining([
      { field: 'create_time', value: '2026-01-01 08:00:00', operator: 'greater_or_equals' },
      { field: 'originator_user', value: 'actor', operator: 'equals' },
    ]) });
  });
  it('parses unqualified platform timestamps as China Standard Time even on a UTC host', () => {
    // A UTC daemon must read Beijing wall-clock time the same as a UTC+8 daemon.
    // Run the real function in a TZ=UTC child: a bare Date.parse would shift it.
    const source = `
      import { readNativeOncallResult } from './src/services/oncall-platform.js';
      const rows = [{ id: 1234, tenant_id: 12, source_location: 'https://oncall.example.test/chat?bm_form=tz-form',
        originator_user: 'actor', oncall_question_type_id: 34, region: 'cn', stage: 'launch_oncall',
        chat_id: '123456789', create_time: '2026-01-01 08:00:02' }];
      const fetcher = async url => new Response(JSON.stringify({ code: 0,
        data: url.includes('chat_id_to_open_chat_id') ? 'oc_destination' : rows }));
      const result = await readNativeOncallResult(
        { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, emailDomain: 'example.test' },
        'secret', { sourceLocation: 'https://oncall.example.test/chat?bm_form=tz-form', username: 'actor', typeId: 34, region: 'cn' }, fetcher);
      process.stdout.write(JSON.stringify(result));
    `;
    const run = spawnSyncTsEvalWithRepoImports(source, { cwd: process.cwd(), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000 });
    expect(run.status, String(run.stderr)).toBe(0);
    expect(JSON.parse(String(run.stdout)).createdAtMs).toBe(Date.parse('2026-01-01T00:00:02.000Z'));
  });
});
