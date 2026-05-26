import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

let host = '10.0.12.34';
const updateMessage = vi.fn().mockResolvedValue(true);

vi.mock('../src/config.js', () => ({
  config: {
    session: { dataDir: '/tmp/botmux-test' },
    web: {
      get externalHost() {
        return host;
      },
    },
  },
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage,
  deleteMessage: vi.fn().mockResolvedValue(true),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cliId: 'claude-code' }, botName: 'bot' }),
  getAllBots: () => [],
}));

function makeSession(): DaemonSession {
  return {
    session: {
      sessionId: 'session-1234567890',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'Terminal',
      status: 'active',
      createdAt: new Date().toISOString(),
      cliId: 'claude-code',
    },
    worker: null,
    workerPort: 7777,
    workerToken: 'token',
    larkAppId: 'app_1',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    streamCardId: 'om_card',
    streamCardNonce: 'nonce',
    lastScreenContent: 'ready',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

afterEach(async () => {
  updateMessage.mockClear();
  host = '10.0.12.34';
  const mod = await import('../src/core/worker-pool.js');
  mod.__testOnly_resetTerminalHostRefresh();
});

describe('terminal host refresh', () => {
  it('patches active streaming cards with the current external host', async () => {
    const ds = makeSession();
    const mod = await import('../src/core/worker-pool.js');
    mod.setActiveSessionsRegistry(new Map([['om_root::app_1', ds]]));

    host = '192.168.31.88';
    expect(mod.refreshTerminalHostCards('test')).toBe(1);

    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalled());
    const [, messageId, cardJson] = updateMessage.mock.calls[0];
    expect(messageId).toBe('om_card');
    expect(cardJson).toContain('http://192.168.31.88:7777');
    expect(cardJson).not.toContain('http://10.0.12.34:7777');
  });
});
