/** Behavioral coverage for reusing Codex semantic titles without a second model call. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { SessionGroupConfig } from '../src/bot-registry.js';
import type { RenameChatResult } from '../src/services/groups-store.js';

const state = vi.hoisted(() => ({
  dir: '',
  cfg: { cliId: 'codex', model: 'main-model', wrapperCli: '', sessionGroup: { naming: { mode: 'session-title' } } as SessionGroupConfig },
  sessions: new Map<string, Session>(),
  rename: vi.fn<(...args: unknown[]) => Promise<RenameChatResult>>(),
  exec: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, 'Claude title', '');
    return { stdin: { end() {} } };
  }),
  updateTitle: vi.fn(),
  generate: vi.fn().mockResolvedValue('摘要标题'),
}));
vi.mock('../src/services/codex-app-threads.js', () => ({ generateCodexAppThreadTitle: (...args: unknown[]) => state.generate(...args) }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dir; } } } }));
vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: state.cfg }) }));
vi.mock('../src/services/groups-store.js', () => ({ renameChat: (...args: unknown[]) => state.rename(...args) }));
vi.mock('../src/services/session-store.js', () => ({ getSession: (id: string) => state.sessions.get(id) }));
vi.mock('../src/core/session-title.js', () => ({ updateSessionTitle: (...args: unknown[]) => state.updateTitle(...args) }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh' }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: (...args: unknown[]) => state.exec(...args),
}));

import { acceptSessionGroupTitle, scheduleSessionGroupTitle, subscribeSessionGroupTitles } from '../src/services/session-group-title.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import {
  initSessionGroups, registerSessionGroup, getSessionGroup, touchSessionGroup,
  markSessionGroupTitled, markSessionGroupTitleFailed,
} from '../src/services/session-groups-store.js';

const APP = 'cli_title';
const CHAT = 'oc_title';
/** Create a current chat-scope resident with a known placeholder name. */
function session(): Session {
  return { sessionId: 's1', chatId: CHAT, rootMessageId: 'om_seed', scope: 'chat', chatType: 'group',
    larkAppId: APP, title: 'placeholder', chatDisplayName: 'placeholder', nativeSessionTitle: '[BotMux·Lark] 排查超时', cliId: 'codex',
    status: 'active', createdAt: new Date().toISOString() };
}
/** Allow the fire-and-forget rename promise and its finally block to settle. */
async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }
/** Invoke the same scheduling entry used by birth and subsequent group messages. */
function schedule(): void { scheduleSessionGroupTitle({ larkAppId: APP, chatId: CHAT, userText: 'hello' }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  state.dir = mkdtempSync(join(tmpdir(), 'codex-group-title-'));
  state.cfg = { cliId: 'codex', model: 'main-model', wrapperCli: '', sessionGroup: { naming: { mode: 'session-title' } } };
  state.sessions.clear();
  state.sessions.set('s1', session());
  state.rename.mockReset().mockResolvedValue({ ok: true, oldName: 'placeholder', newName: '排查超时', changed: true });
  state.exec.mockClear();
  state.generate.mockClear();
  state.updateTitle.mockClear();
  initSessionGroups(APP);
  registerSessionGroup(CHAT, { ownerOpenId: 'ou_owner', lastSessionId: 's1', autoTitleBaseName: 'placeholder' });
});
afterEach(() => { vi.useRealTimers(); rmSync(state.dir, { recursive: true, force: true }); });

