/**
 * working-dir-recovery: what the chat is told when forkWorker refuses to start
 * a session whose working directory is gone.
 *
 * Run: bun x vitest run --project unit test/working-dir-recovery.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/session-manager.js', () => ({
  getProjectScanDirs: vi.fn(() => ['/repos']),
  getSessionWorkingDir: vi.fn((ds: any) => ds?.workingDir ?? '/tmp'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app_test', cliId: 'pi' } })),
}));

vi.mock('../src/services/git-worktree.js', () => ({
  resolveDeletedWorktreeOrigin: vi.fn(),
}));

vi.mock('../src/services/project-scanner.js', () => ({
  scanMultipleProjects: vi.fn(() => []),
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn((p: string) => p === '/repos' || actual.existsSync(p)) };
});

import {
  onlyUnstartedOpeningHolds,
  publishWorkingDirRecovery,
  workingDirRecoveryPending,
} from '../src/core/working-dir-recovery.js';
import { resolveDeletedWorktreeOrigin } from '../src/services/git-worktree.js';
import { scanMultipleProjects } from '../src/services/project-scanner.js';
import type { DaemonSession } from '../src/core/types.js';

const GONE = '/root/iserver/botmux-wt-botmux-claude-review-pr-1809-cd';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: { sessionId: 'sid-recovery', rootMessageId: 'om_root', chatId: 'oc_chat', status: 'active' },
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    larkAppId: 'app_test',
    worker: null,
    workingDir: GONE,
    ...overrides,
  } as unknown as DaemonSession;
}

function makeDeps() {
  const sessionReply = vi.fn(async (_root: string, _content: string, msgType?: string) =>
    msgType === 'interactive' ? 'om_recovery_card' : 'om_text');
  return { deps: { sessionReply, lastRepoScan: new Map() }, sessionReply };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveDeletedWorktreeOrigin).mockResolvedValue({ repo: '/root/iserver/botmux', branch: 'wt/botmux-claude-review-pr-1809-cd' });
  vi.mocked(scanMultipleProjects).mockReturnValue([
    { name: 'botmux', path: '/root/iserver/botmux', type: 'repo', branch: 'master' },
  ]);
});

describe('publishWorkingDirRecovery', () => {
  it('publishes the repo picker in recovery form and makes it the live repo card', async () => {
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_turn' });

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const [anchor, card, msgType, appId, turnId] = sessionReply.mock.calls[0]!;
    expect([anchor, msgType, appId, turnId]).toEqual(['om_root', 'interactive', 'app_test', 'om_turn']);
    expect(card).toContain('工作目录已不存在');
    expect(card).toContain(GONE);
    expect(card).toContain('"action":"repo_rebuild_worktree"');
    expect(card).toContain('wt/botmux-claude-review-pr-1809-cd');
    expect(card).toContain('"key":"repo_switch"');
    expect(card).not.toContain('skip_repo');
    expect(ds.repoCardMessageId).toBe('om_recovery_card');
    expect(ds.workingDirRecovery).toEqual({
      path: GONE,
      cardMessageId: 'om_recovery_card',
      rebuild: { repo: '/root/iserver/botmux', branch: 'wt/botmux-claude-review-pr-1809-cd' },
    });
    expect(deps.lastRepoScan.get('oc_chat')).toHaveLength(1);
    expect(workingDirRecoveryPending(ds)).toBe(true);
  });

  it('does not repeat the card: a human message gets one line, a system start nothing', async () => {
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();
    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_first' });
    sessionReply.mockClear();

    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_second' });
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls[0]![1]).toContain('仍不存在');
    expect(sessionReply.mock.calls[0]![2]).toBe('text');

    sessionReply.mockClear();
    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'schedule:abc:123' });
    await publishWorkingDirRecovery(ds, GONE, deps, {});
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('`force` (bare /repo) publishes the card again', async () => {
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();
    await publishWorkingDirRecovery(ds, GONE, deps);
    sessionReply.mockClear();

    await publishWorkingDirRecovery(ds, GONE, deps, { force: true });

    expect(sessionReply).toHaveBeenCalledWith('om_root', expect.stringContaining('repo_rebuild_worktree'), 'interactive', 'app_test', undefined, expect.anything());
  });

  it('falls back to text when the card cannot be sent, and retries the card next time', async () => {
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();
    sessionReply.mockImplementationOnce(async () => { throw new Error('230025 card too long'); });

    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_turn' });

    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(sessionReply.mock.calls[1]![1]).toContain('/cd <路径>');
    expect(ds.workingDirRecovery).toBeUndefined();
    expect(ds.repoCardMessageId).toBeUndefined();

    sessionReply.mockClear();
    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_turn_2' });
    expect(sessionReply.mock.calls[0]![2]).toBe('interactive');
  });

  it('offers no rebuild button when git cannot say where the worktree came from', async () => {
    vi.mocked(resolveDeletedWorktreeOrigin).mockResolvedValue(null);
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps);

    const card = sessionReply.mock.calls[0]![1];
    expect(card).not.toContain('repo_rebuild_worktree');
    expect(card).toContain('无法自动重建');
    expect(ds.workingDirRecovery?.rebuild).toBeUndefined();
  });

  it('still renders (manual entry only) when the scan finds nothing', async () => {
    vi.mocked(scanMultipleProjects).mockReturnValue([]);
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps);

    const card = sessionReply.mock.calls[0]![1];
    expect(card).not.toContain('select_static');
    expect(card).toContain('repo_manual_submit');
    expect(card).toContain('repo_rebuild_worktree');
  });

  it('sends nothing for a headless (HTTP API) session — its caller gets the error', async () => {
    const ds = makeDs({ chatId: 'headless_abc' } as any);
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps, { turnId: 'om_turn' });

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('is no longer pending once the session points somewhere else', async () => {
    const ds = makeDs();
    const { deps } = makeDeps();
    await publishWorkingDirRecovery(ds, GONE, deps);
    ds.workingDir = '/repos';
    expect(workingDirRecoveryPending(ds)).toBe(false);
  });
});

describe('a session whose first message has not started', () => {
  // The opening is staged for repo selection: choosing a directory starts it,
  // so the card asks for a directory instead of a resend.
  const OPENING = 'first message';
  function makeOpeningDs(overrides: Partial<DaemonSession> = {}, sessionOverrides: Record<string, unknown> = {}): DaemonSession {
    const ds = makeDs({ pendingRepo: true, ...overrides });
    Object.assign(ds.session, {
      queued: true,
      queuedPrompt: OPENING,
      pendingRepoSetup: { mode: 'picker', linkRefMode: 'disabled', prompt: OPENING, turnId: 'om_opening' },
      ...sessionOverrides,
    });
    return ds;
  }

  it('publishes the picker for that message and makes it the setup\'s picker', async () => {
    const ds = makeOpeningDs();
    const { deps, sessionReply } = makeDeps();

    const messageId = await publishWorkingDirRecovery(ds, GONE, deps);

    expect(messageId).toBe('om_recovery_card');
    const card = sessionReply.mock.calls[0]![1];
    expect(card).toContain('还没有开始处理');
    expect(card).toContain('不用重发');
    expect(card).not.toContain('重发消息即可继续');
    expect(card).not.toContain('skip_repo');
    expect(card).toContain('repo_rebuild_worktree');
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBe('om_recovery_card');
  });

  it('a refused start that left the picker gets the same form', async () => {
    const ds = makeOpeningDs({ pendingRepo: false, initialStartPending: true });
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps);

    expect(sessionReply.mock.calls[0]![1]).toContain('不用重发');
    expect(ds.session.pendingRepoSetup?.repoCardMessageId).toBe('om_recovery_card');
  });

  it('without a card, says the message is kept and /repo picks the directory', async () => {
    const ds = makeOpeningDs();
    const { deps, sessionReply } = makeDeps();
    sessionReply.mockImplementationOnce(async () => { throw new Error('230025 card too long'); });

    expect(await publishWorkingDirRecovery(ds, GONE, deps)).toBeUndefined();

    const text = sessionReply.mock.calls[1]![1];
    expect(text).toContain('还没有开始处理');
    expect(text).toContain('/repo');
    expect(text).not.toContain('/cd');
  });

  it('an ordinary session (it has a conversation) keeps the resend form', async () => {
    const ds = makeDs();
    const { deps, sessionReply } = makeDeps();

    await publishWorkingDirRecovery(ds, GONE, deps);

    expect(sessionReply.mock.calls[0]![1]).toContain('重发消息即可继续');
    expect(sessionReply.mock.calls[0]![1]).not.toContain('不用重发');
  });
});

describe('onlyUnstartedOpeningHolds', () => {
  function refusedOpening(sessionOverrides: Record<string, unknown> = {}, overrides: Partial<DaemonSession> = {}): DaemonSession {
    const ds = makeDs({ pendingRepo: false, initialStartPending: true, ...overrides });
    Object.assign(ds.session, {
      queued: true,
      pendingRepoSetup: { mode: 'picker', linkRefMode: 'disabled', prompt: 'first', turnId: 'om_opening' },
      ...sessionOverrides,
    });
    return ds;
  }

  it('holds for a refused staged opening, with or without messages queued behind it', () => {
    expect(onlyUnstartedOpeningHolds(refusedOpening())).toBe(true);
    expect(onlyUnstartedOpeningHolds(refusedOpening({ queuedActivationTail: [{ userPrompt: 'next', turnId: 'om_next' }] }))).toBe(true);
  });

  it('does not hold once other work is unsettled or the session is not in that state', () => {
    expect(onlyUnstartedOpeningHolds(refusedOpening({ queuedActivationPending: true }))).toBe(false);
    expect(onlyUnstartedOpeningHolds(refusedOpening({ principalLaneQueuedTurns: [{ turnId: 'om_lane' }] }))).toBe(false);
    expect(onlyUnstartedOpeningHolds(refusedOpening({
      codexAppDispatchLedger: [{ dispatchId: 'd1', turnId: 'om_x', state: 'accepted' }],
    }))).toBe(false);
    expect(onlyUnstartedOpeningHolds(refusedOpening({ pendingRepoSetup: undefined }))).toBe(false);
    expect(onlyUnstartedOpeningHolds(refusedOpening({}, { pendingRepo: true }))).toBe(false);
    expect(onlyUnstartedOpeningHolds(refusedOpening({}, { worker: { killed: false } as any }))).toBe(false);
  });
});
