import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: { session: { dataDir: '' } }, bot: { config: { brand: 'feishu', oncallGroup: {} as any } },
  update: vi.fn(), withdraw: vi.fn(), invite: vi.fn(), merge: vi.fn(), membership: vi.fn(), thread: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/client.js', () => ({ updateMessage: mocks.update, deleteMessage: mocks.withdraw, getChatInviteLink: mocks.invite,
  forwardMessage: vi.fn(), mergeForwardMessages: mocks.merge, isBotInChat: mocks.membership, listThreadMessagesWithContext: mocks.thread }));
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { reconcileNativeOncallSubmissions, retryPendingOncallHandoffs } from '../src/im/lark/oncall-group.js';
import { readNativeOncallResult } from '../src/services/oncall-platform.js';
import { loadOncallGroupTarget } from '../src/services/oncall-group-client.js';
let dir: string, now: number, fetcher: ReturnType<typeof vi.fn>, rows: any[];
const source: OncallGroupSource = { appId: 'app', sessionId: 'old', chatId: 'oc_source', rootId: 'om_q1', questionId: 'om_q1', messageId: 'om_a1', answer: 'old answer' };
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); now = Date.parse('2026-01-01T00:00:00Z'); vi.setSystemTime(now);
  dir = mkdtempSync(join(tmpdir(), 'native-completion-review-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'thread_card', forwardMode: 'merge' };
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { tenantId: 12, endpoint: 'https://oncall.example.test/api/inf/v1/chat/', emailDomain: 'example.test' } }));
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'secret');
  const groups = new OncallGroupStore(dir); groups.registerTurn('app', 'old', 'om_q1', { chatId: source.chatId, rootId: source.rootId });
  groups.recordSource({ ...source, cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) });
  mocks.update.mockResolvedValue(undefined); mocks.withdraw.mockResolvedValue(true); mocks.membership.mockResolvedValue(true);
  mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=fixture');
  mocks.merge.mockResolvedValue({ messageId: 'om_receipt', invalidMessageIds: [] });
  mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [{ message_id: 'om_q1', create_time: String(now - 1000) }, { message_id: 'om_a1', create_time: String(now) }] });
  rows = [{ id: 1234, tenant_id: 12, source_location: 'https://oncall.example.test/chat?bm_form=synthetic', originator_user: 'actor', oncall_question_type_id: 34,
    region: 'cn', stage: 'launch_oncall', chat_id: '123456789', create_time: new Date(now + 1000).toISOString() }];
  fetcher = vi.fn(async (url: string) => json(url.includes('oncall_flow/list') ? rows : 'oc_destination')); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function draft() {
  const d = new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_actor', source, messageId: 'om_form', visibility: 'thread',
    description: 'synthetic question', choices: { regions: { cn: [] } }, region: 'cn', typeId: 34, priority: 'P2',
    targetFingerprint: JSON.stringify(loadOncallGroupTarget(dir, 'app')), nativeFormLink: 'https://oncall.example.test/chat',
    nativeSubmission: { sourceLocation: rows[0].source_location, username: 'actor', preparedAtMs: now,
      policyFingerprint: JSON.stringify(mocks.bot.config.oncallGroup), forwardMode: 'merge' } });
  vi.setSystemTime(now + 5000); return d;
}
const current = (d: any) => new OncallFormStore(dir).use('app', d.id, 'ou_actor', async value => ({ ...value }), { allowClosed: true });
function changeTarget() { const target = loadOncallGroupTarget(dir, 'app'); writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { ...target, tenantId: 99 } })); }