describe('Codex session-group native title reuse', () => {
  it('waits for the semantic event without running exec or consuming retry rounds', async () => {
    schedule();
    await settle();
    expect(state.exec).not.toHaveBeenCalled();
    expect(state.rename).not.toHaveBeenCalled();
    expect(getSessionGroup(CHAT)?.titleAttempts).toBeUndefined();
  });

  it('applies the configured prefix and the exact length cap, only once', async () => {
    state.cfg.sessionGroup = { namePrefix: '任务·', naming: { mode: 'session-title', maxLen: 3 } };
    const s = state.sessions.get('s1')!;
    acceptSessionGroupTitle(APP, s, '[BotMux·Lark] 排查超时');
    acceptSessionGroupTitle(APP, s, '[BotMux·Lark] 排查超时');
    await settle();
    expect(state.rename).toHaveBeenCalledTimes(1);
    expect(state.rename).toHaveBeenCalledWith(APP, CHAT, '任务·排查超', expect.objectContaining({ expectedOldName: 'placeholder' }));
    expect(state.exec).not.toHaveBeenCalled();
    expect(getSessionGroup(CHAT)).toMatchObject({ titled: true, pendingNativeTitle: undefined });
    schedule();
    await settle();
    expect(state.rename).toHaveBeenCalledTimes(1);
  });

  it.each(['42', '---', '2026'])('accepts a title the CLI-stdout sanitizer would reject: %s', async core => {
    const s = state.sessions.get('s1')!;
    s.nativeSessionTitle = `[BotMux·Lark] ${core}`;
    acceptSessionGroupTitle(APP, s, `[BotMux·Lark] ${core}`);
    await settle();
    expect(state.rename).toHaveBeenCalledWith(APP, CHAT, core, expect.anything());
  });

  it('truncates a long reused title to the configured maxLen, not the loose stdout ceiling', async () => {
    const longTitle = '排查支付链路上游超时的根因分析与修复方案';
    const s = state.sessions.get('s1')!;
    s.nativeSessionTitle = `[BotMux·Lark] ${longTitle}`;
    acceptSessionGroupTitle(APP, s, `[BotMux·Lark] ${longTitle}`);
    await settle();
    const applied = (state.rename.mock.calls[0] as unknown[])[2];
    expect(Array.from(String(applied)).length).toBe(12);
  });

  it.each([
    { scope: 'thread' as const }, { chatType: 'p2p' as const }, { status: 'closed' as const },
    { sessionId: 'obsolete' }, { larkAppId: 'cli_other' }, { nativeSessionTitleUserDefined: true },
    { chatId: 'oc_ordinary' },
  ])('ignores an ineligible source %j', async patch => {
    acceptSessionGroupTitle(APP, { ...session(), ...patch }, '[BotMux·Lark] 排查超时');
    await settle();
    expect(state.rename).not.toHaveBeenCalled();
    expect(getSessionGroup(CHAT)?.pendingNativeTitle).toBeUndefined();
  });

  it('honors truncate and already-titled groups', async () => {
    state.cfg.sessionGroup = { naming: { mode: 'truncate' } };
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    schedule();
    await settle();
    expect(state.rename).not.toHaveBeenCalled();
    expect(state.exec).not.toHaveBeenCalled();
    state.cfg.sessionGroup = {};
    markSessionGroupTitled(CHAT);
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    expect(state.rename).not.toHaveBeenCalled();
  });

  it('retries the persisted candidate after restart without resetting backoff on duplicate events', async () => {
    state.rename.mockResolvedValueOnce({ ok: false, error: 'lark_api_error' });
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    const failed = getSessionGroup(CHAT)!;
    expect(failed.titleAttempts).toBe(1);
    initSessionGroups(APP);
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    expect(state.rename).toHaveBeenCalledTimes(1);
    vi.setSystemTime(failed.titleRetryAt!);
    schedule();
    await settle();
    expect(state.rename).toHaveBeenCalledTimes(2);
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
    expect(state.exec).not.toHaveBeenCalled();
  });

  it('allows a generated title after legacy exec failures exhausted the retry budget', async () => {
    for (let i = 0; i < 3; i++) markSessionGroupTitleFailed(CHAT);
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    expect(state.rename).toHaveBeenCalledTimes(1);
  });

  it('drops cached titles when a different session becomes resident', async () => {
    state.rename.mockResolvedValueOnce({ ok: false, error: 'lark_api_error' });
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    touchSessionGroup(CHAT, 's2');
    state.sessions.set('s2', { ...session(), sessionId: 's2' });
    vi.advanceTimersByTime(600_000);
    schedule();
    await settle();
    expect(getSessionGroup(CHAT)?.pendingNativeTitle).toBeUndefined();
    expect(state.rename).toHaveBeenCalledTimes(1);
  });

  it('rechecks policy immediately before a delayed API write', async () => {
    let beforeUpdate: (() => unknown) | undefined;
    let finish: ((value: RenameChatResult) => void) | undefined;
    state.rename.mockImplementation((_app, _chat, _title, options) => {
      beforeUpdate = (options as { beforeUpdate: () => unknown }).beforeUpdate;
      return new Promise(resolve => { finish = resolve; });
    });
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    state.cfg.sessionGroup = { naming: { mode: 'truncate' } };
    expect(() => beforeUpdate!()).toThrow('no longer eligible');
    finish!({ ok: false, error: 'lark_api_error' });
    await settle();
    expect(getSessionGroup(CHAT)?.titled).not.toBe(true);
    expect(getSessionGroup(CHAT)?.titleAttempts).toBeUndefined();
  });

  it('reconciles remote success without a persisted local success marker', async () => {
    state.rename.mockResolvedValueOnce({ ok: false, error: 'name_changed', oldName: '排查超时', newName: '排查超时' });
    acceptSessionGroupTitle(APP, session(), '[BotMux·Lark] 排查超时');
    await settle();
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
  });

  it('retains the one-shot path for other CLIs even when birth gains a resident during generation', async () => {
    state.cfg.cliId = 'claude-code';
    state.cfg.sessionGroup = {};
    state.sessions.clear();
    registerSessionGroup(CHAT, { ownerOpenId: 'ou_owner', lastSessionId: '' });
    schedule();
    touchSessionGroup(CHAT, 's2');
    await settle();
    expect(state.exec).toHaveBeenCalledTimes(1);
    expect(state.rename).toHaveBeenCalledWith(APP, CHAT, 'Claude title', expect.anything());
  });
});


