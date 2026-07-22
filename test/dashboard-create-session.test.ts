/**
 * dashboard-create-session.test.ts
 *
 * Behavioral tests for the dashboard「创建会话」spawn/activate logic in
 * session-manager: spawnDashboardSession (backlog parks vs in_progress forks,
 * role-wrapped first-turn content) and activateQueuedSession (consumes the
 * wrapped queuedPrompt, clears queued). The CLI process is external — forkWorker
 * is stubbed so we exercise the routing/parking logic in isolation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

// ── in-memory session store ──────────────────────────────────────────────
const store = new Map<string, Session>();
let sessionSeq = 0;
vi.mock('../src/services/session-store.js', () => ({
  createSession: vi.fn((chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p'): Session => {
    const s: Session = {
      sessionId: `sess-${++sessionSeq}`,
      chatId, rootMessageId, title, chatType,
      status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
    store.set(s.sessionId, s);
    return s;
  }),
  updateSession: vi.fn((s: Session) => { store.set(s.sessionId, s); }),
  getSession: vi.fn((id: string) => store.get(id)),
  listSessions: vi.fn(() => [...store.values()]),
  closeSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));

const sendMessageMock = vi.fn(async () => 'om_banner_123');
const uploadImageMock = vi.fn(async () => 'img_dashboard_123');
const replyMessageMock = vi.fn(async () => 'om_reply_123');
const deleteMessageMock = vi.fn(async () => {});
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...a: any[]) => sendMessageMock(...a),
  uploadImage: (...a: any[]) => uploadImageMock(...a),
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
  getChatMode: vi.fn(async () => 'topic'),
  replyMessage: (...a: any[]) => replyMessageMock(...a),
  deleteMessage: (...a: any[]) => deleteMessageMock(...a),
  UserTokenMissingError: class extends Error {},
}));

const scanMultipleProjectsMock = vi.fn(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/services/project-scanner.js', () => ({
  scanMultipleProjects: (...a: any[]) => scanMultipleProjectsMock(...a),
}));

const forkWorkerMock = vi.fn();
const sendWorkerInputMock = vi.fn();
const closeWorkerSessionMock = vi.fn(async () => ({ ok: true, alreadyClosed: false }));
const runAutoWorktreeCommitMock = vi.fn(async () => {});
let activeRegistryMock: Map<string, DaemonSession> | null = null;
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  sendWorkerInput: (...a: any[]) => sendWorkerInputMock(...a),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test-cli-v1'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, k: string, ds: any) => {
    map.set(k, ds);
    return { accepted: true };
  }),
  getActiveSessionsRegistry: vi.fn(() => activeRegistryMock),
  isRelayableRealSession: vi.fn((ds: any) => !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput),
  closeSession: (...a: any[]) => closeWorkerSessionMock(...a),
  promoteQueuedActivationTail: vi.fn(() => false),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
}));

vi.mock('../src/im/lark/card-handler.js', () => ({
  runAutoWorktreeCommit: (...args: any[]) => runAutoWorktreeCommitMock(...args),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    // defaultWorkingDir 钉到 /tmp，让 forkOrShowRepoCard 直接 fork（不走 /repo 卡片分支），
    // 保持单测 hermetic（不真扫磁盘项目、不发卡）。/repo 卡片分支留给真机/集成验证。
    config: { cliId: 'claude-code', cliPathOverride: undefined, defaultWorkingDir: '/tmp' },
    botName: 'TestBot',
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  // oncall pin is per-bot now (resolveDashboardSpawnWorkingDir → findOncallChat).
  findOncallChat: vi.fn(() => undefined),
  findOncallChatForAnyBot: vi.fn(() => undefined),
  // Mirror the real helper: defaultWorkingDir, else enabled defaultOncall dir.
  effectiveDefaultWorkingDir: vi.fn((cfg: any) =>
    cfg?.defaultWorkingDir || (cfg?.defaultOncall?.enabled ? cfg.defaultOncall.workingDir : undefined) || undefined),
}));

vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn((ds: DaemonSession) => ({ sessionId: ds.session.sessionId, queued: !!ds.session.queued })),
}));
vi.mock('../src/core/role-resolver.js', () => ({
  resolveRole: vi.fn(() => ({ content: null, source: undefined })),
  resolveRoleInjection: vi.fn(() => ({ content: null, source: undefined, injectMode: 'none' })),
}));
vi.mock('../src/services/whiteboard-store.js', () => ({
  whiteboardEnabled: vi.fn(() => false),
  getWhiteboard: vi.fn(),
  ensureDefaultWhiteboard: vi.fn(),
}));

import {
  activateQueuedSession,
  buildReforkCliInput,
  executeScheduledTask,
  rememberLastCliInput,
  restoreActiveSessions,
  spawnDashboardSession,
} from '../src/core/session-manager.js';
import { sessionKey } from '../src/core/types.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { getBot } from '../src/bot-registry.js';
import { getAllBots } from '../src/bot-registry.js';
import type { ScheduledTask } from '../src/types.js';
import { setActiveSessionSafe } from '../src/core/worker-pool.js';
import {
  applyQueuedCodexAppLegacyFallback,
  mergeQueuedCodexAppTurn,
} from '../src/core/session-create.js';
import * as sessionStore from '../src/services/session-store.js';

const APP = 'cli_app_test';
const CHAT = 'oc_newgroup';

beforeEach(() => {
  store.clear();
  sessionSeq = 0;
  forkWorkerMock.mockClear();
  sendMessageMock.mockClear();
  uploadImageMock.mockClear();
  replyMessageMock.mockClear();
  deleteMessageMock.mockClear();
  scanMultipleProjectsMock.mockReset();
  scanMultipleProjectsMock.mockReturnValue([]);
  sendWorkerInputMock.mockClear();
  closeWorkerSessionMock.mockClear();
  runAutoWorktreeCommitMock.mockClear();
  vi.mocked(sessionStore.closeSession).mockClear();
  activeRegistryMock = null;
  vi.mocked(sessionStore.updateSession).mockImplementation((s: Session) => { store.set(s.sessionId, s); });
  vi.mocked(setActiveSessionSafe).mockImplementation(async (map: Map<string, any>, key: string, ds: any) => {
    map.set(key, ds);
    return { accepted: true } as any;
  });
  vi.mocked(getAllBots).mockReturnValue([]);
  (dashboardEventBus.publish as any).mockClear();
  vi.mocked(getBot).mockReturnValue({
    config: { cliId: 'claude-code', cliPathOverride: undefined, defaultWorkingDir: '/tmp' },
    botName: 'TestBot',
    botOpenId: 'ou_bot',
  } as any);
});

describe('spawnDashboardSession — backlog (待办池) parks without starting the CLI', () => {
  it('parks: worker:null, queued + queuedPrompt persisted, column=backlog, no fork', async () => {
    const active = new Map<string, DaemonSession>();
    const r = await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '修复登录 bug', column: 'backlog', role: 'solo', postBanner: true,
    });
    expect(r.ok).toBe(true);
    expect(forkWorkerMock).not.toHaveBeenCalled();
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds).toBeTruthy();
    expect(ds.worker).toBeNull();
    expect(ds.session.queued).toBe(true);
    expect(ds.session.queuedPrompt).toContain('修复登录 bug');
    expect(ds.session.kanbanColumn).toBe('backlog');
    expect(ds.hasHistory).toBe(false);
    // dashboard gets a spawned event so the backlog card shows immediately
    expect(dashboardEventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.spawned' }),
    );
    // banner posted once (postBanner)
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('banner posts the FULL content (no 300-char truncation that dropped the tail in the group)', async () => {
    const active = new Map<string, DaemonSession>();
    // >300 chars so the tail sits past the old slice(0,300) cutoff
    const longContent = '前缀内容'.repeat(90) + '怎么验\n1. 第一步\n2. 第二步收尾';
    expect(longContent.length).toBeGreaterThan(300);
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: longContent, column: 'backlog', role: 'solo', postBanner: true,
    });
    const bannerText = sendMessageMock.mock.calls[0][2] as string;
    expect(bannerText).toContain('第二步收尾'); // tail must survive — was dropped by the 300-char slice
  });

  it('posts pasted images after the visible task banner without changing spawn routing', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '看图修复', column: 'in_progress', role: 'solo', postBanner: true,
      attachments: [{ type: 'image', path: '/tmp/dashboard-shot.png', name: 'dashboard-shot.png' }],
    });
    expect(uploadImageMock).toHaveBeenCalledWith(APP, '/tmp/dashboard-shot.png');
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]).toEqual([APP, CHAT, JSON.stringify({ image_key: 'img_dashboard_123' }), 'image']);
    expect(forkWorkerMock.mock.calls[0][1].content).toContain('/tmp/dashboard-shot.png');
  });

  it('lead-role backlog stores the orchestration preamble in queuedPrompt (preserved through activation)', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '拆活给大家', column: 'backlog', role: 'lead',
      coworkers: [{ name: 'Coder' }, { name: 'Reviewer' }],
    });
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds.session.queuedPrompt).toContain('<botmux_lead_dispatch>');
    expect(ds.session.queuedPrompt).toContain('Coder');
    expect(ds.session.queuedPrompt).toContain('拆活给大家');
  });

  it('persists pasted images across restore and injects them when the backlog starts', async () => {
    const attachment = { type: 'image' as const, path: '/tmp/dashboard-shot.png', name: 'dashboard-shot.png' };
    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP, chatId: CHAT, content: '按截图修复', column: 'backlog', role: 'solo', attachments: [attachment],
    });
    expect(beforeRestart.get(sessionKey(CHAT, APP))!.session.queuedAttachments).toEqual([attachment]);
    expect(beforeRestart.get(sessionKey(CHAT, APP))!.session.dashboardAttachments).toEqual([attachment]);

    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingAttachments).toEqual([attachment]);
    forkWorkerMock.mockClear();
    expect(await activateQueuedSession(restored)).toMatchObject({ ok: true });
    expect(forkWorkerMock.mock.calls[0][1].content).toContain('/tmp/dashboard-shot.png');
    expect(restored.session.queuedAttachments).toBeUndefined();
  });

  it('persists and restores the clean Codex App sidecar across daemon restart before activation', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: {
        cliId: 'codex-app', cliPathOverride: undefined, defaultWorkingDir: '/tmp',
        codexAppCleanInput: true,
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    } as any);

    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP, chatId: CHAT, content: '重启后仍保持纯净', column: 'backlog', role: 'lead',
      coworkers: [{ name: 'Coder' }],
    });
    const parked = beforeRestart.get(sessionKey(CHAT, APP))!;
    expect(parked.session.queuedPrompt).toContain('<botmux_lead_dispatch>');
    expect(parked.session.queuedCodexAppText).toBe('重启后仍保持纯净');
    expect(parked.session.queuedCodexAppMessageContext).toContain('<botmux_lead_dispatch>');
    expect(parked.session.queuedCodexAppMessageContext).not.toContain('重启后仍保持纯净');

    // Simulate a fresh daemon: rebuild DaemonSession exclusively from the
    // persisted Session record, then activate the restored backlog row.
    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingCodexAppText).toBe('重启后仍保持纯净');
    expect(restored.pendingCodexAppMessageContext).toContain('<botmux_lead_dispatch>');
    expect(mergeQueuedCodexAppTurn({
      queued: true,
      queuedText: restored.session.queuedCodexAppText ?? restored.pendingCodexAppText,
      queuedMessageContext: restored.session.queuedCodexAppMessageContext ?? restored.pendingCodexAppMessageContext,
      currentText: '重启后的群消息',
      currentMessageContext: '<sender>晓雪</sender>',
    })).toMatchObject({
      text: '重启后仍保持纯净\n\n重启后的群消息',
      messageContext: expect.stringContaining('<botmux_lead_dispatch>'),
    });

    forkWorkerMock.mockClear();
    expect(await activateQueuedSession(restored)).toMatchObject({ ok: true });
    const [, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt.content).toContain('<botmux_lead_dispatch>');
    expect(prompt.codexAppInput.text).toBe('重启后仍保持纯净');
    expect(Object.values(prompt.codexAppInput.additionalContext ?? {}))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'untrusted', value: expect.stringContaining('<botmux_lead_dispatch>') }),
      ]));
    // Activation ownership is accepted, but the exact queued journal remains
    // until the real worker reports adapter-level submission.
    expect(restored.session.queuedCodexAppText).toBe('重启后仍保持纯净');
    expect(restored.session.queuedCodexAppMessageContext).toContain('<botmux_lead_dispatch>');
  });

  it('retains and eagerly replays a non-Codex pre-init journal after a daemon crash', async () => {
    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP,
      chatId: CHAT,
      content: 'recover at least once',
      column: 'backlog',
      role: 'solo',
    });
    const interrupted = beforeRestart.get(sessionKey(CHAT, APP))!;
    interrupted.session.queued = false;
    interrupted.session.queuedActivationPending = true;
    interrupted.session.queuedActivationToken = 'activation-before-crash';
    interrupted.session.queuedActivationInput = { content: interrupted.session.queuedPrompt! };
    interrupted.session.queuedActivationTurnId = 'turn-before-crash';
    interrupted.session.queuedActivationResume = false;
    // The journal deliberately retains all queued payload fields until init
    // IPC has returned and the success cleanup is durably committed.
    store.set(interrupted.session.sessionId, interrupted.session);

    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;

    expect(restored.session.queued).toBe(false);
    expect(restored.session.queuedActivationPending).toBe(true);
    expect(restored.session.queuedActivationToken).toBe('activation-before-crash');
    expect(restored.session.queuedActivationInput).toEqual({
      content: expect.stringContaining('recover at least once'),
    });
    expect(restored.session.queuedPrompt).toContain('recover at least once');
    expect(restored.pendingPrompt).toBeUndefined();
    expect(restored.hasHistory).toBe(false);
    expect(forkWorkerMock).toHaveBeenCalledWith(
      restored,
      restored.session.queuedActivationInput,
      {
        resume: false,
        turnId: 'turn-before-crash',
        dispatchAttempt: undefined,
      },
    );
  });

  it('restores a Codex pre-init journal through its accepted ledger without re-parking', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'codex-app', cliPathOverride: undefined, defaultWorkingDir: '/tmp' },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    } as any);
    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP,
      chatId: CHAT,
      content: 'recover from exact FIFO',
      column: 'backlog',
      role: 'solo',
    });
    const interrupted = beforeRestart.get(sessionKey(CHAT, APP))!;
    interrupted.session.cliId = 'codex-app';
    interrupted.session.queued = false;
    interrupted.session.queuedActivationPending = true;
    interrupted.session.codexAppDispatchLedger = [{
      dispatchId: 'dispatch-before-crash',
      turnId: 'turn-before-crash',
      state: 'accepted',
      content: 'recover from exact FIFO',
    }];
    store.set(interrupted.session.sessionId, interrupted.session);
    forkWorkerMock.mockClear();

    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;

    expect(restored.session.queued).toBe(false);
    expect(restored.hasHistory).toBe(false);
    expect(restored.session.codexAppDispatchLedger).toHaveLength(1);
    expect(forkWorkerMock).toHaveBeenCalledWith(restored, '', true);
  });

  it('starts a restored pre-clean-input backlog task safely from the Dashboard button', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: {
        cliId: 'codex-app', cliPathOverride: undefined, defaultWorkingDir: '/tmp',
        codexAppCleanInput: true,
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    } as any);

    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'LEGACY_BUTTON_TASK', column: 'backlog', role: 'lead',
      coworkers: [{ name: 'Coder' }],
    });
    const parked = beforeRestart.get(sessionKey(CHAT, APP))!;
    // Simulate a record persisted before queuedCodexApp* fields existed.
    delete parked.session.queuedCodexAppText;
    delete parked.session.queuedCodexAppMessageContext;

    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingCodexAppText).toBeUndefined();
    expect(restored.pendingCodexAppMessageContext).toBeUndefined();

    forkWorkerMock.mockClear();
    expect(await activateQueuedSession(restored)).toMatchObject({ ok: true });
    const [, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt.content.match(/LEGACY_BUTTON_TASK/g)).toHaveLength(1);
    expect(prompt.codexAppInput.text.match(/LEGACY_BUTTON_TASK/g)).toHaveLength(1);
    expect(prompt.codexAppInput.text).toContain('<botmux_lead_dispatch>');
  });

  it('restores a pre-clean-input backlog record and makes a topic reply legacy-only', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: {
        cliId: 'codex-app', cliPathOverride: undefined, defaultWorkingDir: '/tmp',
        codexAppCleanInput: true,
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    } as any);

    const beforeRestart = new Map<string, DaemonSession>();
    await spawnDashboardSession(beforeRestart, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'QUEUED_TASK_SENTINEL', column: 'backlog', role: 'lead',
      coworkers: [{ name: 'Coder' }],
    });
    const parked = beforeRestart.get(sessionKey(CHAT, APP))!;
    delete parked.session.queuedCodexAppText;
    delete parked.session.queuedCodexAppMessageContext;

    const afterRestart = new Map<string, DaemonSession>();
    await restoreActiveSessions(afterRestart);
    const restored = afterRestart.get(sessionKey(CHAT, APP))!;
    const queuedText = restored.session.queuedCodexAppText ?? restored.pendingCodexAppText;
    expect(queuedText).toBeUndefined();
    expect(restored.pendingCodexAppMessageContext).toBeUndefined();

    const merged = mergeQueuedCodexAppTurn({
      queued: true,
      queuedText,
      currentText: 'CURRENT_REPLY_SENTINEL',
      currentMessageContext: '<sender>晓雪</sender>',
    });
    const built = buildReforkCliInput(
      restored,
      `${restored.session.queuedPrompt}\n\nCURRENT_REPLY_SENTINEL`,
      {
        cliId: 'codex-app',
        codexAppText: merged.text,
        codexAppMessageContext: merged.messageContext,
      },
    );
    expect(built.codexAppInput?.text).toBe('CURRENT_REPLY_SENTINEL');

    const payload = applyQueuedCodexAppLegacyFallback(built, { queued: true, queuedText });
    expect(payload.content.match(/QUEUED_TASK_SENTINEL/g)).toHaveLength(1);
    expect(payload.content.match(/CURRENT_REPLY_SENTINEL/g)).toHaveLength(1);
    expect(payload).not.toHaveProperty('codexAppInput');

    rememberLastCliInput(restored, 'CURRENT_REPLY_SENTINEL', payload);
    expect(restored.lastCliInput).toBe(payload.content);
    expect(restored.lastCodexAppInput).toBeUndefined();
    expect(restored.session.lastCodexAppInput).toBeUndefined();
  });

  it('restores a durable picker by publishing and persisting a fresh authoritative card id', async () => {
    const pending: Session = {
      sessionId: 'pending-picker',
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      larkAppId: APP,
      title: 'pick a repo',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      queued: true,
      queuedPrompt: 'OPENING_N',
      pendingRepoSetup: {
        mode: 'picker',
        prompt: 'OPENING_N',
        repoCardMessageId: 'om_stale_picker',
      },
    };
    store.set(pending.sessionId, pending);
    scanMultipleProjectsMock.mockReturnValue([{
      name: 'repo', path: '/tmp', type: 'repo', branch: 'main',
    }]);
    sendMessageMock.mockResolvedValueOnce('om_fresh_picker');

    const active = new Map<string, DaemonSession>();
    await restoreActiveSessions(active);

    const restored = active.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingRepo).toBe(true);
    expect(restored.pendingPrompt).toBe('OPENING_N');
    expect(restored.repoCardMessageId).toBe('om_fresh_picker');
    expect(restored.session.pendingRepoSetup?.repoCardMessageId).toBe('om_fresh_picker');
    expect(sendMessageMock).toHaveBeenCalledWith(APP, CHAT, expect.any(String), 'interactive');
    expect(deleteMessageMock).toHaveBeenCalledWith(APP, 'om_stale_picker');
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });

  it('isolates a picker publish failure and keeps restoring later sessions with the exact setup journal', async () => {
    const pending: Session = {
      sessionId: 'pending-picker-failure',
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      larkAppId: APP,
      title: 'pick a repo',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      queued: true,
      queuedPrompt: 'OPENING_N',
      pendingRepoSetup: {
        mode: 'picker',
        prompt: 'OPENING_N',
        repoCardMessageId: 'om_old_picker',
      },
    };
    const sibling: Session = {
      sessionId: 'later-backlog',
      chatId: 'oc_later',
      rootMessageId: 'oc_later',
      scope: 'chat',
      larkAppId: APP,
      title: 'later',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:01Z').toISOString(),
      queued: true,
      queuedPrompt: 'LATER_TASK',
    };
    store.set(pending.sessionId, pending);
    store.set(sibling.sessionId, sibling);
    scanMultipleProjectsMock.mockReturnValue([{
      name: 'repo', path: '/tmp', type: 'repo', branch: 'main',
    }]);
    sendMessageMock.mockRejectedValueOnce(new Error('picker publish unavailable'));

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();

    const restored = active.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingRepo).toBe(true);
    expect(restored.pendingPrompt).toBe('OPENING_N');
    expect(restored.repoCardMessageId).toBe('om_old_picker');
    expect(restored.session.pendingRepoSetup).toMatchObject({
      mode: 'picker', prompt: 'OPENING_N', repoCardMessageId: 'om_old_picker',
    });
    expect(active.get(sessionKey('oc_later', APP))?.session.queuedPrompt).toBe('LATER_TASK');
  });

  it('contains detached auto-worktree recovery rejection and leaves the setup retryable', async () => {
    const pending: Session = {
      sessionId: 'pending-auto-worktree',
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      larkAppId: APP,
      title: 'make worktree',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      queued: true,
      queuedPrompt: 'OPENING_N',
      pendingRepoSetup: {
        mode: 'auto_worktree', prompt: 'OPENING_N', baseDir: '/tmp',
      },
    };
    store.set(pending.sessionId, pending);
    runAutoWorktreeCommitMock.mockRejectedValueOnce(new Error('worktree publish unavailable'));

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();
    await Promise.resolve();

    const restored = active.get(sessionKey(CHAT, APP))!;
    expect(restored.pendingRepo).toBe(true);
    expect(restored.pendingPrompt).toBe('OPENING_N');
    expect(restored.session.pendingRepoSetup).toMatchObject({
      mode: 'auto_worktree', prompt: 'OPENING_N', baseDir: '/tmp',
    });
  });

  it('isolates a historical same-anchor protected loser so one collision cannot abort daemon restart', async () => {
    const incumbent: Session = {
      sessionId: 'canonical-pending-owner',
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      larkAppId: APP,
      title: 'canonical',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      cliId: 'claude-code',
      queuedActivationPending: true,
      queuedActivationToken: 'canonical-token',
      queuedActivationInput: { content: 'CANONICAL_N' },
      queuedActivationTurnId: 'turn-canonical',
      queuedActivationResume: false,
    };
    const stagedLoser: Session = {
      sessionId: 'historical-staged-loser',
      chatId: CHAT,
      rootMessageId: CHAT,
      scope: 'chat',
      larkAppId: APP,
      title: 'loser',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:01Z').toISOString(),
      queued: true,
      queuedPrompt: 'LOSER_OPENING_N',
      pendingRepoSetup: { mode: 'picker', prompt: 'LOSER_OPENING_N' },
    };
    store.set(incumbent.sessionId, incumbent);
    store.set(stagedLoser.sessionId, stagedLoser);
    vi.mocked(setActiveSessionSafe).mockImplementation(async (map, key, ds) => {
      const current = map.get(key);
      if (!current) {
        map.set(key, ds);
        return { accepted: true } as any;
      }
      return {
        accepted: false,
        reason: 'both_pending',
        keptSessionId: current.session.sessionId,
        preservedIncomingSessionId: ds.session.sessionId,
      } as any;
    });

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();

    expect(active.get(sessionKey(CHAT, APP))?.session.sessionId).toBe(incumbent.sessionId);
    expect(store.get(stagedLoser.sessionId)).toMatchObject({
      status: 'active',
      queued: true,
      queuedPrompt: 'LOSER_OPENING_N',
      pendingRepoSetup: { mode: 'picker', prompt: 'LOSER_OPENING_N' },
    });
  });

  it('isolates a malformed queued+unsettled row and restores the later healthy row', async () => {
    const malformed: Session = {
      sessionId: 'malformed-queued', chatId: CHAT, rootMessageId: CHAT, scope: 'chat', larkAppId: APP,
      title: 'bad', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      queued: true, queuedPrompt: 'BAD_N',
      codexAppDispatchLedger: [{ dispatchId: 'bad-dispatch', turnId: 'bad-turn', state: 'prepared', content: 'BAD_N' }],
    };
    const healthy: Session = {
      sessionId: 'healthy-after-malformed', chatId: 'oc_healthy_1', rootMessageId: 'oc_healthy_1', scope: 'chat', larkAppId: APP,
      title: 'good', status: 'active', createdAt: new Date('2026-01-01T00:00:01Z').toISOString(),
      queued: true, queuedPrompt: 'GOOD_N',
    };
    store.set(malformed.sessionId, malformed);
    store.set(healthy.sessionId, healthy);

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();

    expect(active.has(sessionKey(CHAT, APP))).toBe(false);
    expect(store.get(malformed.sessionId)).toMatchObject({ status: 'active', queued: true, queuedPrompt: 'BAD_N' });
    expect(active.get(sessionKey('oc_healthy_1', APP))?.session.sessionId).toBe(healthy.sessionId);
  });

  it('isolates a tail-promotion write failure, rolls the row back, and restores the later row', async () => {
    const failed: Session = {
      sessionId: 'failed-tail-promotion', chatId: CHAT, rootMessageId: CHAT, scope: 'chat', larkAppId: APP,
      title: 'bad tail', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      cliId: 'claude-code',
      queuedActivationTail: [{ id: 'tail-1', order: 1, userPrompt: 'TAIL_N', cliInput: { content: 'TAIL_N' }, turnId: 'tail-turn' }],
      queuedActivationTailNextOrder: 1,
    };
    const healthy: Session = {
      sessionId: 'healthy-after-tail', chatId: 'oc_healthy_2', rootMessageId: 'oc_healthy_2', scope: 'chat', larkAppId: APP,
      title: 'good', status: 'active', createdAt: new Date('2026-01-01T00:00:01Z').toISOString(),
      queued: true, queuedPrompt: 'GOOD_AFTER_TAIL',
    };
    store.set(failed.sessionId, failed);
    store.set(healthy.sessionId, healthy);
    vi.mocked(sessionStore.updateSession).mockImplementation((s: Session) => {
      if (s.sessionId === failed.sessionId) throw new Error('tail promotion save unavailable');
      store.set(s.sessionId, s);
    });

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();

    expect(active.has(sessionKey(CHAT, APP))).toBe(false);
    expect(failed.queuedActivationPending).toBeUndefined();
    expect(failed.queuedActivationTail?.[0]?.cliInput.content).toBe('TAIL_N');
    expect(active.get(sessionKey('oc_healthy_2', APP))?.session.sessionId).toBe(healthy.sessionId);
  });

  it('rolls back a failed terminal-empty cleanup and continues restoring later rows', async () => {
    const failed: Session = {
      sessionId: 'failed-terminal-cleanup', chatId: CHAT, rootMessageId: CHAT, scope: 'chat', larkAppId: APP,
      title: 'terminal', status: 'active', createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      cliId: 'codex-app', queuedActivationPending: true, queuedActivationToken: 'terminal-token',
      queuedActivationInput: { content: 'SETTLED_N' }, queuedActivationTurnId: 'terminal-turn',
    };
    const healthy: Session = {
      sessionId: 'healthy-after-terminal', chatId: 'oc_healthy_3', rootMessageId: 'oc_healthy_3', scope: 'chat', larkAppId: APP,
      title: 'good', status: 'active', createdAt: new Date('2026-01-01T00:00:01Z').toISOString(),
      queued: true, queuedPrompt: 'GOOD_AFTER_TERMINAL',
    };
    store.set(failed.sessionId, failed);
    store.set(healthy.sessionId, healthy);
    vi.mocked(sessionStore.updateSession).mockImplementation((s: Session) => {
      if (s.sessionId === failed.sessionId) throw new Error('terminal cleanup save unavailable');
      store.set(s.sessionId, s);
    });

    const active = new Map<string, DaemonSession>();
    await expect(restoreActiveSessions(active)).resolves.toBeUndefined();

    expect(active.has(sessionKey(CHAT, APP))).toBe(false);
    expect(failed).toMatchObject({
      queuedActivationPending: true,
      queuedActivationToken: 'terminal-token',
      queuedActivationInput: { content: 'SETTLED_N' },
    });
    expect(active.get(sessionKey('oc_healthy_3', APP))?.session.sessionId).toBe(healthy.sessionId);
  });
});

describe('spawnDashboardSession — in_progress starts immediately', () => {
  it('forks the worker with a botmux-wrapped prompt carrying the content; not queued', async () => {
    const active = new Map<string, DaemonSession>();
    const r = await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '立刻开干', column: 'in_progress', role: 'solo',
    });
    expect(r.ok).toBe(true);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [ds, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt).toMatchObject({ content: expect.stringContaining('立刻开干') });
    expect((ds as DaemonSession).session.queued).toBeFalsy();
  });

  it('lead in_progress wraps the prompt with the dispatch preamble', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '分配任务', column: 'in_progress', role: 'lead',
      coworkers: [{ name: 'Sub1', openId: 'ou_s1' }],
    });
    const [, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt).toMatchObject({
      content: expect.stringContaining('<botmux_lead_dispatch>'),
    });
    expect(prompt.content).toContain('Sub1');
  });

  it('unpublishes and closes only the new row when fork pre-accept throws', async () => {
    const active = new Map<string, DaemonSession>();
    forkWorkerMock.mockImplementationOnce(() => { throw new Error('spawn preaccept failed'); });

    await expect(spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'opening task', column: 'in_progress', role: 'solo',
    })).resolves.toEqual({ ok: false, error: 'spawn preaccept failed' });

    expect(active.has(sessionKey(CHAT, APP))).toBe(false);
    expect(sessionStore.closeSession).toHaveBeenCalledWith('sess-1');
  });

  it('unpublishes and closes only the new row when auto-worktree staging fails', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: {
        cliId: 'claude-code', defaultWorkingDir: '/tmp', defaultWorkingDirAutoWorktree: true,
      },
      botName: 'TestBot', botOpenId: 'ou_bot',
    } as any);
    vi.mocked(sessionStore.updateSession).mockImplementation((s: Session) => {
      if (s.pendingRepoSetup?.mode === 'auto_worktree') throw new Error('stage setup unavailable');
      store.set(s.sessionId, s);
    });
    const active = new Map<string, DaemonSession>();
    activeRegistryMock = active;

    await expect(spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'opening worktree task', column: 'in_progress', role: 'solo',
    })).resolves.toEqual({ ok: false, error: 'stage setup unavailable' });

    expect(active.has(sessionKey(CHAT, APP))).toBe(false);
    expect(sessionStore.closeSession).toHaveBeenCalledWith('sess-1');
    expect(runAutoWorktreeCommitMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });

  it('keeps a visible picker fail-closed when persisting its authoritative id fails', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', workingDir: '/tmp', defaultWorkingDir: undefined },
      botName: 'TestBot', botOpenId: 'ou_bot',
    } as any);
    scanMultipleProjectsMock.mockReturnValue([{ name: 'repo', path: '/tmp', type: 'repo', branch: 'main' }]);
    sendMessageMock.mockResolvedValueOnce('om_visible_picker');
    vi.mocked(sessionStore.updateSession).mockImplementation((s: Session) => {
      if (s.pendingRepoSetup?.repoCardMessageId === 'om_visible_picker') {
        throw new Error('picker id save unavailable');
      }
      store.set(s.sessionId, s);
    });
    const active = new Map<string, DaemonSession>();

    const result = await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'pick before start', column: 'in_progress', role: 'solo',
    });

    expect(result).toEqual({ ok: true, sessionId: 'sess-1' });
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds.pendingRepo).toBe(true);
    expect(ds.repoCardMessageId).toBe('om_visible_picker');
    expect(ds.session.pendingRepoSetup).toMatchObject({ mode: 'picker', prompt: expect.stringContaining('pick before start') });
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBeUndefined();
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.spawned',
    }));
  });

  it('retains a durable picker owner when publish fallback and fork both fail', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: { cliId: 'claude-code', workingDir: '/tmp', defaultWorkingDir: undefined },
      botName: 'TestBot', botOpenId: 'ou_bot',
    } as any);
    scanMultipleProjectsMock.mockReturnValue([{ name: 'repo', path: '/tmp', type: 'repo', branch: 'main' }]);
    sendMessageMock.mockRejectedValueOnce(new Error('picker publish unavailable'));
    forkWorkerMock.mockImplementationOnce(() => { throw new Error('fallback fork unavailable'); });
    const active = new Map<string, DaemonSession>();

    const result = await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'retain exact opening', column: 'in_progress', role: 'solo',
    });

    expect(result).toEqual({ ok: false, error: 'fallback fork unavailable' });
    const ds = active.get(sessionKey(CHAT, APP))!;
    expect(ds).toBeDefined();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toContain('retain exact opening');
    expect(ds.session).toMatchObject({
      status: 'active',
      queued: true,
      queuedPrompt: expect.stringContaining('retain exact opening'),
      pendingRepoSetup: {
        mode: 'picker',
        prompt: expect.stringContaining('retain exact opening'),
      },
    });
    expect(sessionStore.closeSession).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.spawned',
    }));
  });
});

describe('spawnDashboardSession — guards', () => {
  it('refuses to spawn over an existing real session at the same (chat, bot)', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, { larkAppId: APP, chatId: CHAT, content: 'a', column: 'backlog', role: 'solo' });
    const r2 = await spawnDashboardSession(active, undefined, { larkAppId: APP, chatId: CHAT, content: 'b', column: 'in_progress', role: 'solo' });
    expect(r2).toMatchObject({ ok: false, error: 'session_exists' });
  });

  it.each([
    ['pendingRepo', { pendingRepo: true }],
    ['initialStartPending', { initialStartPending: true }],
    ['worktreeCreating', { worktreeCreating: true }],
  ])('does not replace an existing %s opening reservation', async (_name, flags) => {
    const reserved = {
      session: { sessionId: 'reserved', status: 'active', queued: false },
      worker: null,
      larkAppId: APP,
      chatId: CHAT,
      scope: 'chat',
      ...flags,
    } as unknown as DaemonSession;
    const active = new Map([[sessionKey(CHAT, APP), reserved]]);

    const result = await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'must not replace', column: 'in_progress', role: 'solo',
    });

    expect(result).toEqual({ ok: false, error: 'session_exists' });
    expect(active.get(sessionKey(CHAT, APP))).toBe(reserved);
    expect(closeWorkerSessionMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });

  it('rechecks first-owner after banner preparation and preserves a concurrent reservation', async () => {
    const active = new Map<string, DaemonSession>();
    let bannerStarted!: () => void;
    let releaseBanner!: () => void;
    const started = new Promise<void>(resolve => { bannerStarted = resolve; });
    const paused = new Promise<void>(resolve => { releaseBanner = resolve; });
    sendMessageMock.mockImplementationOnce(async () => {
      bannerStarted();
      await paused;
      return 'om_delayed_banner';
    });

    const spawning = spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'late contender', column: 'in_progress', role: 'solo', postBanner: true,
    });
    await started;
    const incumbent = {
      session: { sessionId: 'concurrent-reservation', status: 'active', queued: false },
      worker: null,
      initialStartPending: true,
      larkAppId: APP,
      chatId: CHAT,
      scope: 'chat',
    } as unknown as DaemonSession;
    active.set(sessionKey(CHAT, APP), incumbent);
    releaseBanner();

    await expect(spawning).resolves.toEqual({ ok: false, error: 'session_exists' });
    expect(active.get(sessionKey(CHAT, APP))).toBe(incumbent);
    expect(closeWorkerSessionMock).not.toHaveBeenCalled();
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });
});

describe('activateQueuedSession', () => {
  it('consumes the wrapped queuedPrompt as the first turn, clears queued, moves to in_progress', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '排队的任务', column: 'backlog', role: 'lead',
      coworkers: [{ name: 'Helper' }],
    });
    const ds = active.get(sessionKey(CHAT, APP))!;
    forkWorkerMock.mockClear();

    const r = await activateQueuedSession(ds);
    expect(r.ok).toBe(true);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
    const [, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt).toMatchObject({ content: expect.stringContaining('排队的任务') });
    expect(prompt.content).toContain('<botmux_lead_dispatch>'); // preamble survived park→activate
    expect(ds.session.queued).toBe(false);
    // The worker-pool ACK handler, not activation acceptance, clears this
    // exact replay source after adapter submission.
    expect(ds.session.queuedPrompt).toContain('排队的任务');
    expect(ds.session.kanbanColumn).toBe('in_progress');
  });

  it('is a no-op error for a session that was never queued', async () => {
    const ds = { worker: null, session: { queued: false } } as unknown as DaemonSession;
    expect(await activateQueuedSession(ds)).toMatchObject({ ok: false, error: 'not_queued' });
  });

  it('keeps the backlog payload retryable when fork pre-accept throws', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: 'do not lose this task', column: 'backlog', role: 'solo',
    });
    activeRegistryMock = active;
    const ds = active.get(sessionKey(CHAT, APP))!;
    forkWorkerMock.mockImplementationOnce(() => { throw new Error('fork preaccept failed'); });

    const result = await activateQueuedSession(ds);

    expect(result).toEqual({ ok: false, error: 'fork preaccept failed' });
    expect(ds.session.queued).toBe(true);
    expect(ds.session.queuedPrompt).toContain('do not lose this task');
    expect(ds.pendingPrompt).toContain('do not lose this task');
    expect(ds.initialStartPending).toBe(false);
    expect(ds.pendingRepo).toBe(false);
  });

  it('returns success after worker ownership even when kanban metadata persistence fails', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP,
      chatId: CHAT,
      content: 'owned before metadata write',
      column: 'backlog',
      role: 'solo',
    });
    const ds = active.get(sessionKey(CHAT, APP))!;
    forkWorkerMock.mockImplementationOnce((owned: DaemonSession) => {
      owned.worker = { killed: false, send: vi.fn() } as any;
      owned.session.queuedActivationPending = true;
      owned.session.queuedActivationToken = 'activation-token';
    });
    vi.mocked(sessionStore.updateSession)
      .mockImplementationOnce((s: Session) => { store.set(s.sessionId, s); })
      .mockImplementationOnce(() => {
        throw new Error('kanban projection unavailable');
      });

    await expect(activateQueuedSession(ds)).resolves.toEqual({ ok: true });
    expect(forkWorkerMock).toHaveBeenCalledOnce();
    expect(ds.worker).toBeTruthy();
    expect(ds.session.queued).toBe(false);
    expect(ds.session.kanbanColumn).toBe('in_progress');
    expect(ds.session.queuedPrompt).toContain('owned before metadata write');
  });

  it('keeps the durable queued payload while an auto-worktree owns the pending fork', async () => {
    vi.mocked(getBot).mockReturnValue({
      config: {
        cliId: 'codex-app',
        cliPathOverride: undefined,
        defaultWorkingDir: '/tmp',
        defaultWorkingDirAutoWorktree: true,
        codexAppCleanInput: true,
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
    } as any);
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP,
      chatId: CHAT,
      content: 'survive pending worktree restart',
      column: 'backlog',
      role: 'solo',
    });
    activeRegistryMock = active;
    const ds = active.get(sessionKey(CHAT, APP))!;

    expect(await activateQueuedSession(ds)).toEqual({ ok: true });

    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(runAutoWorktreeCommitMock).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepo).toBe(true);
    expect(ds.session).toMatchObject({
      queued: true,
      queuedPrompt: expect.stringContaining('survive pending worktree restart'),
      queuedCodexAppText: 'survive pending worktree restart',
      kanbanColumn: 'in_progress',
    });

    // A repeated dashboard start is idempotent while the delayed commit owns
    // the attempt; it must not schedule a second worktree or picker.
    expect(await activateQueuedSession(ds)).toEqual({ ok: true });
    expect(runAutoWorktreeCommitMock).toHaveBeenCalledTimes(1);
  });
});

describe('executeScheduledTask — workerless owner semantics', () => {
  const ROOT = 'om_scheduler_owner';

  function task(): ScheduledTask {
    return {
      id: 'schedule-owner-test',
      name: 'owner test',
      schedule: 'once',
      parsed: { kind: 'once', at: '2026-01-01T00:00:00.000Z' },
      prompt: 'scheduled prompt',
      workingDir: '/tmp',
      chatId: CHAT,
      rootMessageId: ROOT,
      scope: 'thread',
      larkAppId: APP,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as ScheduledTask;
  }

  function owner(overrides: Partial<DaemonSession> & { session?: Partial<Session> } = {}): DaemonSession {
    const { session: sessionPatch, ...daemonPatch } = overrides;
    return {
      session: {
        sessionId: 'existing-owner', chatId: CHAT, rootMessageId: ROOT,
        status: 'active', scope: 'thread', createdAt: '2026-01-01T00:00:00.000Z',
        ...sessionPatch,
      } as Session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: APP,
      chatId: CHAT,
      chatType: 'group',
      scope: 'thread',
      spawnedAt: 1,
      cliVersion: 'test',
      lastMessageAt: 1,
      hasHistory: false,
      ...daemonPatch,
    } as DaemonSession;
  }

  beforeEach(() => {
    vi.mocked(getAllBots).mockReturnValue([{
      config: { larkAppId: APP, cliId: 'claude-code' },
      botName: 'TestBot', botOpenId: 'ou_bot', resolvedAllowedUsers: [],
    }] as any);
  });

  it.each([
    ['pending_repo', { pendingRepo: true }],
    ['initial_start_pending', { initialStartPending: true }],
    ['worktree_creating', { worktreeCreating: true }],
    ['queued_backlog', { session: { queued: true } }],
  ])('preserves a %s reservation instead of forking the scheduled prompt', async (state, patch) => {
    const ds = owner(patch as any);
    const active = new Map([[sessionKey(ROOT, APP), ds]]);

    await expect(executeScheduledTask(task(), active, vi.fn())).rejects.toThrow(state);

    expect(active.get(sessionKey(ROOT, APP))).toBe(ds);
    expect(forkWorkerMock).not.toHaveBeenCalled();
    expect(sendWorkerInputMock).not.toHaveBeenCalled();
    expect(closeWorkerSessionMock).not.toHaveBeenCalled();
  });

  it('reforks a cold real owner and keeps its history', async () => {
    const ds = owner({ session: { cliId: 'claude-code', lastCliInput: 'prior turn' }, hasHistory: true });
    const active = new Map([[sessionKey(ROOT, APP), ds]]);

    await executeScheduledTask(task(), active, vi.fn());

    expect(active.get(sessionKey(ROOT, APP))).toBe(ds);
    expect(forkWorkerMock).toHaveBeenCalledWith(ds, expect.anything(), expect.objectContaining({
      resume: true,
      turnId: expect.stringMatching(/^schedule:schedule-owner-test:/),
    }));
    expect(closeWorkerSessionMock).not.toHaveBeenCalled();
  });

  it('treats a persisted Riff task id as a cold real owner', async () => {
    const ds = owner({ session: { riffParentTaskId: 'riff-task-123' }, hasHistory: true });
    const active = new Map([[sessionKey(ROOT, APP), ds]]);

    await executeScheduledTask(task(), active, vi.fn());

    expect(active.get(sessionKey(ROOT, APP))).toBe(ds);
    expect(forkWorkerMock).toHaveBeenCalledWith(ds, expect.anything(), expect.objectContaining({
      resume: true,
      turnId: expect.stringMatching(/^schedule:schedule-owner-test:/),
    }));
    expect(closeWorkerSessionMock).not.toHaveBeenCalled();
  });

  it('retires a scratch owner and creates a fresh scheduled session', async () => {
    const scratch = owner();
    const active = new Map([[sessionKey(ROOT, APP), scratch]]);

    await executeScheduledTask(task(), active, vi.fn());

    expect(closeWorkerSessionMock).toHaveBeenCalledWith('existing-owner');
    expect(active.get(sessionKey(ROOT, APP))).not.toBe(scratch);
    expect(forkWorkerMock).toHaveBeenCalledTimes(1);
  });

  it('does not delete an owner when explicit close reports retryable cleanup failure', async () => {
    const scratch = owner();
    const active = new Map([[sessionKey(ROOT, APP), scratch]]);
    closeWorkerSessionMock.mockResolvedValueOnce({
      ok: false, alreadyClosed: false, error: 'riff_cancel_failed', retryable: true, taskId: 'task-1',
    });

    await expect(executeScheduledTask(task(), active, vi.fn()))
      .rejects.toThrow('riff_cancel_failed');

    expect(active.get(sessionKey(ROOT, APP))).toBe(scratch);
    expect(forkWorkerMock).not.toHaveBeenCalled();
  });

  it('retains a fresh-session reservation and opening prompt when fork pre-accept throws', async () => {
    const active = new Map<string, DaemonSession>();
    forkWorkerMock.mockImplementationOnce(() => { throw new Error('scheduler fork failed'); });

    await expect(executeScheduledTask(task(), active, vi.fn())).rejects.toThrow('scheduler fork failed');

    const ds = active.get(sessionKey(ROOT, APP));
    expect(ds?.initialStartPending).toBe(true);
    expect(ds?.pendingPrompt).toBe('scheduled prompt');
    expect(ds?.worker).toBeNull();
  });
});
