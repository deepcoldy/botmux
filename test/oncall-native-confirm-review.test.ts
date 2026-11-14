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
import { handleOncallFormAction, handleOncallGroupAction } from '../src/im/lark/oncall-group.js';
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
function nativeWriter(sdk: ReturnType<typeof vi.fn>, name: 'updateMessage' | 'sendEphemeralCard' | 'replyMessage') {
  const scope: Record<string, unknown> = { assertLarkTransport() {}, prepareLocalAddressContent: (text: string) => text,
    linkFieldContext: () => ({}), dedupeUuid: (uuid: string) => uuid, executeWithLarkGate, createTopicMessageLookupCache: () => ({ lookup: async () => undefined }),
    lookupWriteTopic() {}, assertMessageWriteAllowed: async () => {}, getBotClient: () => ({ request: sdk, im: { v1: { message: { patch: sdk, reply: sdk } } } }),
    stampBotmuxCallbackMarkers: (text: string) => text, getLarkErrorCode: () => undefined, LARK_CODE_MESSAGE_WITHDRAWN: 230001,
    LARK_CODE_MESSAGE_UPDATE_EXPIRED: 230004, logger: { info() {} }, recordPublishedGroupContext: async () => {}, emitOutboundHookIfAllowed: async () => {},
  };
  return loadLarkClientFunction(name, scope);
}


const click = () => ({ operator: { open_id: 'ou_owner' }, context: { open_chat_id: source.chatId, open_message_id: source.messageId },
  action: { value: { action: 'oncall_group_create' } } }) as any;
const confirm = (raw: string) => { const card = JSON.parse(raw); return (card.body?.elements ?? card.elements).at(-1).actions[0]; };
const innerPage = (url: string) => new URL(new URL(url).searchParams.get('url')!);
function changeTenant() { const path = join(dir, 'oncall-group-targets.json'); const targets = JSON.parse(readFileSync(path, 'utf8'));
  targets.app.tenantId = 99; writeFileSync(path, JSON.stringify(targets)); }
function nativeResponses(hook?: (url: string) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { hook?.(url); return response(url.includes('/workflow/')
    ? { tenant_id: 12, type_id: 34, config: '[{"base":{"key":"field","type":"input"}}]' }
    : url.includes('/tools/') ? { lark_dialog_url: `https://applink.feishu.cn/client/web_url/open?url=${encodeURIComponent('https://oncall.example.test/chat?tenant=12')}` }
      : { region: { cn: [category] } }); }));
}
function limitedSDK() { return vi.fn().mockRejectedValueOnce(Object.assign(new Error('limited'), { response: {
  status: 429, data: { code: 99991400 }, headers: { 'retry-after': '1' } } })).mockResolvedValue({ code: 0, data: { message_id: 'om_form' } }); }
async function reachedSDK(sdk: ReturnType<typeof vi.fn>) {
  for (let i = 0; i < 200 && !sdk.mock.calls.length; i++) await new Promise(resolve => realSetTimeout(resolve, 2));
  expect(sdk).toHaveBeenCalledTimes(1);
}

