import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { session: { dataDir: '' } },
  bot: { config: { brand: 'feishu', oncallGroup: { enabled: true, chatIds: ['oc_source'] } } },
  reply: vi.fn(), sender: vi.fn(), detail: vi.fn(), update: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => mocks.bot }));
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail: mocks.detail, replyMessage: mocks.reply, updateMessage: mocks.update }));
vi.mock('../src/im/lark/identity-cache.js', () => ({ resolveSender: mocks.sender }));

import { attachOncallGroupButton, handleOncallGroupAction, recordOncallGroupDelivery } from '../src/im/lark/oncall-group.js';
import { OncallGroupStore, type OncallGroupSource } from '../src/services/oncall-group-store.js';

let dir: string;
let source: OncallGroupSource;
let fetcher: ReturnType<typeof vi.fn>;
const event = (operator = 'ou_clicker', chatId = 'oc_source') => ({ context: { open_message_id: 'om_reply', open_chat_id: chatId }, operator: { open_id: operator }, action: { value: { action: 'oncall_group_create' } } }) as any;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'oncall-callback-'));
  mocks.config.session.dataDir = dir;
  mocks.bot.config.oncallGroup = { enabled: true, chatIds: ['oc_source'] };
  mocks.detail.mockResolvedValue({ body: { content: 'original question' } });
  mocks.sender.mockResolvedValue({ email: 'clicker@example.test' });
  mocks.reply.mockReset().mockResolvedValue('om_result');
  fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { oncall_flow_id: 123, open_chat_id: 'oc_created' } })));
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('ONCALL_SERVICE_JWT', 'test-token');
  writeFileSync(join(dir, 'oncall-group-targets.json'), JSON.stringify({ app: { endpoint: 'https://oncall.example.test/chat', tenantId: 12, typeId: 34, region: 'nation', emailDomain: 'example.test' } }));
  const card = JSON.parse(attachOncallGroupButton(JSON.stringify({ schema: '2.0', body: { elements: [] } }), mocks.bot.config.oncallGroup, 'oc_source'));
  source = { appId: 'app', chatId: 'oc_source', messageId: 'om_reply', questionId: 'om_question', answer: 'answer' };
  recordOncallGroupDelivery(dir, { ...source, card });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('Oncall card callback', () => {
  it('rejects missing operators, mismatched chats, missing sources and disabled old cards', async () => {
    for (const data of [event(''), event('ou_clicker', 'oc_other'), { ...event(), context: { open_message_id: 'om_unknown' } }]) {
      expect((await handleOncallGroupAction(data, 'app')).toast.type).toBe('error');
    }
    mocks.bot.config.oncallGroup.enabled = false;
    expect((await handleOncallGroupAction(event(), 'app')).toast.type).toBe('error');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the verified clicker account and replies with a link without changing the original card', async () => {
    await expect(handleOncallGroupAction(event(), 'app')).resolves.toBeUndefined();
    expect(mocks.sender).toHaveBeenCalledWith('app', 'ou_clicker', 'user');
    expect(fetcher.mock.calls[0][1].headers['x-api-user']).toBe('clicker');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).trigger_message).toContain('original question');
    expect(mocks.reply).toHaveBeenCalledWith('app', 'om_reply', expect.stringContaining('openChatId=oc_created'), 'text', true);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'botmux-feedback.sqlite'))).toBe(false);
    expect(new OncallGroupStore(dir).findSource('app', 'om_reply')).toEqual(source);
  });
  it('reuses the saved result after a reply failure, including for another clicker', async () => {
    mocks.reply.mockRejectedValueOnce(new Error('reply failed'));
    await expect(handleOncallGroupAction(event(), 'app')).rejects.toThrow('reply failed');
    await handleOncallGroupAction(event('ou_another'), 'app');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('openChatId=oc_created');
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
  it('replies with confirmed failures and permits an explicit retry', async () => {
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    await handleOncallGroupAction(event(), 'app');
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('可再次点击重试');
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('openChatId=oc_created');
  });
  it('does not call the platform when the clicker account cannot be verified', async () => {
    mocks.sender.mockResolvedValueOnce({ email: 'clicker@other.test' });
    await handleOncallGroupAction(event(), 'app');
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.reply.mock.calls.at(-1)![2]).toContain('无法确认 Oncall 账号');
  });
});
