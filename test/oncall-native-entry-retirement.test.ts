import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLarkClientFunction } from './helpers/lark-function-harness.js';
const mocks = vi.hoisted(() => ({ config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: {} as any } },
  update: vi.fn(), ephemeral: vi.fn(), remove: vi.fn(), reply: vi.fn(), mode: vi.fn(), sender: vi.fn(), detail: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/im/lark/client.js', () => ({ updateMessage: mocks.update, sendEphemeralCard: mocks.ephemeral,
  deleteEphemeralCard: mocks.remove, replyMessage: mocks.reply, getChatModeStrict: mocks.mode,
  resolveSender: mocks.sender, getMessageDetail: mocks.detail }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));
import { attachOncallGroupButton, handleOncallFormAction, handleOncallGroupAction, refreshOncallSessionCard } from '../src/im/lark/oncall-group.js';
import { OncallFormStore } from '../src/services/oncall-form-store.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
import { loadOncallGroupTarget } from '../src/services/oncall-group-client.js';
import { executeWithLarkGate, __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
let dir: string;
const source: OncallGroupSource = { appId: 'app', sessionId: 'session', chatId: 'oc_source', rootId: 'om_root',
  messageId: 'om_reply', questionId: 'om_question', answer: 'answer' };
const category = { id: 34, name: 'category', tenant_id: 12, type_action: 'create_chat', workflow_id: 10 };
const response = (data: any) => new Response(JSON.stringify({ code: 0, data }));
beforeEach(() => {
  vi.resetAllMocks(); __testOnly_resetLarkGate();
  dir = mkdtempSync(join(tmpdir(), 'native-entry-review-')); mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'thread_card' };
  mocks.update.mockResolvedValue(undefined); mocks.ephemeral.mockResolvedValue('om_replacement'); mocks.remove.mockResolvedValue(true);
  mocks.reply.mockResolvedValue('om_unexpected'); mocks.mode.mockResolvedValue('topic');
  mocks.sender.mockResolvedValue({ email: 'owner@example.test' }); mocks.detail.mockResolvedValue({ body: { content: 'question' } });
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { endpoint: 'https://oncall.example.test/api/inf/v1/chat/',
    tenantId: 12, typeId: 999, region: 'legacy', emailDomain: 'example.test' } }));
  const groups = new OncallGroupStore(dir); groups.registerTurn('app', 'session', source.questionId); groups.recordSource({ ...source,
    cardJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }) });
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'secret');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('/workflow/')
    ? { tenant_id: 12, type_id: 34, config: '[{"base":{"key":"field","type":"input"}}]' }
    : url.includes('/tools/') ? { lark_dialog_url: `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent('https://oncall.example.test/chat?tenant=12')}` }
      : { region: { cn: [category] } })));
});
afterEach(() => { __testOnly_resetLarkGate(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
function draft(visibility: 'thread' | 'private' = 'thread') {
  mocks.bot.config.oncallGroup.formDisplay = visibility === 'thread' ? 'thread_card' : 'private_card';
  return new OncallFormStore(dir).open({ appId: 'app', ownerOpenId: 'ou_owner', source, visibility,
    choices: { regions: { cn: [category] } }, region: 'cn', typeId: 34, priority: 'P2', description: 'synthetic question',
    targetFingerprint: JSON.stringify(loadOncallGroupTarget(dir, 'app')), messageId: 'om_form' });
}
const event = (action: string, d: any, option?: string) => ({ operator: { open_id: 'ou_owner' },
  context: { open_chat_id: source.chatId, open_message_id: d.messageId }, action: { value: { action, draftId: d.id, version: d.version }, ...(option ? { option } : {}) } }) as any;
const current = (d: any) => new OncallFormStore(dir).use('app', d.id, 'ou_owner', async value => ({ ...value }), { allowClosed: true });
function rawCards() { return mocks.update.mock.calls.map(([, , raw]) => String(raw)); }
function page(raw: string) {
  const card = JSON.parse(raw); const button = card.body.elements.at(-1).columns[0].elements[0];
  return new URL(new URL(button.behaviors[0].default_url).searchParams.get('url')!);
}
function nativeWriter(sdk: ReturnType<typeof vi.fn>, name: 'updateMessage' | 'sendEphemeralCard') {
  const scope: Record<string, unknown> = { assertLarkTransport() {}, prepareLocalAddressContent: (text: string) => text,
    linkFieldContext: () => ({}), executeWithLarkGate, createTopicMessageLookupCache: () => ({ lookup: async () => undefined }),
    lookupWriteTopic() {}, assertMessageWriteAllowed: async () => {}, getBotClient: () => ({ request: sdk, im: { v1: { message: { patch: sdk } } } }),
    stampBotmuxCallbackMarkers: (text: string) => text, getLarkErrorCode: () => undefined, LARK_CODE_MESSAGE_WITHDRAWN: 230001,
    LARK_CODE_MESSAGE_UPDATE_EXPIRED: 230004, logger: { info() {} }, recordPublishedGroupContext: async () => {}, emitOutboundHookIfAllowed: async () => {},
  };
  return loadLarkClientFunction(name, scope);
}

describe('native entry publication lifecycle', () => {
  it('a late selection ACK reads the frozen native entry on the same classification message', async () => {
    const d = draft(); const selected = await handleOncallFormAction(event('oncall_group_form_priority', d, 'P1'), 'app');
    const ready = await handleOncallFormAction(event('oncall_group_form_submit', await current(d)), 'app');
    await ready.afterAck(); await selected.afterAck();
    expect(mocks.update.mock.calls.map(([, id]) => id)).toEqual(['om_form', 'om_form']);
    for (const raw of rawCards()) {
      expect(page(raw).searchParams.get('level')).toBe('P1'); expect(page(raw).searchParams.get('query')).toBe(d.description);
      expect(JSON.parse(raw).body.elements.some((e: any) => e.tag === 'select_static')).toBe(false);
    }
    expect(mocks.reply).not.toHaveBeenCalled(); expect((await current(d)).nativeEntry).toBeDefined();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
  });
  it('a latest-version selection cannot change the category snapshot already handed to the platform', async () => {
    const d = draft(); await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    const ready = await current(d);
    const changed = await handleOncallFormAction(event('oncall_group_form_priority', ready, 'P1'), 'app');
    await changed.afterAck();
    const saved = await current(d); expect(saved.priority).toBe('P2'); expect(saved.version).toBe(ready.version);
    expect(page(rawCards()[0]).searchParams.get('level')).toBe(saved.priority);
  });
  it('cancellation between native readiness and old ACK leaves every late view without the entry', async () => {
    const d = draft(); const ready = await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    const cancelled = await handleOncallFormAction(event('oncall_group_form_cancel', await current(d)), 'app');
    await ready.afterAck(); await cancelled.afterAck();
    expect((await current(d)).closed).toBe(true); expect(mocks.update).toHaveBeenCalledTimes(2);
    for (const raw of rawCards()) expect(raw).not.toContain('open_url');
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('a failed public PATCH recovers on reopening without allocating another classification card', async () => {
    const d = draft(); const ready = await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    mocks.update.mockRejectedValueOnce(new Error('ack lost'));
    await expect(ready.afterAck()).rejects.toThrow('ack lost');
    expect((await current(d)).nativeEntry).toBeDefined();
    const reopened = await handleOncallGroupAction({ operator: { open_id: 'ou_owner' },
      context: { open_chat_id: source.chatId, open_message_id: source.messageId }, action: { value: { action: 'oncall_group_create' } } } as any, 'app');
    expect(reopened.toast.type).toBe('info'); expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.calls.every(([, id]) => id === d.messageId)).toBe(true); expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('a failed private replacement retains the selected entry and retries from the same source', async () => {
    mocks.mode.mockResolvedValue('group'); const d = draft('private');
    const ready = await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    mocks.ephemeral.mockRejectedValueOnce(new Error('delivery failed'));
    await expect(ready.afterAck()).rejects.toThrow('delivery failed'); expect((await current(d)).messageId).toBe('om_form');
    await handleOncallGroupAction({ operator: { open_id: 'ou_owner' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId },
      action: { value: { action: 'oncall_group_create' } } } as any, 'app');
    expect((await current(d)).messageId).toBe('om_replacement'); expect(mocks.remove).toHaveBeenCalledWith('app', 'om_form');
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it.each(['thread', 'private'].flatMap(visibility => ['disabled', 'target', 'claim'].map(intervention => [visibility, intervention] as const)))
  ('the %s writer rechecks authority on rate-limit retry after %s changes', async (visibility, intervention) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '1');
    const d = draft(visibility as 'thread' | 'private'); const ready = await handleOncallFormAction(event('oncall_group_form_submit', d), 'app');
    const sdk = vi.fn().mockRejectedValueOnce(Object.assign(new Error('limited'), { response: {
      status: 429, data: { code: 99991400 }, headers: { 'retry-after': '1' } } })).mockResolvedValue({ code: 0, data: { message_id: 'om_replacement' } });
    if (visibility === 'thread') mocks.update.mockImplementation(nativeWriter(sdk, 'updateMessage'));
    else mocks.ephemeral.mockImplementation(nativeWriter(sdk, 'sendEphemeralCard'));
    const settled = ready.afterAck().then(() => undefined, (error: Error) => error);
    for (let i = 0; i < 200 && !sdk.mock.calls.length; i++) await new Promise(resolve => realSetTimeout(resolve, 2));
    expect(sdk).toHaveBeenCalledTimes(1);
    if (intervention === 'disabled') mocks.bot.config.oncallGroup.enabled = false;
    if (intervention === 'target') { const path = join(dir, 'oncall-group-targets.json'); const targets = JSON.parse(readFileSync(path, 'utf8'));
      targets.app.tenantId = 99; writeFileSync(path, JSON.stringify(targets)); }
    if (intervention === 'claim') new OncallGroupStore(dir).claim(source, 'ou_owner');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settled).toBeInstanceOf(Error); expect(sdk).toHaveBeenCalledTimes(1);
    expect((await current(d)).messageId).toBe('om_form'); expect(mocks.remove).not.toHaveBeenCalled();
  });
});


describe('native answer-card fallback', () => {
  function nativeSource(withExistingButton = false) {
    mocks.bot.config.oncallGroup.formDisplay = 'native';
    const base = JSON.stringify({ schema: '2.0', body: { elements: [] } });
    const cardJson = withExistingButton ? attachOncallGroupButton(base, mocks.bot.config.oncallGroup, source.chatId, 'group',
      { appId: source.appId, sessionId: source.sessionId, questionId: source.questionId, messageId: source.messageId, phase: 'final' }) : base;
    new OncallGroupStore(dir).recordSource({ ...source, cardJson });
  }
  const open = () => handleOncallGroupAction({ operator: { open_id: 'ou_owner' },
    context: { open_chat_id: source.chatId, open_message_id: source.messageId }, action: { value: { action: 'oncall_group_create' } } } as any, 'app');
  const button = (raw: string) => JSON.parse(raw).body.elements.at(-1).columns.at(-1).elements[0];
  it('replaces the callback already recorded on the delivered answer card with the native URL', async () => {
    nativeSource(true); const ready = await open(); await ready.afterAck();
    expect(new OncallGroupStore(dir).findSource('app', source.messageId)?.nativeLink).toBeDefined();
    expect(button(rawCards()[0]).behaviors[0].type).toBe('open_url');
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('a late fallback ACK cannot overwrite an already-created group invitation', async () => {
    nativeSource(true); const ready = await open(); const groups = new OncallGroupStore(dir);
    groups.claim(source, 'ou_owner');
    groups.finish(source, { status: 'succeeded', openChatId: 'oc_created',
      inviteLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=existing' }, groups.getRequest(source)!.attemptId);
    await expect(ready.afterAck()).rejects.toThrow();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(groups.getRequest(source)).toMatchObject({ status: 'succeeded', inviteLink: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=existing' });
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('recovers a persisted native URL after a failed PATCH from a new store instance', async () => {
    nativeSource(); const ready = await open(); mocks.update.mockRejectedValueOnce(new Error('lost patch'));
    await expect(ready.afterAck()).rejects.toThrow();
    expect(new OncallGroupStore(dir).findSource('app', source.messageId)?.nativeLink).toBeDefined();
    const next = await open(); await next.afterAck();
    expect(button(rawCards().at(-1)!).behaviors[0].type).toBe('open_url'); expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('does not revive a persisted old-destination URL after a failed PATCH and destination change', async () => {
    nativeSource(); const ready = await open(); mocks.update.mockRejectedValueOnce(new Error('lost patch'));
    await expect(ready.afterAck()).rejects.toThrow();
    const path = join(dir, 'oncall-group-targets.json'); const targets = JSON.parse(readFileSync(path, 'utf8'));
    targets.app.tenantId = 99; writeFileSync(path, JSON.stringify(targets));
    mocks.update.mockClear();
    await refreshOncallSessionCard(new OncallGroupStore(dir).findSource('app', source.messageId)!, { prepareInvite: false });
    expect(button(rawCards()[0]).behaviors[0].type).toBe('callback');
  });
  it('rejects a changed destination before ACK persistence and leaves the prior source intact', async () => {
    nativeSource(); const ready = await open(); const path = join(dir, 'oncall-group-targets.json');
    const targets = JSON.parse(readFileSync(path, 'utf8')); targets.app.tenantId = 99; writeFileSync(path, JSON.stringify(targets));
    await expect(ready.afterAck()).rejects.toThrow();
    expect(new OncallGroupStore(dir).findSource('app', source.messageId)?.nativeLink).toBeUndefined(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'target', 'claim'])('stops a stale native URL PATCH on retry after %s intervenes', async intervention => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '1');
    nativeSource(); const ready = await open();
    const sdk = vi.fn().mockRejectedValueOnce(Object.assign(new Error('limited'), { response: {
      status: 429, data: { code: 99991400 }, headers: { 'retry-after': '1' } } })).mockResolvedValue({ code: 0 });
    mocks.update.mockImplementation(nativeWriter(sdk, 'updateMessage'));
    const settled = ready.afterAck().then(() => undefined, (error: Error) => error);
    for (let i = 0; i < 200 && !sdk.mock.calls.length; i++) await new Promise(resolve => realSetTimeout(resolve, 2));
    expect(sdk).toHaveBeenCalledTimes(1);
    if (intervention === 'disabled') mocks.bot.config.oncallGroup.enabled = false;
    if (intervention === 'claim') new OncallGroupStore(dir).claim(source, 'ou_owner');
    if (intervention === 'target') { const path = join(dir, 'oncall-group-targets.json'); const targets = JSON.parse(readFileSync(path, 'utf8'));
      targets.app.tenantId = 99; writeFileSync(path, JSON.stringify(targets)); }
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settled).toBeInstanceOf(Error); expect(sdk).toHaveBeenCalledTimes(1);
  });
});
