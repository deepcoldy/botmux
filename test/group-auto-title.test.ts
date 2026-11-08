import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP = 'cli_creator';
const CHAT = 'oc_auto_group';
const PLACEHOLDER = 'AI·新会话 10/17 14:30';

let tempDir = '';
const mockGenerate = vi.fn();
const mockRenameChat = vi.fn();
const mockTitleAllowed = vi.fn(() => true);
let liveName = PLACEHOLDER;
const mockNameAvatar = vi.fn();
const mockUpdateSession = vi.fn();
let activeSessions = new Map<string, any>();

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/services/session-group-title.js', () => ({
  DEFAULT_TITLE_MAX_LEN: 12,
  MAX_SESSION_GROUP_TITLE_ROUNDS: 3,
  generateOneShotTitle: (...args: any[]) => mockGenerate(...args),
  oneShotTitleAllowed: (...args: any[]) => mockTitleAllowed(...args),
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cliId: 'claude-code' } }),
}));
vi.mock('../src/services/groups-store.js', () => ({
  renameChat: (...args: any[]) => mockRenameChat(...args),
  getChatName: async () => liveName,
}));
vi.mock('../src/services/group-name-avatar.js', () => ({
  applyGroupNameAvatar: (...args: any[]) => mockNameAvatar(...args),
}));
vi.mock('../src/services/session-store.js', () => ({
  updateSession: (...args: any[]) => mockUpdateSession(...args),
}));
vi.mock('../src/core/worker-pool.js', () => ({
  getActiveSessionsRegistry: () => activeSessions,
}));

type Mod = typeof import('../src/services/group-auto-title.js');
async function freshModule(): Promise<Mod> {
  vi.resetModules();
  return import('../src/services/group-auto-title.js');
}

function registryFile(): Record<string, any> {
  return JSON.parse(readFileSync(join(tempDir, `group-auto-title-${APP}.json`), 'utf-8'));
}

