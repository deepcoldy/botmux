import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing adapter
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

// Mock bot-registry so registerLarkClient is tracked
const mockRegisterLarkClient = vi.fn();
vi.mock('../../../bot-registry.js', () => ({
  registerLarkClient: (...args: any[]) => mockRegisterLarkClient(...args),
  stderrLogger: {
    error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  },
  getBot: vi.fn(() => ({ botUserId: 'ou_bot_123' })),
}));

// Mock lark client functions (not called in constructor / capabilities tests)
vi.mock('../client.js', () => ({
  sendMessage: vi.fn(),
  replyMessage: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  downloadMessageResource: vi.fn(),
  resolveAllowedUsers: vi.fn(),
  listThreadMessages: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
}));

vi.mock('../event-dispatcher.js', () => ({
  startLarkEventDispatcher: vi.fn(),
  probeBotOpenId: vi.fn(),
  writeBotInfoFile: vi.fn(),
}));

vi.mock('../card-builder.js', () => ({
  buildSessionCard: vi.fn(() => '{"mock":"session"}'),
  buildStreamingCard: vi.fn(() => '{"mock":"streaming"}'),
  buildRepoSelectCard: vi.fn(() => '{"mock":"repo"}'),
}));

vi.mock('../message-parser.js', () => ({
  parseApiMessage: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { LarkImAdapter } from '../adapter.js';

describe('LarkImAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets id to lark:{appId}', () => {
    const adapter = new LarkImAdapter('app_test_id', 'secret');
    expect(adapter.id).toBe('lark:app_test_id');
  });

  it('registers Lark client via registerLarkClient on construction', () => {
    new LarkImAdapter('app_xyz', 'sec');
    expect(mockRegisterLarkClient).toHaveBeenCalledWith('app_xyz', expect.any(Object));
  });

  describe('capabilities', () => {
    it('has correct capability values', () => {
      const adapter = new LarkImAdapter('app_cap', 'sec');
      expect(adapter.capabilities).toEqual({
        cards: true,
        updateMessage: true,
        threads: true,
        richText: true,
        reactions: true,
        typing: false,
        attachments: true,
      });
    });
  });

  describe('cards property', () => {
    it('buildSessionCard returns an ImCard with payload', () => {
      const adapter = new LarkImAdapter('app_c', 's');
      const card = adapter.cards.buildSessionCard({
        sessionId: 'sess-1',
        rootMessageId: 'om_root',
        terminalUrl: 'https://t.co',
        title: 'Test',
      });
      expect(card).toHaveProperty('payload');
      expect(typeof card.payload).toBe('string');
    });

    it('buildStreamingCard returns an ImCard with payload', () => {
      const adapter = new LarkImAdapter('app_c', 's');
      const card = adapter.cards.buildStreamingCard({
        sessionId: 'sess-1',
        rootMessageId: 'om_root',
        terminalUrl: 'https://t.co',
        title: 'Test',
        content: 'output',
        status: 'working',
      });
      expect(card).toHaveProperty('payload');
      expect(typeof card.payload).toBe('string');
    });

    it('buildRepoSelectCard returns an ImCard with payload', () => {
      const adapter = new LarkImAdapter('app_c', 's');
      const card = adapter.cards.buildRepoSelectCard({
        projects: [{ name: 'p1', path: '/p1', description: 'desc' }],
        currentCwd: '/p1',
        rootMessageId: 'om_root',
      });
      expect(card).toHaveProperty('payload');
      expect(typeof card.payload).toBe('string');
    });
  });

  it('getAppId returns the app ID', () => {
    const adapter = new LarkImAdapter('app_get', 'sec');
    expect(adapter.getAppId()).toBe('app_get');
  });

  it('getAppSecret returns the app secret', () => {
    const adapter = new LarkImAdapter('app_s', 'my_secret');
    expect(adapter.getAppSecret()).toBe('my_secret');
  });

  it('getLarkClient returns the constructed Lark.Client', () => {
    const adapter = new LarkImAdapter('app_lc', 'sec');
    const client = adapter.getLarkClient();
    expect(client).toBeDefined();
    expect((client as any).opts).toEqual({
      appId: 'app_lc',
      appSecret: 'sec',
      logger: expect.any(Object),
    });
  });
});
