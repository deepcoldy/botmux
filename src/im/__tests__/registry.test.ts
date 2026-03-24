import { describe, it, expect, vi } from 'vitest';

// Mock @larksuiteoapi/node-sdk before any adapter import
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class MockClient {
    constructor(public opts: any) {}
  },
  WSClient: class MockWSClient {
    start() {}
  },
  EventDispatcher: class MockEventDispatcher {
    register() {}
  },
  LoggerLevel: { info: 2 },
}));

// Mock bot-registry
vi.mock('../../bot-registry.js', () => ({
  registerLarkClient: vi.fn(),
  stderrLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  getBot: vi.fn(() => ({ botUserId: 'ou_bot' })),
}));

// Mock Lark submodules that adapter.ts imports
vi.mock('../lark/client.js', () => ({
  sendMessage: vi.fn(), replyMessage: vi.fn(), updateMessage: vi.fn(),
  deleteMessage: vi.fn(), sendUserMessage: vi.fn(), downloadMessageResource: vi.fn(),
  resolveAllowedUsers: vi.fn(), listThreadMessages: vi.fn(),
  addReaction: vi.fn(), removeReaction: vi.fn(),
}));
vi.mock('../lark/event-dispatcher.js', () => ({
  startLarkEventDispatcher: vi.fn(), probeBotOpenId: vi.fn(), writeBotInfoFile: vi.fn(),
}));
vi.mock('../lark/card-builder.js', () => ({
  buildSessionCard: vi.fn(() => '{}'), buildStreamingCard: vi.fn(() => '{}'),
  buildRepoSelectCard: vi.fn(() => '{}'),
}));
vi.mock('../lark/message-parser.js', () => ({ parseApiMessage: vi.fn() }));

// Mock weixin submodules
vi.mock('../weixin/poller.js', () => ({
  WeixinPoller: class { start() {} stop() {} getContextToken() { return ''; } },
}));
vi.mock('../weixin/auth.js', () => ({
  loadToken: vi.fn(() => null),
  validateToken: vi.fn(async () => false),
}));
vi.mock('../weixin/client.js', () => ({
  sendMessage: vi.fn(), getUpdates: vi.fn(), sendTyping: vi.fn(),
  isAuthError: vi.fn(), isSuccess: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createImAdapter } from '../registry.js';
import { LarkImAdapter } from '../lark/adapter.js';
import { WeixinImAdapter } from '../weixin/adapter.js';
import type { BotConfig } from '../../bot-registry.js';

describe('createImAdapter', () => {
  it('returns LarkImAdapter for lark config', () => {
    const config: BotConfig = {
      im: 'lark',
      larkAppId: 'app_test',
      larkAppSecret: 'secret_test',
      cliId: 'claude-code',
    };
    const adapter = createImAdapter(config);
    expect(adapter).toBeInstanceOf(LarkImAdapter);
    expect(adapter.id).toBe('lark:app_test');
  });

  it('returns WeixinImAdapter for weixin config', () => {
    const config: BotConfig = {
      im: 'weixin',
      cliId: 'claude-code',
    };
    const adapter = createImAdapter(config);
    expect(adapter).toBeInstanceOf(WeixinImAdapter);
  });

  it('throws for unknown im type', () => {
    const config = {
      im: 'telegram' as any,
      cliId: 'claude-code',
    };
    expect(() => createImAdapter(config)).toThrow('Unknown IM type');
  });
});
