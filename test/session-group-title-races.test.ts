/** Exercise naming races through the real stores, rename operation and controlled timers. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { SessionGroupConfig } from '../src/bot-registry.js';
const state = vi.hoisted(() => ({
  dir: '', cfg: { cliId: 'codex', sessionGroup: {} as SessionGroupConfig },
  sessions: new Map<string, Session>(), remote: 'placeholder', writes: [] as string[],
  failPersist: false, delay: 0, exec: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dir; } } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: state.cfg }), getOwnerOpenId: () => '', getBotClient: () => ({ im: { v1: { chat: { update: state.update } } } }) }));
vi.mock('../src/im/lark/client.js', () => ({ larkGet: (...args: unknown[]) => state.get(...args), listChatBotMembers: vi.fn(), getLarkErrorCode: vi.fn() }));
vi.mock('../src/services/session-store.js', () => ({ getSession: (id: string) => state.sessions.get(id), updateSession: (s: Session) => state.sessions.set(s.sessionId, structuredClone(s)) }));
vi.mock('../src/services/codex-app-threads.js', () => ({ generateCodexAppThreadTitle: vi.fn(async () => 'Codex title') }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh' }));
vi.mock('../src/utils/atomic-write.js', async orig => { const actual = await orig<typeof import('../src/utils/atomic-write.js')>(); return { ...actual, atomicWriteFileSync: (...args: Parameters<typeof actual.atomicWriteFileSync>) => { if (state.failPersist) throw new Error('injected EIO'); return actual.atomicWriteFileSync(...args); } }; });
vi.mock('node:child_process', async orig => ({ ...await orig<typeof import('node:child_process')>(), execFile: (...args: unknown[]) => { state.exec(); const cb = args.at(-1); if (typeof cb === 'function') cb(null, 'Claude title', ''); return { stdin: { end() {} } }; } }));
import { acceptSessionGroupTitle, scheduleSessionGroupTitle, subscribeSessionGroupTitles } from '../src/services/session-group-title.js';
import { updateSessionTitle } from '../src/core/session-title.js';
import { executeChatRename } from '../src/core/chat-rename-operation.js';
import { renameChat } from '../src/services/groups-store.js';
import { initSessionGroups, registerSessionGroup, getSessionGroup, touchSessionGroup } from '../src/services/session-groups-store.js';
const APP = 'cli_probe', CHAT = 'oc_probe';
/** Build a current group resident. */
function resident(id = 's1'): Session { return { sessionId: id, chatId: CHAT, rootMessageId: 'om_seed', scope: 'chat', chatType: 'group', larkAppId: APP, title: 'placeholder', chatDisplayName: 'placeholder', cliId: 'codex', status: 'active', createdAt: new Date().toISOString() }; }
let unsubscribe: (() => void) | undefined;
/** Deliver a worker title after saving the same native title in its resident. */
function native(title: string, sessionId = 's1'): void {
  const session = state.sessions.get(sessionId)!;
  session.nativeSessionTitle = `[BotMux·Lark] ${title}`;
  acceptSessionGroupTitle(APP, session, session.nativeSessionTitle);
}
/** Drain settled async callbacks without advancing delayed remote writes. */
async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }
/** Invoke the production retry entry. */
function schedule(): void { scheduleSessionGroupTitle({ larkAppId: APP, chatId: CHAT, userText: 'hello' }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  state.dir = mkdtempSync(join(tmpdir(), 'title-independent-')); state.cfg = { cliId: 'codex', sessionGroup: { naming: { mode: 'session-title' } } };
  state.sessions.clear(); state.sessions.set('s1', resident()); state.remote = 'placeholder'; state.writes = []; state.failPersist = false; state.delay = 0; state.exec.mockClear();
  state.get.mockReset().mockImplementation(async (_client, url: string) => url.endsWith('/is_in_chat') ? { code: 0, data: { is_in_chat: true } } : { code: 0, data: { name: state.remote } });
  state.update.mockReset().mockImplementation(async ({ data }: { data: { name: string } }) => { if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay)); state.remote = data.name; state.writes.push(data.name); return { code: 0 }; });
  initSessionGroups(APP); registerSessionGroup(CHAT, { ownerOpenId: 'ou_owner', lastSessionId: 's1', autoTitleBaseName: 'placeholder' });
});
afterEach(() => { unsubscribe?.(); unsubscribe = undefined; vi.useRealTimers(); rmSync(state.dir, { recursive: true, force: true }); });
describe('session-group title race recovery', () => {
  it('preserves an explicit group rename even after its display cache has refreshed', async () => {
    const changed = await executeChatRename(
      { larkAppId: APP, chatId: CHAT, name: '人工群名', trigger: 'user_explicit' },
      { renameChat, activeSessions: () => [{ chatId: CHAT, session: state.sessions.get('s1')! }],
        persistSession: s => state.sessions.set(s.sessionId, structuredClone(s)), logger: { info() {}, warn() {} } },
    );
    expect(changed.status).toBe(200);
    expect(state.sessions.get('s1')!.chatDisplayName).toBe('人工群名');
    vi.advanceTimersByTime(5000);
    native('自动标题');
    await settle();
    expect(state.remote).toBe('人工群名');
    expect(state.writes).toEqual(['人工群名']);
    expect(getSessionGroup(CHAT)?.autoTitleBaseName).toBe('placeholder');
  });

  it('applies the replacement resident title when the old remote request finally settles', async () => {
    state.delay = 60_000;
    native('旧会话标题');
    await settle();
    expect(state.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    touchSessionGroup(CHAT, 's2');
    state.sessions.set('s2', resident('s2'));
    native('新会话标题', 's2');
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.remote).toBe('旧会话标题');
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(getSessionGroup(CHAT)?.pendingNativeTitle?.title).toBe('新会话标题');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.writes).toEqual(['旧会话标题', '新会话标题']);
    expect(getSessionGroup(CHAT)).toMatchObject({ titled: true, autoTitleBaseName: '新会话标题' });
    expect(getSessionGroup(CHAT)?.pendingNativeTitle).toBeUndefined();
    expect(getSessionGroup(CHAT)?.titleAttempts).toBeUndefined();
  });

  it('reconciles remote success after local group writes failed and the registry reloads', async () => {
    state.delay = 1000;
    native('自动标题');
    await settle();
    state.failPersist = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.remote).toBe('自动标题');
    expect(state.sessions.get('s1')?.nativeSessionTitleUserDefined).toBeUndefined();
    expect(state.sessions.get('s1')?.nativeSessionTitle).toBe('[BotMux·Lark] 自动标题');
    state.failPersist = false;
    initSessionGroups(APP);
    expect(getSessionGroup(CHAT)?.titled).not.toBe(true);
    schedule();
    await settle();
    expect(getSessionGroup(CHAT)?.pendingNativeTitle).toBeUndefined();
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
    expect(state.writes).toEqual(['自动标题']);
    initSessionGroups(APP);
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
  });

  it('reuses an Agent rename from a non-Codex resident through the real event bus', async () => {
    state.sessions.get('s1')!.cliId = 'claude-code';
    unsubscribe = subscribeSessionGroupTitles();
    updateSessionTitle(state.sessions.get('s1')!, 'Agent 会话标题', 'agent');
    await settle();
    expect(state.exec).not.toHaveBeenCalled();
    expect(state.writes).toEqual(['Agent 会话标题']);
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
    expect(state.sessions.get('s1')?.titleSource).toBe('agent');
  });

  it('honors truncate enabled during a delayed remote read', async () => {
    state.get.mockImplementation(async (_client, url: string) => {
      if (url.endsWith('/is_in_chat')) return { code: 0, data: { is_in_chat: true } };
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { code: 0, data: { name: state.remote } };
    });
    native('自动标题');
    await settle();
    state.cfg.sessionGroup = { naming: { mode: 'truncate' } };
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.writes).toEqual([]);
    expect(getSessionGroup(CHAT)?.titleAttempts).toBeUndefined();
  });

  it('honors an explicit session title received while a native request is already in flight', async () => {
    state.delay = 1000;
    unsubscribe = subscribeSessionGroupTitles();
    native('旧模型标题');
    await settle();
    updateSessionTitle(state.sessions.get('s1')!, '人工会话标题', 'user');
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.writes).toEqual(['旧模型标题', '人工会话标题']);
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
    expect(state.sessions.get('s1')?.titleSource).toBe('user');
  });

  it('applies a reuse candidate when mode changes during an independent-title remote write', async () => {
    state.cfg = { cliId: 'claude-code', sessionGroup: { naming: { mode: 'ai-summary' } } };
    state.delay = 1000;
    schedule();
    await settle();
    expect(state.update).toHaveBeenCalledTimes(1);
    state.cfg.sessionGroup = { naming: { mode: 'session-title' } };
    native('新复用标题');
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.remote).toBe('新复用标题');
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
  });

  it('retains duplicate-event backoff and deduplicates scheduling during a long retry', async () => {
    state.update.mockResolvedValueOnce({ code: 999999, msg: 'temporary failure' });
    native('自动标题');
    await settle();
    const retryAt = getSessionGroup(CHAT)!.titleRetryAt!;
    expect(getSessionGroup(CHAT)?.titleAttempts).toBe(1);
    initSessionGroups(APP);
    native('自动标题');
    await settle();
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(getSessionGroup(CHAT)?.titleRetryAt).toBe(retryAt);
    vi.setSystemTime(retryAt);
    state.delay = 60_000;
    schedule();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    schedule();
    native('自动标题');
    await settle();
    expect(state.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.writes).toEqual(['自动标题']);
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
  });
});
