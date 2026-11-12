import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  identityRequest: vi.fn(),
  config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: { enabled: true, chatIds: ['oc_source'] } } },
  invite: vi.fn(), reply: vi.fn(), sender: vi.fn(), detail: vi.fn(), update: vi.fn(),
}));
vi.mock('../src/im/lark/md-card.js', () => ({ omitReplyCardImages: (card: string) => card }));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/client.js', () => ({ getChatInviteLink: mocks.invite, getMessageDetail: mocks.detail, replyMessage: mocks.reply, updateMessage: mocks.update }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));

import { attachOncallGroupButton, handleOncallGroupAction, reconcileOncallReplyCard, recordOncallGroupDelivery } from '../src/im/lark/oncall-group.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';
vi.mock('@larksuiteoapi/node-sdk', () => ({ DefaultCache: class {}, Client: class { request = mocks.identityRequest; } }));

let dir: string;
let source: OncallGroupSource;
let fetcher: ReturnType<typeof vi.fn>;
const event = (operator = 'ou_clicker', chatId = 'oc_source') => ({ context: { open_message_id: 'om_reply', open_chat_id: chatId }, operator: { open_id: operator }, action: { value: { action: 'oncall_group_create' } } }) as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invite.mockResolvedValue('https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=invite-oc_created');
  dir = mkdtempSync(join(tmpdir(), 'oncall-callback-'));
  mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'] };
  mocks.detail.mockResolvedValue({ body: { content: 'original question' } });
  mocks.sender.mockResolvedValue({ email: 'clicker@example.test' });
  mocks.reply.mockReset().mockResolvedValue('om_result');
  vi.stubEnv('ONCALL_SERVICE_SECRET', 'service-secret');
  fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 123, open_chat_id: 'oc_created' } })));
  vi.stubGlobal('fetch', fetcher);
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { endpoint: 'https://oncall.example.test/chat', tenantId: 12, typeId: 34, region: 'nation', emailDomain: 'example.test' } }));
  const card = JSON.parse(attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [] } }), mocks.bot.config.oncallGroup, 'oc_source'));
  source = { appId: 'app', chatId: 'oc_source', messageId: 'om_reply', questionId: 'om_question', answer: 'answer' };
  recordOncallGroupDelivery(dir, { ...source, card });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('Oncall card callback', () => {
  it('does not claim or create a group when the feature is disabled during shared identity lookup', async () => {
    (mocks.bot.config.oncallGroup as any).identitySource = 'shared';
    vi.stubEnv('ONCALL_IDENTITY_APP_ID', 'cli_directory'); vi.stubEnv('ONCALL_IDENTITY_APP_SECRET', 'pending-directory-secret');
    let release!: (profile: unknown) => void;
    mocks.identityRequest.mockImplementation(({ url }) => url.includes('/tenant/')
      ? Promise.resolve({ code: 0, data: { tenant: { tenant_key: 'tenant' } } })
      : new Promise(resolve => { release = resolve; }));
    const callback = event(); callback.operator.user_id = 'real_user'; callback.operator.tenant_key = 'tenant';
    const operation = handleOncallGroupAction(callback, 'app');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    mocks.bot.config.oncallGroup.enabled = false;
    release({ code: 0, data: { user: { user_id: 'real_user', email: 'actual@example.test' } } });
    await operation;
    expect(fetcher).not.toHaveBeenCalled();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
  });
  it('creates a group for a trusted shared-app user without querying the business app directory or trusting action values', async () => {
    (mocks.bot.config.oncallGroup as any).identitySource = 'shared';
    vi.stubEnv('ONCALL_IDENTITY_APP_ID', 'cli_directory'); vi.stubEnv('ONCALL_IDENTITY_APP_SECRET', 'directory-secret');
    mocks.identityRequest.mockImplementation(async ({ url }) => url.includes('/tenant/') ? { code: 0, data: { tenant: { tenant_key: 'tenant' } } }
      : { code: 0, data: { user: { user_id: 'real_user', email: 'actual@example.test' } } });
    const callback = event(); callback.operator.user_id = 'real_user'; callback.operator.tenant_key = 'tenant';
    callback.action.value.user_id = 'spoofed_user'; callback.action.value.email = 'spoofed@example.test';
    await handleOncallGroupAction(callback, 'app');
    expect(mocks.sender).not.toHaveBeenCalled();
    expect(mocks.identityRequest).toHaveBeenCalledWith(expect.objectContaining({ url: '/open-apis/contact/v3/users/real_user' }));
    expect(fetcher.mock.calls[0][1].headers['x-api-user']).toBe('actual');
    expect(new OncallGroupStore(dir).getRequest(source)?.status).toBe('succeeded');
  });
  it('rejects missing operators, mismatched chats, missing sources and disabled old cards', async () => {
    for (const data of [event(''), event('ou_clicker', 'oc_other'), { ...event(), context: { open_message_id: 'om_unknown' } }]) {
      expect((await handleOncallGroupAction(data, 'app')).toast.type).toBe('error');
    }
    mocks.bot.config.oncallGroup.enabled = false;
    expect((await handleOncallGroupAction(event(), 'app')).toast.type).toBe('error');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not bypass the classified form when an administrator changes the policy during identity resolution', async () => {
    mocks.sender.mockImplementationOnce(async () => {
      (mocks.bot.config as any).oncallGroup = { enabled: true, chatIds: ['oc_source'], flowMode: 'classify', formDisplay: 'private_card' };
      return { email: 'clicker@example.test' };
    });
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).not.toHaveBeenCalled();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
  });
  it('uses the verified clicker account and updates the card to a native group invitation', async () => {
    vi.stubEnv('ONCALL_SERVICE_SECRET', ' service-secret ');
    vi.stubEnv('BYTEDCLI_USER_CLOUD_JWT', 'another-user-jwt');
    await expect(handleOncallGroupAction(event(), 'app')).resolves.toBeUndefined();
    expect(mocks.sender).toHaveBeenCalledWith('app', 'ou_clicker', 'user');
    expect(process.env.BYTEDCLI_USER_CLOUD_JWT).toBe('another-user-jwt');
    expect(mocks.bot.config).not.toHaveProperty('triggerUserAuth');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer service-secret');
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('x-jwt-token');
    expect(fetcher.mock.calls[0][1].headers['x-api-user']).toBe('clicker');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).trigger_message).toContain('original question');
    expect(mocks.reply).toHaveBeenCalledWith('app', 'om_reply', expect.stringContaining('link_token=invite-oc_created'), 'text', true);
    expect(mocks.update).toHaveBeenCalledWith('app','om_reply',expect.stringContaining('link_token=invite-oc_created'));
    expect(existsSync(join(dir, 'botmux-feedback.sqlite'))).toBe(false);
    expect(new OncallGroupStore(dir).findSource('app', 'om_reply')).toMatchObject(source);
  });
  it.each(['', '  '])('does not create or claim a group with an empty service secret %j', async secret => {
    vi.stubEnv('ONCALL_SERVICE_SECRET', secret);
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).not.toHaveBeenCalled();
    expect(new OncallGroupStore(dir).getRequest(source)).toBeUndefined();
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('设置 ONCALL_SERVICE_SECRET');
    vi.stubEnv('ONCALL_SERVICE_SECRET', 'service-secret');
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('link_token=invite-oc_created');
  });
  it('reuses the saved result after a reply failure, including for another clicker', async () => {
    mocks.reply.mockRejectedValueOnce(new Error('reply failed'));
    await expect(handleOncallGroupAction(event(), 'app')).rejects.toThrow('reply failed');
    vi.stubEnv('ONCALL_SERVICE_SECRET', '');
    await handleOncallGroupAction(event('ou_another'), 'app');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('link_token=invite-oc_created');
  });
  it('deduplicates concurrent clicks and does not recreate after an uncertain result', async () => {
    let reject!: (error: Error) => void;
    fetcher.mockImplementationOnce(() => new Promise((_, rejectRequest) => { reject = rejectRequest; }));
    const first = handleOncallGroupAction(event(), 'app');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await handleOncallGroupAction(event(), 'app');
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('请勿重复创建');
    reject(new Error('timeout'));
    await first;
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new OncallGroupStore(dir).getRequest(source)?.status).toBe('unknown');
  });
  it.each([[401, '凭据无效或已失效'], [403, '缺少接口或租户权限'], [422, '建群失败']])('explains HTTP %s and permits an explicit retry after fixing it', async (status, message) => {
    fetcher.mockResolvedValueOnce(new Response('service-secret', { status }));
    await handleOncallGroupAction(event(), 'app');
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain(message);
    expect(mocks.reply.mock.calls.at(-1)![2]).not.toContain('service-secret');
    expect(new OncallGroupStore(dir).getRequest(source)).toMatchObject({ status: 'failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.stubEnv('ONCALL_SERVICE_SECRET', 'updated-secret');
    mocks.sender.mockResolvedValueOnce({ email: 'another@example.test' });
    await handleOncallGroupAction(event('ou_another'), 'app');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer updated-secret', 'x-api-user': 'another' });
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('link_token=invite-oc_created');
  });
  it('does not call the platform when the clicker account cannot be verified', async () => {
    mocks.sender.mockResolvedValueOnce({ email: 'clicker@other.test' });
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('无法确认 Oncall 账号');
  });
});


