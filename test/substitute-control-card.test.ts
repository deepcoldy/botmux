/**
 * Integration test: substitute-mode owner control card delivery.
 *
 * When a substitute-mode (分身) session's worker reports ready, the worker-pool
 * automatically DMs a writable-terminal control card to the bot's owner(s).
 *
 * Scenarios covered:
 *   1. Substitute session → DM sent to each owner with a writable-terminal card.
 *   2. Non-substitute session (no pending flag / not triggered) → no DM.
 *   3. Already-sent persistent flag prevents duplicate delivery.
 *   4. No owner audience → skipped silently.
 *   5. Card JSON contains the writable terminal URL + manage buttons.
 *
 * Run: pnpm vitest run test/substitute-control-card.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

// ─── Mutable shared state ─────────────────────────────────────────────────

let botState: any = {
  config: { cliId: 'claude-code' },
  resolvedAllowedUsers: [],
  botOpenId: 'ou_bot',
};
let sendUserMessageCalls: { larkAppId: string; openId: string; cardJson: string; msgType: string }[] = [];
let updateSessionCalls: Session[] = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => botState),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendUserMessage: vi.fn(async (larkAppId: string, openId: string, cardJson: string, msgType: string) => {
    sendUserMessageCalls.push({ larkAppId, openId, cardJson, msgType });
    return 'om_dm_msg';
  }),
  sendEphemeralCard: vi.fn(),
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn((session: Session) => {
    updateSessionCalls.push(session);
  }),
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildSessionCard: vi.fn(
    (_sid: string, _rid: string, url: string, title: string, _cliId: string, showManageButtons?: boolean, adoptMode?: boolean) =>
      JSON.stringify({ type: 'session', url, title, showManageButtons: !!showManageButtons, adoptMode: !!adoptMode }),
  ),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty' },
  },
}));

vi.mock('../src/i18n/index.js', () => ({
  botLocale: vi.fn(() => 'zh'),
  localeForBot: vi.fn(() => 'zh'),
  t: vi.fn((key: string) => key),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { deliverSubstituteControlCard, scheduleCardPatch } from '../src/core/worker-pool.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSession(over?: Partial<Session>): Session {
  return {
    sessionId: 'uuid-sub-test',
    rootMessageId: 'om_root_001',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    title: 'Substitute test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: null,
    cliId: 'claude-code',
    ...over,
  } as Session;
}

function makeDs(over?: Partial<DaemonSession>): DaemonSession {
  return {
    session: makeSession(),
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'chat',
    workerPort: 8080,
    workerToken: 'tok_secret',
    pendingSubstituteControlCard: true,
    ...over,
  } as DaemonSession;
}

beforeEach(() => {
  botState = {
    config: { cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
  };
  sendUserMessageCalls = [];
  updateSessionCalls = [];
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('deliverSubstituteControlCard', () => {
  it('DMs a writable-terminal control card to each owner', async () => {
    botState.resolvedAllowedUsers = ['ou_owner1', 'ou_owner2'];
    const ds = makeDs();

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 2, total: 2 });
    expect(sendUserMessageCalls).toHaveLength(2);
    expect(sendUserMessageCalls.map(c => c.openId).sort()).toEqual(['ou_owner1', 'ou_owner2']);
    expect(sendUserMessageCalls[0].msgType).toBe('interactive');

    const card = JSON.parse(sendUserMessageCalls[0].cardJson);
    expect(card.type).toBe('session');
    expect(card.showManageButtons).toBe(true);
    expect(card.url).toContain('8080');
    expect(card.url).toContain('token=tok_secret');

    expect(ds.session.substituteControlCardSent).toBe(true);
    expect(updateSessionCalls).toHaveLength(1);
    expect(updateSessionCalls[0].substituteControlCardSent).toBe(true);
  });

  it('skips when the persistent sent flag is already set', async () => {
    botState.resolvedAllowedUsers = ['ou_owner1'];
    const ds = makeDs({ session: makeSession({ substituteControlCardSent: true }) });

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 0, total: 0 });
    expect(sendUserMessageCalls).toHaveLength(0);
    expect(updateSessionCalls).toHaveLength(0);
  });

  it('skips when there is no owner audience', async () => {
    botState.resolvedAllowedUsers = [];
    const ds = makeDs();

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 0, total: 0 });
    expect(sendUserMessageCalls).toHaveLength(0);
    expect(ds.session.substituteControlCardSent).toBeUndefined();
  });

  it('does not count non-ou_ entries as owners', async () => {
    botState.resolvedAllowedUsers = ['someone@corp.com', 'ou_realowner'];
    const ds = makeDs();

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 1, total: 1 });
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].openId).toBe('ou_realowner');
  });

  it('skips when the terminal is not ready (no port/token)', async () => {
    botState.resolvedAllowedUsers = ['ou_owner1'];
    const ds = makeDs({ workerPort: null, workerToken: null });

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 0, total: 0 });
    expect(sendUserMessageCalls).toHaveLength(0);
    expect(ds.session.substituteControlCardSent).toBeUndefined();
  });

  it('does not set the sent flag when all DMs fail', async () => {
    const { sendUserMessage } = await import('../src/im/lark/client.js');
    vi.mocked(sendUserMessage).mockRejectedValueOnce(new Error('rate limit'));

    botState.resolvedAllowedUsers = ['ou_owner1'];
    const ds = makeDs();

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 0, total: 1 });
    expect(ds.session.substituteControlCardSent).toBeUndefined();
    expect(updateSessionCalls).toHaveLength(0);
  });

  it('uses adoptMode=true when the session was adopted', async () => {
    botState.resolvedAllowedUsers = ['ou_owner1'];
    const ds = makeDs({ adoptedFrom: 'prior-session-id' });

    await deliverSubstituteControlCard(ds);

    const card = JSON.parse(sendUserMessageCalls[0].cardJson);
    expect(card.adoptMode).toBe(true);
  });

  it('scheduleCardPatch is turn-exact: a normal turn PATCH survives a substitute turn owning the slot', async () => {
    // codex delta P2: the outer screen-update gate was turn-exact but
    // scheduleCardPatch re-gated on the latest slot. Normal turn A's PATCH must
    // go through while substitute turn B holds currentReplyTarget — and B's
    // PATCH must stay suppressed in the reverse arrangement.
    const now = new Date().toISOString();
    const ds = makeDs({
      pendingSubstituteControlCard: false,
      cardPatchInFlight: true, // isolate the gate: queue only, no flush
      currentReplyTarget: { rootMessageId: 'om_trigger_b', turnId: 'om_b', updatedAt: now, substitute: true },
      session: makeSession({
        replyTargets: {
          om_a: { rootMessageId: 'om_a', updatedAt: now },
          om_b: { rootMessageId: 'om_trigger_b', updatedAt: now, substitute: true },
        },
      }),
    });

    scheduleCardPatch(ds, '{"card":"for-normal-A"}', 'om_a');
    expect(ds.pendingCardJson).toBe('{"card":"for-normal-A"}');

    ds.pendingCardJson = undefined;
    scheduleCardPatch(ds, '{"card":"for-substitute-B"}', 'om_b');
    expect(ds.pendingCardJson).toBeUndefined();
  });

  it('scheduleCardPatch reverse order: substitute turn suppressed while a normal turn owns the slot', async () => {
    const now = new Date().toISOString();
    const ds = makeDs({
      pendingSubstituteControlCard: false,
      cardPatchInFlight: true,
      currentReplyTarget: { rootMessageId: 'om_a', turnId: 'om_a', updatedAt: now },
      session: makeSession({
        replyTargets: {
          om_a: { rootMessageId: 'om_a', updatedAt: now },
          om_b: { rootMessageId: 'om_trigger_b', updatedAt: now, substitute: true },
        },
      }),
    });

    scheduleCardPatch(ds, '{"card":"for-substitute-B"}', 'om_b');
    expect(ds.pendingCardJson).toBeUndefined();

    scheduleCardPatch(ds, '{"card":"for-normal-A"}', 'om_a');
    expect(ds.pendingCardJson).toBe('{"card":"for-normal-A"}');
  });

  it('deduplicates owners', async () => {
    botState.resolvedAllowedUsers = ['ou_owner1', 'ou_owner1', 'ou_owner2'];
    const ds = makeDs();

    const result = await deliverSubstituteControlCard(ds);

    expect(result).toEqual({ sent: 2, total: 2 });
    expect(sendUserMessageCalls).toHaveLength(2);
  });
});
