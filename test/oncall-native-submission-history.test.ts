import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { session: { dataDir: '' } }, bot: { config: { brand: 'feishu', oncallGroup: {} as any } },
  reply: vi.fn(), update: vi.fn(), withdraw: vi.fn(), ephemeral: vi.fn(), remove: vi.fn(), sender: vi.fn(), detail: vi.fn(),
  thread: vi.fn(), merge: vi.fn(), membership: vi.fn(), invite: vi.fn(), mode: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
vi.mock('../src/im/lark/client.js', () => ({
  replyMessage: mocks.reply, updateMessage: mocks.update, deleteMessage: mocks.withdraw,
  sendEphemeralCard: mocks.ephemeral, deleteEphemeralCard: mocks.remove,
  getMessageDetail: mocks.detail, getChatModeStrict: mocks.mode, getChatInviteLink: mocks.invite,
  listThreadMessagesWithContext: mocks.thread, mergeForwardMessages: mocks.merge,
  forwardMessage: vi.fn(), isBotInChat: mocks.membership,
}));

import { handleOncallFormAction, handleOncallGroupAction, reconcileNativeOncallSubmissions } from '../src/im/lark/oncall-group.js';
import { OncallFormStore, type OncallNativeSubmissionAttempt } from '../src/services/oncall-form-store.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { loadOncallGroupTarget } from '../src/services/oncall-group-client.js';

