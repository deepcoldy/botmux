/**
 * Regression test for the codex P1 in PR D's first rework: a no-transport
 * session (apiOnly bot OR HTTP virtual chat) must produce ZERO Feishu API calls
 * on the auxiliary-UI card-patch path. The first attempt returned a synthetic
 * `anchor` from sessionReply as a fake message id, which got stored as
 * streamCardId and then scheduleCardPatch → updateMessage still dialed Feishu.
 *
 * This drives the REAL scheduleCardPatch entry (the leak site codex identified)
 * with a FakeLarkClient recording every updateMessage call, and asserts none fire.
 *
 * Run:  pnpm vitest run test/api-only-card-patch-suppression.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Record every Feishu transport call. Any invocation here is a FAILURE for a
// no-transport session.
const updateMessageMock = vi.fn(async () => 'om_should_not_happen');
const sendMessageMock = vi.fn(async () => 'om_should_not_happen');

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: (...a: any[]) => updateMessageMock(...a),
  sendMessage: (...a: any[]) => sendMessageMock(...a),
  sendUserMessage: vi.fn(async () => 'om_x'),
  deleteMessage: vi.fn(async () => undefined),
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
  addReaction: vi.fn(async () => undefined),
  removeReaction: vi.fn(async () => undefined),
  getMessageChatId: vi.fn(async () => 'oc_x'),
  MessageWithdrawnError: class extends Error {},
}));

// apiOnly bot config drives larkTransportEnabled → false.
const getBotMock = vi.fn(() => ({
  config: { larkAppId: 'local_riff', larkAppSecret: '', cliId: 'codex-app', apiOnly: true },
  resolvedAllowedUsers: [],
  botOpenId: 'bot_local_riff',
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (...a: any[]) => getBotMock(...a),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  loadBotConfigs: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => 'Feishu'),
}));

import { scheduleCardPatch } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

function makeNoTransportSession(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'uuid-apionly', rootMessageId: '', chatId: 'http_async_abc',
      title: 't', status: 'active' as any, createdAt: Date.now(), updatedAt: Date.now(),
      pid: null, chatType: 'group', scope: 'chat',
    },
    worker: { killed: false, send: vi.fn() } as any,
    workerPort: 8080,
    larkAppId: 'local_riff',
    chatId: 'http_async_abc',
    chatType: 'group',
    scope: 'chat',
    streamCardId: 'om_leaked_card_id', // a card id from a prior fake sentinel
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    ...overrides,
  } as unknown as DaemonSession;
}

describe('API-only: aux-UI card patch produces zero Feishu calls', () => {
  beforeEach(() => {
    updateMessageMock.mockClear();
    sendMessageMock.mockClear();
  });

  it('scheduleCardPatch is a no-op for an apiOnly session (no updateMessage)', () => {
    const ds = makeNoTransportSession();
    scheduleCardPatch(ds, JSON.stringify({ type: 'streaming', content: 'x' }));
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('scheduleCardPatch is a no-op for an HTTP virtual session on a normal bot', () => {
    // Even if the bot is NOT apiOnly, a synthetic http_async_* chat has no card.
    getBotMock.mockReturnValueOnce({
      config: { larkAppId: 'app_normal', larkAppSecret: 's', cliId: 'claude-code', apiOnly: false },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot',
    } as any);
    const ds = makeNoTransportSession({ larkAppId: 'app_normal', chatId: 'http_wait_xyz' });
    scheduleCardPatch(ds, JSON.stringify({ type: 'streaming', content: 'x' }));
    expect(updateMessageMock).not.toHaveBeenCalled();
  });

  it('sanity: a normal bot in a real chat DOES patch (gate is not over-broad)', () => {
    getBotMock.mockReturnValueOnce({
      config: { larkAppId: 'app_normal', larkAppSecret: 's', cliId: 'claude-code', apiOnly: false },
      resolvedAllowedUsers: [], botOpenId: 'ou_bot',
    } as any);
    const ds = makeNoTransportSession({ larkAppId: 'app_normal', chatId: 'oc_real', streamCardId: 'om_real_card' });
    scheduleCardPatch(ds, JSON.stringify({ type: 'streaming', content: 'x' }));
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
  });
});