describe('prepared native confirmation review', () => {
  it('rolls back the selection and prepared URL when workflow preparation fails', async () => {
    const d = draft(); await new OncallFormStore(dir).use('app', d.id, 'ou_owner', async latest => { latest.nativeFormLink = 'https://old.example.test/prepared'; });
    const old = await current(d); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('workflow unavailable')));
    expect((await handleOncallFormAction(event('oncall_group_form_priority', old, 'P1'), 'app')).toast.type).toBe('error');
    expect(await current(d)).toEqual(old); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('preserves an existing prepared URL when reopening fails to refresh the workflow', async () => {
    const d = draft(); await new OncallFormStore(dir).use('app', d.id, 'ou_owner', async latest => { latest.nativeFormLink = 'https://old.example.test/prepared'; });
    const old = await current(d);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url.includes('/workflow/')) throw new Error('workflow unavailable'); return response({ region: { cn: [category] } }); }));
    expect((await handleOncallGroupAction(click(), 'app')).toast.type).toBe('error');
    expect(await current(d)).toEqual(old); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('restores the old selection when policy changes during native URL preparation', async () => {
    const d = draft(); const old = await current(d);
    nativeResponses(url => { if (url.includes('/tools/')) mocks.bot.config.oncallGroup.enabled = false; });
    expect((await handleOncallFormAction(event('oncall_group_form_priority', d, 'P1'), 'app')).toast.type).toBe('error');
    expect(await current(d)).toEqual(old); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not persist a new prepared URL when the target changes during reopening', async () => {
    const d = draft(); const old = await current(d);
    nativeResponses(url => { if (url.includes('/tools/')) changeTenant(); });
    expect((await handleOncallGroupAction(click(), 'app')).toast.type).toBe('error');
    expect(await current(d)).toEqual(old); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('a late selection ACK renders the latest level and prepared URL together', async () => {
    const d = draft(); const first = await handleOncallFormAction(event('oncall_group_form_priority', d, 'P1'), 'app');
    const second = await handleOncallFormAction(event('oncall_group_form_priority', await current(d), 'P0'), 'app');
    await second.afterAck(); await first.afterAck();
    for (const [, id, raw] of mocks.update.mock.calls) {
      expect(id).toBe('om_form'); expect(innerPage(confirm(raw).url).searchParams.get('level')).toBe('P0');
      expect(confirm(raw).value).toBeUndefined();
    }
    expect((await current(d)).priority).toBe('P0'); expect(mocks.reply).not.toHaveBeenCalled();
  });
  it.each(['thread', 'private'] as const)('initial %s publication stops after the destination changes during SDK retry', async visibility => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '1');
    mocks.bot.config.oncallGroup.formDisplay = visibility === 'thread' ? 'thread_card' : 'private_card';
    mocks.mode.mockResolvedValue(visibility === 'thread' ? 'topic' : 'group'); const sdk = limitedSDK();
    if (visibility === 'thread') mocks.reply.mockImplementation(nativeWriter(sdk, 'replyMessage'));
    else mocks.ephemeral.mockImplementation(nativeWriter(sdk, 'sendEphemeralCard'));
    const running = handleOncallGroupAction(click(), 'app'); await reachedSDK(sdk); changeTenant(); await vi.advanceTimersByTimeAsync(1500);
    expect((await running).toast.type).toBe('error'); expect(sdk).toHaveBeenCalledTimes(1);
  });
  it('a private selection replacement stops when the feature is disabled during SDK retry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '1');
    const d = draft('private'); const sdk = limitedSDK(); mocks.ephemeral.mockImplementation(nativeWriter(sdk, 'sendEphemeralCard'));
    const running = handleOncallFormAction(event('oncall_group_form_priority', d, 'P1'), 'app');
    await reachedSDK(sdk); mocks.bot.config.oncallGroup.enabled = false; await vi.advanceTimersByTimeAsync(1500);
    expect((await running).toast.type).toBe('error'); expect(sdk).toHaveBeenCalledTimes(1); expect(await current(d)).toMatchObject({ priority: 'P2', version: d.version });
  });
  it('a public selection ACK stops when another process claims the request during SDK retry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '1');
    const d = draft(); const ready = await handleOncallFormAction(event('oncall_group_form_priority', d, 'P1'), 'app');
    const sdk = limitedSDK(); mocks.update.mockImplementation(nativeWriter(sdk, 'updateMessage'));
    const settled = ready.afterAck().then(() => undefined, (error: Error) => error);
    await reachedSDK(sdk); new OncallGroupStore(dir).claim(source, 'ou_owner'); await vi.advanceTimersByTimeAsync(1500);
    expect(await settled).toBeInstanceOf(Error); expect(sdk).toHaveBeenCalledTimes(1);
  });
});
