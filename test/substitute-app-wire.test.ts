import { expect, it, vi } from 'vitest';
const { request, message } = vi.hoisted(() => {
  const message = { message_id: 'om_probe', chat_id: 'oc_probe', message_type: 'text', content: '{"text":"@_user_1 hi"}', mentions: [{ key: '@_user_1', id: { open_id: 'ou_scoped' } }] };
  const request = vi.fn(async ({ params }: any) => ({ code: 0, data: { items: [{
    message_id: message.message_id, chat_id: message.chat_id, msg_type: 'text', body: { content: message.content },
    mentions: [{ key: '@_user_1', name: 'External bot', id: params?.user_id_type ? 'cli_external' : 'ou_scoped', id_type: params?.user_id_type ? 'app_id' : 'open_id' }],
  }] } }));
  return { request, message };
});
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/tmp/botmux-app-wire-test' } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ loadBotConfigs: () => [], getBotClient: () => ({ request }) }));
vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {}, LoggerLevel: { error: 4 } }));
import { getMessageDetail } from '../src/im/lark/client.js';
import { resolveSubstituteAppMentions, substituteMentionIdentities } from '../src/im/lark/substitute-app-mentions.js';

it('keeps enriched reads unchanged while App ID substitution requests explicit ID types for bot identities', async () => {
  const ordinary = await getMessageDetail('cli_receiver', message.message_id);
  expect(ordinary.items[0].mentions[0].id).toBe('ou_scoped');
  const hydrated = await resolveSubstituteAppMentions('cli_receiver', message);
  expect(substituteMentionIdentities(hydrated)[0]).toMatchObject({ appId: 'cli_external', openId: 'ou_scoped' });
  expect(request.mock.calls[1][0].params.user_id_type).toBe('open_id');
  expect(request.mock.calls[2][0].params.user_id_type).toBeUndefined();
});
