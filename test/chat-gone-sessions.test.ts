/** A disbanded chat, or one this bot was removed from, ends only this bot's sessions there. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { SessionGroupEntry } from '../src/services/session-groups-store.js';
import type { CloseSessionResult } from '../src/core/worker-pool.js';

const h = vi.hoisted(() => ({
  entry: undefined as SessionGroupEntry | undefined,
  rows: [] as Session[],
  close: vi.fn<(id: string, opts?: unknown) => Promise<CloseSessionResult>>(),
  remove: vi.fn(),
  probe: vi.fn<(app: string, chat: string) => Promise<'disbanded' | 'bot_removed' | undefined>>(),
  ipc: vi.fn(),
}));
vi.mock('../src/services/session-groups-store.js', () => ({
  getSessionGroup: () => h.entry,
  removeSessionGroup: h.remove,
}));
vi.mock('../src/services/session-store.js', () => ({
  listSessionsStrict: () => h.rows,
  findActiveSessionsByChatStrict: () => h.rows.filter(s => s.status === 'active'),
}));
vi.mock('../src/core/worker-pool.js', () => ({ closeSession: h.close }));
vi.mock('../src/services/groups-store.js', () => ({ disbandChat: vi.fn(), probeChatGone: h.probe }));
vi.mock('../src/utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('../src/utils/daemon-discovery.js', () => ({ findOnlineDaemon: () => ({ ipcPort: 4100 }) }));
vi.mock('../src/core/daemon-ipc-auth.js', () => ({ fetchDaemonIpc: h.ipc }));
import { closeSessionsInGoneChat, closeSessionsInGoneChatsOnStartup } from '../src/core/dismiss-command.js';
import { withBotTurnAdmission, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';

const APP = 'cli_self';
const PEER = 'cli_peer';
const GONE = 'oc_gone';
const OTHER = 'oc_other';
const active = new Map<string, DaemonSession>();
const row = (sessionId: string, over: Partial<Session> = {}): Session => ({
  sessionId, chatId: GONE, rootMessageId: GONE, scope: 'chat', chatType: 'group', status: 'active',
  createdAt: '2026-11-01T00:00:00Z', title: sessionId, larkAppId: APP, ...over,
} as Session);
const live = (session: Session, larkAppId = APP): DaemonSession =>
  ({ session, larkAppId, chatId: session.chatId, chatType: session.chatType ?? 'group', scope: session.scope }) as unknown as DaemonSession;
const closedIds = () => h.close.mock.calls.map(([id]) => id).sort();

beforeEach(() => {
  vi.clearAllMocks(); active.clear(); __testOnly_resetBotTurnMutationGates();
  delete process.env.BOTMUX_COORDINATION_MODE;
  h.entry = undefined;
  h.rows = [];
  h.close.mockImplementation(async (id: string) => {
    const r = h.rows.find(x => x.sessionId === id); if (r) r.status = 'closed';
    return { ok: true, known: true, alreadyClosed: false, outcome: 'closed' };
  });
  h.remove.mockImplementation(() => { h.entry = undefined; });
  h.probe.mockResolvedValue(undefined);
});
afterEach(() => { delete process.env.BOTMUX_COORDINATION_MODE; });

describe('closeSessionsInGoneChat', () => {
  it('closes every session this bot holds in the chat, and nothing of other bots or other chats', async () => {
    const chat = row('s-chat');
    const topic = row('s-topic', { scope: 'thread', rootMessageId: 'om_topic' });
    const storeOnly = row('s-store-only', { scope: 'thread', rootMessageId: 'om_2' });
    const legacy = row('s-legacy', { larkAppId: undefined });
    h.rows = [chat, topic, storeOnly, legacy,
      row('s-elsewhere', { chatId: OTHER }), row('s-closed', { status: 'closed' }), row('s-peer-row', { larkAppId: PEER })];
    active.set('k1', live(chat));
    active.set('k2', live(topic));
    active.set('k3', live(row('s-peer-live', { larkAppId: PEER }), PEER));

    await closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'disbanded', activeSessions: active });

    expect(closedIds()).toEqual(['s-chat', 's-legacy', 's-store-only', 's-topic']);
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it('does not patch the closed card into the gone chat', async () => {
    h.rows = [row('s1')];
    await closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'bot_removed', activeSessions: active });
    expect(h.close).toHaveBeenCalledWith('s1', expect.objectContaining({ cardVisibility: 'private' }));
  });

  it('drops the session-group registration of the gone chat', async () => {
    h.rows = [row('s1')];
    h.entry = { ownerOpenId: 'ou_owner', lastSessionId: 's1', createdAt: 1, lastActiveAt: 1 };
    await closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'disbanded', activeSessions: active });
    expect(h.remove).toHaveBeenCalledWith(GONE);
  });

  it('keeps going when one session refuses to close', async () => {
    h.rows = [row('s1'), row('s2')];
    h.close.mockImplementationOnce(async () => { throw new Error('teardown unverified'); });
    await closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'disbanded', activeSessions: active });
    expect(closedIds()).toEqual(['s1', 's2']);
  });

  it('fails closed under durable primary', async () => {
    process.env.BOTMUX_COORDINATION_MODE = 'primary';
    h.rows = [row('s1')];
    h.entry = { ownerOpenId: 'ou_owner', lastSessionId: 's1', createdAt: 1, lastActiveAt: 1 };
    await closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'disbanded', activeSessions: active });
    expect(h.close).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('waits for an in-flight admission, so a session it creates in the chat is closed too', async () => {
    let admit!: () => void;
    const admission = withBotTurnAdmission(APP, () => new Promise<void>(resolve => { admit = () => {
      h.rows.push(row('s-new'));
      resolve();
    }; }));
    const closing = closeSessionsInGoneChat({ larkAppId: APP, chatId: GONE, reason: 'disbanded', activeSessions: active });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.close).not.toHaveBeenCalled();
    admit();
    await admission; await closing;
    expect(closedIds()).toEqual(['s-new']);
  });
});

describe('closeSessionsInGoneChatsOnStartup', () => {
  it('probes each of this bot\'s group chats once and closes only the gone ones', async () => {
    h.rows = [row('a1'), row('a2', { scope: 'thread', rootMessageId: 'om_a2' }), row('b1', { chatId: OTHER }),
      row('dm', { chatId: 'oc_dm', chatType: 'p2p' }), row('peer', { chatId: 'oc_peer_only', larkAppId: PEER }),
      row('old', { chatId: 'oc_old', status: 'closed' })];
    active.set('k1', live(row('live-only', { chatId: 'oc_live_only' })));
    active.set('k2', live(row('live-dm', { chatId: 'oc_live_dm', chatType: 'p2p' })));
    active.set('k3', live(row('peer-live', { chatId: 'oc_peer_live', larkAppId: PEER }), PEER));
    h.probe.mockImplementation(async (_app, chat) => chat === GONE ? 'disbanded' : undefined);

    await closeSessionsInGoneChatsOnStartup({ larkAppId: APP, activeSessions: active });

    expect(h.probe.mock.calls.map(([, chat]) => chat).sort()).toEqual([GONE, 'oc_live_only', OTHER]);
    expect(closedIds()).toEqual(['a1', 'a2']);
  });

  it('does not probe under durable primary', async () => {
    process.env.BOTMUX_COORDINATION_MODE = 'primary';
    h.rows = [row('a1')];
    await closeSessionsInGoneChatsOnStartup({ larkAppId: APP, activeSessions: active });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('probes only real Feishu chats, not doc-comment, HTTP or headless sessions', async () => {
    h.rows = [row('a1'), row('doc', { chatId: 'doc:doxcnAbc' }), row('http', { chatId: 'http_async_1' })];
    active.set('k1', live(row('headless', { chatId: 'headless_1' })));
    await closeSessionsInGoneChatsOnStartup({ larkAppId: APP, activeSessions: active });
    expect(h.probe.mock.calls.map(([, chat]) => chat)).toEqual([GONE]);
  });

  it('closes nothing when the chat state is unknown', async () => {
    h.rows = [row('a1')];
    await closeSessionsInGoneChatsOnStartup({ larkAppId: APP, activeSessions: active });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });
});