describe('group-auto-title (/g --auto)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'group-auto-title-'));
    for (const m of [mockGenerate, mockRenameChat, mockNameAvatar, mockUpdateSession]) m.mockReset();
    mockTitleAllowed.mockReset().mockReturnValue(true);
    liveName = PLACEHOLDER;
    // Mirrors renameChat's compare-and-set against the freshly read name.
    mockRenameChat.mockImplementation(async (_app: string, _chat: string, newName: string, opts: any = {}) => {
      if (opts.expectedOldName !== undefined && liveName !== opts.expectedOldName) {
        return { ok: false, error: 'name_changed', oldName: liveName, newName };
      }
      const oldName = liveName;
      liveName = newName;
      return { ok: true, oldName, newName, changed: true };
    });
    activeSessions = new Map([
      ['s1', { chatId: CHAT, session: { sessionId: 's1', chatDisplayName: PLACEHOLDER } }],
      ['s2', { chatId: 'oc_other', session: { sessionId: 's2', chatDisplayName: 'Other' } }],
    ]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('titles a registered chat once, applies the prefix, syncs sessions and drops the entry', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER, namePrefix: 'AI·', nameAvatar: true });
    expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(true);
    expect(registryFile()[CHAT]).toMatchObject({ placeholderName: PLACEHOLDER, namePrefix: 'AI·', nameAvatar: true });

    mockGenerate.mockResolvedValueOnce('支付链路排障');
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: '帮我查一下支付链路超时' });
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));

    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      larkAppId: APP, chatId: CHAT, userText: '帮我查一下支付链路超时', maxLen: 12,
    }));
    expect(mockRenameChat).toHaveBeenCalledWith(APP, CHAT, 'AI·支付链路排障', expect.objectContaining({ expectedOldName: PLACEHOLDER }));
    await vi.waitFor(() => expect(mockNameAvatar).toHaveBeenCalledWith(APP, CHAT, 'AI·支付链路排障'));
    expect(activeSessions.get('s1').session.chatDisplayName).toBe('AI·支付链路排障');
    expect(activeSessions.get('s2').session.chatDisplayName).toBe('Other');
    expect(registryFile()).toEqual({});

    // Later messages do nothing once the entry is gone.
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: '再来一条' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('ignores chats that were never registered and dedupes concurrent schedules', async () => {
    const mod = await freshModule();
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: 'oc_plain', userText: 'hello' });
    expect(mockGenerate).not.toHaveBeenCalled();

    let release!: (v: string) => void;
    mockGenerate.mockReturnValueOnce(new Promise<string>(resolve => { release = resolve; }));
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'first' });
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'second' });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    release('标题');
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    expect(mockNameAvatar).not.toHaveBeenCalled();
  });

  it('keeps a name a member set before the title landed (compare-and-set inside the rename)', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER, nameAvatar: true });
    mockGenerate.mockResolvedValueOnce('AI 标题');
    liveName = '我自己起的名字';
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    expect(liveName).toBe('我自己起的名字');
    expect(mockNameAvatar).not.toHaveBeenCalled();
    expect(activeSessions.get('s1').session.chatDisplayName).toBe(PLACEHOLDER);
  });

  it('defers (does not overwrite or drop) when the live name cannot be read', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
    mockGenerate.mockResolvedValueOnce('AI 标题');
    mockRenameChat.mockResolvedValueOnce({ ok: false, error: 'lark_api_error', detail: 'timeout' });
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(registryFile()[CHAT]?.titleAttempts).toBe(1));
    expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(true);
    expect(liveName).toBe(PLACEHOLDER);
  });

  it('drops the entry without any CLI call once the bot may no longer run one-shot titles', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
    mockTitleAllowed.mockReturnValue(false);
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRenameChat).not.toHaveBeenCalled();
  });

  it('paints the live name, not the stale AI title, when an explicit rename lands before the avatar', async () => {
    const mod = await freshModule();
    let settle!: () => void;
    const decorationsSettled = new Promise<void>(resolve => { settle = resolve; });
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER, nameAvatar: true }, decorationsSettled);
    mockGenerate.mockResolvedValueOnce('支付排障');
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: '支付链路超时' });
    await vi.waitFor(() => expect(liveName).toBe('支付排障'));
    liveName = '成员改的名字';
    settle();
    await vi.waitFor(() => expect(mockNameAvatar).toHaveBeenCalledWith(APP, CHAT, '成员改的名字'));
    expect(mockNameAvatar).toHaveBeenCalledTimes(1);
  });

  it('runs the rename inside the shared per-chat rename queue', async () => {
    const mod = await freshModule();
    const { chatRenameSerialQueue } = await import('../src/core/chat-rename.js');
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
    let releaseExplicit!: () => void;
    // An explicit rename (session skill / host API) already holds the chat key.
    const explicit = chatRenameSerialQueue.run(`${APP}:${CHAT}`, () => new Promise<void>(resolve => {
      releaseExplicit = () => { liveName = '成员起的名字'; resolve(); };
    }));
    mockGenerate.mockResolvedValueOnce('AI 标题');
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(mockGenerate).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(mockRenameChat).not.toHaveBeenCalled();
    releaseExplicit();
    await explicit;
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    // The queued auto rename re-read the name and kept the member's choice.
    expect(liveName).toBe('成员起的名字');
  });

  it('waits for the creation-time avatar before re-rendering the name avatar', async () => {
    const mod = await freshModule();
    let settle!: () => void;
    const decorationsSettled = new Promise<void>(resolve => { settle = resolve; });
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER, nameAvatar: true }, decorationsSettled);
    mockGenerate.mockResolvedValueOnce('支付排障');
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: '支付链路超时' });
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    expect(liveName).toBe('支付排障');
    await new Promise(r => setTimeout(r, 20));
    expect(mockNameAvatar).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(mockNameAvatar).toHaveBeenCalledWith(APP, CHAT, '支付排障'));
  });

  it('backs off between failed rounds and gives up after the session-group cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const mod = await freshModule();
      mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
      mockGenerate.mockRejectedValue(new Error('cli down'));

      mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'one' });
      await vi.waitFor(() => expect(registryFile()[CHAT]?.titleAttempts).toBe(1));
      // Inside the 30s backoff: no new round.
      mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'two' });
      expect(mockGenerate).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31_000);
      mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'three' });
      await vi.waitFor(() => expect(registryFile()[CHAT]?.titleAttempts).toBe(2));

      vi.setSystemTime(Date.now() + 121_000);
      mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'four' });
      await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
      expect(mockGenerate).toHaveBeenCalledTimes(3);
      expect(mockRenameChat).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying after bot_not_in_chat, which isInChat also reports on transient errors', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER });
    mockGenerate.mockResolvedValueOnce('标题');
    mockRenameChat.mockResolvedValueOnce({ ok: false, error: 'bot_not_in_chat' });
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(registryFile()[CHAT]?.titleAttempts).toBe(1));
    expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(true);
  });

  it('stops retrying when the bot lacks the edit permission', async () => {
    const mod = await freshModule();
    mod.registerGroupAutoTitle(APP, CHAT, { placeholderName: PLACEHOLDER, nameAvatar: true });
    mockGenerate.mockResolvedValueOnce('标题');
    mockRenameChat.mockResolvedValueOnce({ ok: false, error: 'permission_denied', detail: 'only owner (code: 232014)' });
    mod.scheduleGroupAutoTitle({ larkAppId: APP, chatId: CHAT, userText: 'hi there' });
    await vi.waitFor(() => expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(false));
    expect(mockNameAvatar).not.toHaveBeenCalled();
    expect(activeSessions.get('s1').session.chatDisplayName).toBe(PLACEHOLDER);
  });

  it('survives a restart through the per-bot file and drops expired entries', async () => {
    const now = Date.now();
    writeFileSync(join(tempDir, `group-auto-title-${APP}.json`), JSON.stringify({
      [CHAT]: { placeholderName: PLACEHOLDER, createdAt: now - 60_000 },
      oc_stale: { placeholderName: 'old', createdAt: now - 31 * 24 * 60 * 60 * 1000 },
      oc_corrupt: { createdAt: now },
    }));
    const mod = await freshModule();
    expect(mod.hasPendingGroupAutoTitle(APP, CHAT)).toBe(true);
    expect(mod.hasPendingGroupAutoTitle(APP, 'oc_stale')).toBe(false);
    expect(mod.hasPendingGroupAutoTitle(APP, 'oc_corrupt')).toBe(false);
    expect(mod.hasPendingGroupAutoTitle('cli_other_bot', CHAT)).toBe(false);
  });
});