const target = { endpoint: 'https://oncall.example.test/api/inf/v1/chat/', tenantId: 12, emailDomain: 'example.test' };
const categoryA = { id: 34, tenant_id: 12, name: 'custom A', type_action: 'create_chat', workflow_id: 10 };
const categoryB = { id: 56, tenant_id: 12, name: 'custom B', type_action: 'create_chat', workflow_id: 11 };
const categoryEmpty = { id: 78, tenant_id: 12, name: 'empty', type_action: 'create_chat', workflow_id: 12 };
const choices = { regions: { cn: [categoryA], other: [categoryB], empty: [categoryEmpty] } };
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_source', rootId: 'om_q1',
  questionId: 'om_q1', messageId: 'om_a1', answer: 'answer', cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) };
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
let dir: string;
let now: number;
let rows: any[];
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); now = Date.parse('2026-01-01T00:00:00Z'); vi.setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), 'oncall-native-history-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: [source.chatId], flowMode: 'classify', formDisplay: 'private_card', forwardMode: 'none' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: target })); vi.stubEnv('ONCALL_SERVICE_SECRET', 'service-secret');
  mocks.reply.mockResolvedValue('om_form'); mocks.ephemeral.mockResolvedValue('om_form'); mocks.update.mockResolvedValue(undefined);
  mocks.withdraw.mockResolvedValue(true); mocks.remove.mockResolvedValue(true); mocks.mode.mockResolvedValue('group');
  mocks.sender.mockResolvedValue({ email: 'actor@example.test' }); mocks.detail.mockResolvedValue({ body: { content: 'question' } });
  mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture'); mocks.membership.mockResolvedValue(true);
  mocks.merge.mockResolvedValue({ messageId: 'om_receipt', invalidMessageIds: [] });
  mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
    { message_id: 'om_q1', create_time: String(now - 1000) }, { message_id: 'om_a1', create_time: String(now) },
  ] });
  const groups = new OncallGroupStore(dir); groups.registerTurn('app', 'session', source.questionId); groups.recordSource(source); rows = [];
  fetcher = vi.fn(async (url: string) => {
    if (url.includes('/workflow/')) {
      const workflowId = Number(url.split('/workflow/')[1]!.split('?')[0]);
      return json({ tenant_id: 12, type_id: workflowId === 10 ? 34 : workflowId === 11 ? 56 : 78,
        config: workflowId === 12 ? '[]' : '[{"base":{"key":"field","type":"input"}}]' });
    }
    if (url.includes('/tools/')) return json({ lark_dialog_url: `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent('https://oncall.example.test/chat?tenant=12')}` });
    if (url.includes('/oncall_flow/list')) return json(rows);
    if (url.includes('/chat_id_to_open_chat_id')) return json('oc_destination');
    return json({ region: choices.regions });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

const current = (id: string) => new OncallFormStore(dir).use('app', id, 'ou_actor', async value => ({ ...value }), { allowClosed: true });
function useThread() { mocks.bot.config.oncallGroup.formDisplay = 'thread_card'; mocks.mode.mockResolvedValue('topic'); }
async function openDraft() {
  await handleOncallGroupAction({ operator: { open_id: 'ou_actor' },
    context: { open_chat_id: source.chatId, open_message_id: source.messageId },
    action: { value: { action: 'oncall_group_create' } } } as any, 'app');
  return new OncallFormStore(dir).pendingNativeSubmissions('app')[0]!;
}
async function changeRegion(draft: any, region: string) {
  const changed = await handleOncallFormAction({ operator: { open_id: 'ou_actor' },
    context: { open_chat_id: source.chatId, open_message_id: draft.messageId },
    action: { value: { action: 'oncall_group_form_region', draftId: draft.id, version: draft.version }, option: region } } as any, 'app');
  expect(changed.toast.type).toBe('info');
  await changed.afterAck();
}
function submitted(attempt: OncallNativeSubmissionAttempt, id: number, createdAtMs: number) {
  return { id, tenant_id: 12, source_location: attempt.sourceLocation, originator_user: 'actor',
    oncall_question_type_id: attempt.typeId, region: attempt.region, stage: 'launch_oncall',
    chat_id: '123456789', create_time: new Date(createdAtMs).toISOString() };
}
const request = () => new OncallGroupStore(dir).getRequest(source);
const listCalls = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/oncall_flow/list')).length;

describe('native submission snapshot history', () => {
  it('adopts A after the published card changes to custom B without a second submission', async () => {
    useThread(); const draft = await openDraft(); const attemptA = draft.nativeSubmission!.attempts[0]!;
    rows = [submitted(attemptA, 1234, now + 1000)]; vi.setSystemTime(now + 2000); await changeRegion(draft, 'other');
    const changed = await current(draft.id);
    expect(changed.nativeSubmission?.attempts).toHaveLength(2);
    expect(changed.nativeSubmission?.attempts[0]).toEqual(attemptA);
    vi.setSystemTime(now + 5000); await reconcileNativeOncallSubmissions('app');
    expect(request()).toMatchObject({ status: 'succeeded', flowId: '1234', openChatId: 'oc_destination' });
    expect((await current(draft.id)).nativeSubmission?.completed).toBe(true);
  });

  it('refuses to guess when both published selections were submitted', async () => {
    useThread(); const draft = await openDraft(); const attemptA = draft.nativeSubmission!.attempts[0]!;
    rows = [submitted(attemptA, 1234, now + 1000)]; vi.setSystemTime(now + 2000); await changeRegion(draft, 'other');
    const attemptB = (await current(draft.id)).nativeSubmission!.attempts[1]!;
    rows.push(submitted(attemptB, 5678, now + 3000)); vi.setSystemTime(now + 5000);
    mocks.update.mockClear(); await reconcileNativeOncallSubmissions('app');
    expect(request()).toBeUndefined(); expect(mocks.update).not.toHaveBeenCalled();
    expect((await current(draft.id)).nativeSubmission?.completed).not.toBe(true);
  });

  it('retains A when the next selection has an ordinary empty form', async () => {
    useThread(); const draft = await openDraft(); const attemptA = draft.nativeSubmission!.attempts[0]!;
    rows = [submitted(attemptA, 1234, now + 1000)]; vi.setSystemTime(now + 2000); await changeRegion(draft, 'empty');
    const changed = await current(draft.id);
    expect(changed.nativeFormLink).toBeUndefined();
    expect(changed.nativeSubmission?.attempts).toEqual([attemptA]);
    vi.setSystemTime(now + 5000); await reconcileNativeOncallSubmissions('app');
    expect(request()).toMatchObject({ status: 'succeeded', flowId: '1234' });
  });

  it('resolves the verified actor before publishing a native link from an upgraded draft', async () => {
    useThread(); const draft = new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_actor', source, visibility: 'thread',
      choices, region: 'cn', typeId: 34, priority: 'P2', description: 'question',
      targetFingerprint: JSON.stringify(loadOncallGroupTarget(dir, 'app')), messageId: 'om_form' });
    const changed = await handleOncallFormAction({ operator: { open_id: 'ou_actor' },
      context: { open_chat_id: source.chatId, open_message_id: draft.messageId },
      action: { value: { action: 'oncall_group_form_priority', draftId: draft.id, version: draft.version }, option: 'P1' } } as any, 'app');
    expect(changed.toast.type).toBe('info'); await changed.afterAck();
    const saved = await current(draft.id); const attempt = saved.nativeSubmission!.attempts[0]!;
    expect(attempt).toMatchObject({ username: 'actor', typeId: 34, region: 'cn' });
    expect(mocks.sender).toHaveBeenCalledWith('app', 'ou_actor', 'user');
    rows = [submitted(attempt, 1234, now + 1000)]; vi.setSystemTime(now + 5000); await reconcileNativeOncallSubmissions('app');
    expect(request()).toMatchObject({ status: 'succeeded', flowId: '1234' });
  });

  it('keeps private cleanup pending after deletion fails and completes it on retry', async () => {
    const draft = await openDraft(); const attempt = draft.nativeSubmission!.attempts[0]!;
    rows = [submitted(attempt, 1234, now + 1000)]; vi.setSystemTime(now + 5000); mocks.remove.mockResolvedValue(false);
    await reconcileNativeOncallSubmissions('app');
    expect(mocks.remove).toHaveBeenCalledWith('app', 'om_form');
    expect((await current(draft.id)).nativeSubmission?.completed).not.toBe(true);
    const attemptId = request()!.attemptId; const queries = listCalls();
    mocks.remove.mockResolvedValue(true); vi.setSystemTime(now + 70_000); await reconcileNativeOncallSubmissions('app');
    expect((await current(draft.id)).nativeSubmission?.completed).toBe(true);
    expect(request()?.attemptId).toBe(attemptId); expect(listCalls()).toBe(queries);
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });

  it('migrates the previous single-slot persisted submission without losing its route', async () => {
    useThread(); const draft = new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_actor', source, visibility: 'thread',
      choices, region: 'cn', typeId: 34, priority: 'P2', description: 'question', oncallUsername: 'actor',
      targetFingerprint: JSON.stringify(loadOncallGroupTarget(dir, 'app')), messageId: 'om_form',
      nativeSubmission: { sourceLocation: 'https://oncall.example.test/chat?bm_form=legacy', username: 'actor', preparedAtMs: now,
        policyFingerprint: JSON.stringify(mocks.bot.config.oncallGroup), forwardMode: 'none' } as any });
    const pending = new OncallFormStore(dir).pendingNativeSubmissions('app');
    expect(pending[0]?.nativeSubmission?.attempts).toHaveLength(1);
    const attempt = pending[0]!.nativeSubmission!.attempts[0]!;
    expect(attempt).toMatchObject({ typeId: 34, region: 'cn', username: 'actor' });
    rows = [submitted(attempt, 1234, now + 1000)]; vi.setSystemTime(now + 5000); await reconcileNativeOncallSubmissions('app');
    expect(request()).toMatchObject({ status: 'succeeded', flowId: '1234' });
    expect((await current(draft.id)).nativeSubmission).toMatchObject({ completed: true });
  });
});
