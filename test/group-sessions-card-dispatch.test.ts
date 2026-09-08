import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im/lark/client.js')>(
    '../src/im/lark/client.js',
  );
  return {
    ...actual,
    getMessageChatId: vi.fn(async () => 'oc_group'),
  };
});

vi.mock('../src/daemon-internal-client-wrapper.js', () => ({
  createDaemonClientFor: vi.fn(),
}));

import { createDaemonClientFor } from '../src/daemon-internal-client-wrapper.js';
import { handleCardAction, type CardActionData } from '../src/im/lark/card-handler.js';

const mockedCreateClient = vi.mocked(createDaemonClientFor);

describe('handleCardAction → public /sessions dispatch', () => {
  beforeEach(() => mockedCreateClient.mockReset());

  it('routes a group_sessions refresh through the scoped public handler', async () => {
    mockedCreateClient.mockReturnValue({
      request: vi.fn(async () => ({
        status: 200,
        raw: '',
        body: {
          sessions: [{
            sessionId: 's1',
            larkAppId: 'cli_test',
            botName: 'Bot',
            cliId: 'codex',
            status: 'working',
            adopt: false,
            spawnedAt: 0,
            lastMessageAt: 1_000,
            chatId: 'oc_group',
            rootMessageId: 'om_root',
            scope: 'thread',
            title: 'Visible topic',
            webPort: null,
            feishuChatLink: 'https://applink/chat',
            feishuThreadLink: 'https://applink/topic',
          }],
        },
      })),
    } as any);

    const data: CardActionData = {
      operator: { open_id: 'ou_invoker' },
      context: { open_message_id: 'om_card' },
      action: { value: {
        action: 'group_sessions_refresh',
        invoker_open_id: 'ou_invoker',
        chat_id: 'oc_group',
        page: '1',
      } },
    };
    const result = await handleCardAction(data, {
      activeSessions: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
      getActiveCount: () => 0,
      lastRepoScan: new Map(),
    } as any, 'cli_test');

    expect(result.toast).toBeUndefined();
    expect(JSON.stringify(result.card?.data)).toContain('Visible topic');
  });
});