it('repairs a legacy non-session card for a different clicker without creating a second group',async()=>{
  const groups=new OncallGroupStore(dir);groups.claim(source,'ou_owner');groups.finish(source,{status:'succeeded',openChatId:'oc_created'});
  mocks.bot.config.oncallGroup.enabled=false;
  const e=event('ou_other');e.action.value.action='oncall_group_join';
  const result=await handleOncallGroupAction(e,'app');
  expect(result.toast.type).toBe('success');
  expect(mocks.update).not.toHaveBeenCalled();
  await result.afterAck();
  expect(mocks.sender).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
  const card=JSON.parse(mocks.update.mock.calls.at(-1)![2]);
  expect(card.body.elements.at(-1).columns.at(-1).elements[0].behaviors).toEqual([{type:'open_url',default_url:groups.getRequest(source)!.inviteLink}]);
});

it('rebuilds the group invitation on a non-session card after feedback readback drops its button',()=>{
  const groups=new OncallGroupStore(dir);groups.claim(source,'ou_owner');
  groups.finish(source,{status:'succeeded',openChatId:'oc_created',inviteLink:'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=invite-oc_created'});
  const card=reconcileOncallReplyCard('app','om_reply',{schema:'2.0',body:{elements:[]}});
  expect(card.body.elements.at(-1).columns.at(-1).elements[0].behaviors).toEqual([{type:'open_url',default_url:groups.getRequest(source)!.inviteLink}]);
});
