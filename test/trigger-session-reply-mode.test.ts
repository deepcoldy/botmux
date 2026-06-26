import { describe, expect, it, vi, beforeEach } from 'vitest';

// triggerSessionTurn must mirror the inbound @ routing: in a 普通群 `new-topic`
// chat every webhook opens its own topic + session instead of folding into the
// group's one chat-scope session. These tests pin both halves — the pure
// per-topic decision and the chat-scope reuse-skip exercised via the dry-run path.

const mockGetBot = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (...a: any[]) => mockGetBot(...a) };
});

const mockIsInChat = vi.fn(async () => true);
vi.mock('../src/services/groups-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/groups-store.js')>();
  return { ...actual, isInChat: (...a: any[]) => mockIsInChat(...a) };
});

import { triggerSessionTurn, externalEventOpensOwnTopic } from '../src/core/trigger-session.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { ChatReplyMode } from '../src/bot-registry.js';

const APP = 'app1';
const CHAT = 'oc_1';

function dryRunReq(): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'c1', requestId: 'req_1' },
    target: { kind: 'turn', botId: APP, chatId: CHAT },
    envelope: { format: 'botmux.webhook.v1', sourceName: 'alertmanager', trusted: false, payload: { alert: 'x' } },
    options: { dryRun: true },
  };
}

function liveChatScopeSession(): DaemonSession {
  return { session: { sessionId: 'sess_existing' }, worker: { killed: false } } as unknown as DaemonSession;
}

function setMode(mode: ChatReplyMode | undefined, perChat?: ChatReplyMode) {
  mockGetBot.mockReturnValue({
    config: { regularGroupReplyMode: mode, chatReplyModes: perChat ? { [CHAT]: perChat } : undefined },
    botName: 'Bot',
    botOpenId: 'ou_bot',
  });
}

describe('externalEventOpensOwnTopic', () => {
  it('话题群 always opens its own topic, regardless of reply mode', () => {
    for (const m of ['chat', 'shared', 'chat-topic', 'new-topic'] as const) {
      expect(externalEventOpensOwnTopic('topic', m)).toBe(true);
    }
  });

  it('普通群 opens its own topic only in new-topic mode', () => {
    expect(externalEventOpensOwnTopic('group', 'new-topic')).toBe(true);
    for (const m of ['chat', 'shared', 'chat-topic'] as const) {
      expect(externalEventOpensOwnTopic('group', m)).toBe(false);
    }
  });
});

describe('triggerSessionTurn — webhook honors 普通群会话模式 (chat-scope reuse)', () => {
  beforeEach(() => {
    mockGetBot.mockReset();
    mockIsInChat.mockClear();
    mockIsInChat.mockResolvedValue(true);
  });

  async function run() {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey(CHAT, APP), liveChatScopeSession());
    return triggerSessionTurn(dryRunReq(), { larkAppId: APP, activeSessions });
  }

  it('chat mode reuses the group chat-scope session', async () => {
    setMode('chat');
    const res = await run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('would inject into existing session');
    expect(res.target?.sessionId).toBe('sess_existing');
  });

  it('default (no mode set) reuses the group chat-scope session', async () => {
    setMode(undefined);
    const res = await run();
    expect(res.message).toContain('would inject into existing session');
  });

  it('shared and chat-topic still reuse the chat-scope session at top level', async () => {
    for (const mode of ['shared', 'chat-topic'] as const) {
      setMode(mode);
      const res = await run();
      expect(res.message, mode).toContain('would inject into existing session');
    }
  });

  it('new-topic mode does NOT reuse — each webhook opens its own session', async () => {
    setMode('new-topic');
    const res = await run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('would create or deliver a new session turn');
    expect(res.target?.sessionId).toBeUndefined();
  });

  it('per-chat new-topic override beats a chat per-bot default', async () => {
    setMode('chat', 'new-topic');
    const res = await run();
    expect(res.message).toContain('would create or deliver a new session turn');
  });

  it('an explicit sessionId target still wins over new-topic (deliberate reuse)', async () => {
    setMode('new-topic');
    const activeSessions = new Map<string, DaemonSession>();
    const existing = liveChatScopeSession();
    activeSessions.set(sessionKey(CHAT, APP), existing);
    const req = dryRunReq();
    req.target.sessionId = 'sess_existing';
    const res = await triggerSessionTurn(req, { larkAppId: APP, activeSessions });
    expect(res.target?.sessionId).toBe('sess_existing');
    expect(res.message).toContain('would inject into existing session');
  });
});
