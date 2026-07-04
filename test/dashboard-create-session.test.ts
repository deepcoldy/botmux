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
vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: (...a: any[]) => sendMessageMock(...a),
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(async () => []),
  getChatMode: vi.fn(),
  replyMessage: vi.fn(),
  UserTokenMissingError: class extends Error {},
}));

const forkWorkerMock = vi.fn();
vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: (...a: any[]) => forkWorkerMock(...a),
  forkAdoptWorker: vi.fn(),
  killStalePids: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test-cli-v1'),
  restoreUsageLimitRuntimeState: vi.fn(),
  setActiveSessionSafe: vi.fn(async (map: Map<string, any>, k: string, ds: any) => { map.set(k, ds); }),
  isRelayableRealSession: vi.fn(() => false),
  closeSession: vi.fn(),
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
vi.mock('../src/core/role-resolver.js', () => ({ resolveRole: vi.fn(() => ({ content: null, source: undefined })) }));
vi.mock('../src/services/whiteboard-store.js', () => ({
  whiteboardEnabled: vi.fn(() => false),
  getWhiteboard: vi.fn(),
  ensureDefaultWhiteboard: vi.fn(),
}));

import { spawnDashboardSession, activateQueuedSession } from '../src/core/session-manager.js';
import { sessionKey } from '../src/core/types.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';

const APP = 'cli_app_test';
const CHAT = 'oc_newgroup';

beforeEach(() => {
  store.clear();
  sessionSeq = 0;
  forkWorkerMock.mockClear();
  sendMessageMock.mockClear();
  (dashboardEventBus.publish as any).mockClear();
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
    expect(prompt).toContain('立刻开干');
    expect((ds as DaemonSession).session.queued).toBeFalsy();
  });

  it('lead in_progress wraps the prompt with the dispatch preamble', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, {
      larkAppId: APP, chatId: CHAT, content: '分配任务', column: 'in_progress', role: 'lead',
      coworkers: [{ name: 'Sub1', openId: 'ou_s1' }],
    });
    const [, prompt] = forkWorkerMock.mock.calls[0];
    expect(prompt).toContain('<botmux_lead_dispatch>');
    expect(prompt).toContain('Sub1');
  });
});

describe('spawnDashboardSession — guards', () => {
  it('refuses to spawn over an existing real session at the same (chat, bot)', async () => {
    const active = new Map<string, DaemonSession>();
    await spawnDashboardSession(active, undefined, { larkAppId: APP, chatId: CHAT, content: 'a', column: 'backlog', role: 'solo' });
    const r2 = await spawnDashboardSession(active, undefined, { larkAppId: APP, chatId: CHAT, content: 'b', column: 'in_progress', role: 'solo' });
    expect(r2).toMatchObject({ ok: false, error: 'session_exists' });
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
    expect(prompt).toContain('排队的任务');
    expect(prompt).toContain('<botmux_lead_dispatch>'); // preamble survived park→activate
    expect(ds.session.queued).toBe(false);
    expect(ds.session.queuedPrompt).toBeUndefined();
    expect(ds.session.kanbanColumn).toBe('in_progress');
  });

  it('is a no-op error for a session that was never queued', async () => {
    const ds = { worker: null, session: { queued: false } } as unknown as DaemonSession;
    expect(await activateQueuedSession(ds)).toMatchObject({ ok: false, error: 'not_queued' });
  });
});