describe('summary mode and published Agent titles', () => {
  it('keeps AI summary as the default and explicitly forwards the Bot model', async () => {
    state.cfg.sessionGroup = {};
    schedule(); await settle();
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'main-model', sourceText: 'hello' }));
    expect(state.exec).not.toHaveBeenCalled();
    expect(getSessionGroup(CHAT)?.titled).toBe(true);
  });
  it('selects the optional lightweight model for the wrapper and isolated generator', async () => {
    state.cfg.wrapperCli = 'ttadk codex';
    state.cfg.sessionGroup = { naming: { mode: 'ai-summary', model: 'small-model' } };
    schedule(); await settle();
    const options = state.generate.mock.calls[0][0] as { model: string; codexBin: string; codexArgs: string[] };
    expect(options.model).toBe('small-model');
    expect(options.codexBin).toBe('ttadk');
    expect(options.codexArgs).toContain('small-model');
  });
  it('reuses a non-Codex Agent published title without any summary call', async () => {
    const s = state.sessions.get('s1')!;
    s.cliId = 'claude-code'; s.title = 'Agent title'; s.titleSource = 'agent';
    const unsubscribe = subscribeSessionGroupTitles();
    try {
      dashboardEventBus.publish({ type: 'session.update', body: { sessionId: s.sessionId, patch: { title: s.title } } });
      await settle();
      expect(state.rename).toHaveBeenCalledWith(APP, CHAT, 'Agent title', expect.anything());
      expect(state.generate).not.toHaveBeenCalled();
      expect(state.exec).not.toHaveBeenCalled();
      expect(state.updateTitle).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
  it('leaves legacy groups without a trusted birth name unchanged in reuse mode', async () => {
    registerSessionGroup('oc_legacy', { ownerOpenId: 'ou_owner', lastSessionId: 's1' });
    state.sessions.get('s1')!.chatId = 'oc_legacy';
    acceptSessionGroupTitle(APP, state.sessions.get('s1')!, '[BotMux·Lark] 排查超时');
    await settle(); expect(state.rename).not.toHaveBeenCalled();
  });
});