describe('native completion independent review', () => {
  it.each(['disabled', 'target', 'ownership'])('does not adopt after %s changes during the platform lookup', async intervention => {
    draft(); let release!: () => void; let owns = true;
    const pending = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementationOnce(async () => { await pending; return json(rows); });
    const run = reconcileNativeOncallSubmissions('app', () => owns); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    if (intervention === 'disabled') mocks.bot.config.oncallGroup.enabled = false;
    if (intervention === 'target') changeTarget();
    if (intervention === 'ownership') owns = false;
    release(); await run;
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('rechecks configuration after reading the conversation and before the atomic group adoption', async () => {
    draft(); mocks.thread.mockImplementationOnce(async () => { changeTarget(); return { verifiedThread: true, messages: [
      { message_id: 'om_q1', create_time: String(now - 1000) }, { message_id: 'om_a1', create_time: String(now) }] }; });
    await reconcileNativeOncallSubmissions('app');
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('resumes from the durable successful adoption after an interrupted caller, without a second platform lookup', async () => {
    const d = draft(); const original = OncallGroupStore.prototype.adoptNativeGroup;
    vi.spyOn(OncallGroupStore.prototype, 'adoptNativeGroup').mockImplementationOnce(function (...args) { original.apply(this, args); throw new Error('caller interrupted after write'); });
    await reconcileNativeOncallSubmissions('app'); const first = new OncallGroupStore(dir).getRequest(source)!;
    expect(first).toMatchObject({ status: 'succeeded', openChatId: 'oc_destination' }); expect((await current(d)).closed).not.toBe(true);
    const queries = fetcher.mock.calls.length; vi.setSystemTime(now + 70000); await retryPendingOncallHandoffs('app');
    expect(fetcher).toHaveBeenCalledTimes(queries); expect(new OncallGroupStore(dir).getRequest(source)?.attemptId).toBe(first.attemptId);
    expect(mocks.merge).toHaveBeenCalledOnce(); expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it('retries a failed form withdrawal after forwarding completes, without repeating the forwarded messages', async () => {
    const d = draft(); mocks.withdraw.mockResolvedValueOnce(false);
    await retryPendingOncallHandoffs('app'); expect(mocks.merge).toHaveBeenCalledOnce(); expect((await current(d)).nativeSubmission?.completed).not.toBe(true);
    vi.setSystemTime(now + 70000); await retryPendingOncallHandoffs('app');
    expect(mocks.withdraw).toHaveBeenCalledTimes(2); expect(mocks.merge).toHaveBeenCalledOnce(); expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it('bounds the old conversation at the next session while keeping that session unbound', async () => {
    draft(); const fresh = { ...source, sessionId: 'new', questionId: 'om_q2', messageId: 'om_a2' }; const groups = new OncallGroupStore(dir);
    groups.registerTurn('app', 'new', 'om_q2', { chatId: source.chatId, rootId: source.rootId }); groups.recordSource(fresh);
    mocks.thread.mockResolvedValue({ verifiedThread: true, messages: [
      { message_id: 'om_q1', create_time: String(now - 1000) }, { message_id: 'om_a1', create_time: String(now) },
      { message_id: 'om_q2', create_time: String(now + 200) }, { message_id: 'om_a2', create_time: String(now + 400) },
    ] });
    await retryPendingOncallHandoffs('app');
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', messageIdsSnapshot: ['om_q1', 'om_a1'] });
    expect(groups.getRequest(fresh)).toBeUndefined(); expect(mocks.merge.mock.calls[0][1]).toEqual(['om_q1', 'om_a1']);
  });
  it('ignores a cancelled candidate even when its earlier directory scan still included the form', async () => {
    const d = draft(); const prior = new OncallFormStore(dir).pendingNativeSubmissions('app');
    await new OncallFormStore(dir).use('app', d.id, 'ou_actor', async (value, persist) => { value.closed = true; delete value.nativeSubmission; persist(); });
    vi.spyOn(OncallFormStore.prototype, 'pendingNativeSubmissions').mockReturnValueOnce(prior);
    await reconcileNativeOncallSubmissions('app'); expect(fetcher).not.toHaveBeenCalled(); expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
  });
  it('completes a draft closed between its two persistence writes without re-querying the platform', async () => {
    const d = draft();
    new OncallGroupStore(dir).adoptNativeGroup(source, 'ou_actor', { flowId: '1234', openChatId: 'oc_destination' },
      { messageIds: ['om_q1', 'om_a1'], cutoffMs: now + 1000, forwardMode: 'merge' });
    await new OncallFormStore(dir).use('app', d.id, 'ou_actor', async (value, persist) => {
      value.closed = true; persist(); // interrupted here: closure durable, completed flag not yet
    }, { allowClosed: true });
    await reconcileNativeOncallSubmissions('app');
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('oncall_flow/list'))).toHaveLength(0);
    expect((await current(d)).nativeSubmission?.completed).toBe(true);
  });
  it('preserves an uncertain ordinary request that takes ownership while the native lookup waits', async () => {
    draft(); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementationOnce(async () => { await pending; return json(rows); });
    const run = reconcileNativeOncallSubmissions('app'); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const groups = new OncallGroupStore(dir); groups.claim(source, 'ou_other'); const before = groups.getRequest(source)!;
    groups.finish(source, { ...before, status: 'unknown' }, before.attemptId);
    release(); await run;
    expect(groups.getRequest(source)).toMatchObject({ status: 'unknown', attemptId: before.attemptId, operatorOpenId: 'ou_other' });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
  });
});


describe('native normalized source matching review', () => {
  const target = { tenantId: 12, endpoint: 'https://oncall.example.test/api/inf/v1/chat/', emailDomain: 'example.test' };
  const expected = { sourceLocation: 'https://oncall.example.test/chat?bm_form=wanted&bizFrom=botmux', username: 'actor', typeId: 34, region: 'cn' };
  it('does not adopt an order for a different form even when all business fields agree', async () => {
    rows[0].source_location = 'https://oncall.example.test/chat?bm_form=other&bizFrom=lark';
    await expect(readNativeOncallResult(target, 'secret', expected, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['https://another.example.test/chat?bm_form=wanted', 'https://oncall.example.test/another?bm_form=wanted',
    'https://oncall.example.test/chat?bm_form=wanted&bm_form=other'])('rejects an untrusted origin, path or duplicated correlation: %s', async location => {
    rows[0].source_location = location;
    await expect(readNativeOncallResult(target, 'secret', expected, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('stops after the bounded page window and refuses to infer absence from an incomplete scan', async () => {
    const other = { ...rows[0], source_location: 'https://oncall.example.test/chat?bm_form=other' };
    fetcher.mockImplementation(async (_url: string, options: any) => {
      const page = JSON.parse(options.body).current_page;
      return json(page > 10 ? [] : Array.from({ length: 100 }, (_, i) => ({ ...other, id: page * 1000 + i })));
    });
    await expect(readNativeOncallResult(target, 'secret', expected, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('refuses a second matching order found on a later page', async () => {
    const wanted = { ...rows[0], source_location: 'https://oncall.example.test/chat?bm_form=wanted&bizFrom=lark' };
    const other = { ...wanted, source_location: 'https://oncall.example.test/chat?bm_form=other' };
    fetcher.mockImplementation(async (_url: string, options: any) => {
      const page = JSON.parse(options.body).current_page;
      return json(page === 1 ? [wanted, ...Array.from({ length: 99 }, (_, i) => ({ ...other, id: 10000 + i }))] : [{ ...wanted, id: 9876 }]);
    });
    await expect(readNativeOncallResult(target, 'secret', expected, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
