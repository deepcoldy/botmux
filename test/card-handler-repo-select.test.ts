/**
 * Unit tests for the repo-select card dropdowns in card-handler:
 *
 *   1. pendingRepo + plain selection  → CLI forked with the buffered prompt
 *   2. mid-session plain selection    → close old session, fresh session + fork
 *   3. repo_worktree double click     → one background creation, one commit
 *   4. repo_worktree vs. concurrent plain selection (generation guard)
 *      → worktree is NOT committed once the session moved on
 *
 * Run:  pnpm vitest run test/card-handler-repo-select.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks (before importing the module under test) ───────────────────────

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  sendEphemeralCard: vi.fn(async () => 'om_eph'),
  getMessageDetail: vi.fn(),
  isHumanOpenId: vi.fn(() => true),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  getBotClient: vi.fn(),
}));

vi.mock('../src/services/bot-config-store.js', () => ({
  findConfigField: vi.fn((key: string) => key === 'worktreeMultiPicker'
    ? { key, configKey: 'worktreeMultiPicker', kind: 'boolean', effect: 'immediate', clearable: false }
    : undefined),
  applyConfigField: vi.fn(async () => ({ ok: true, newText: 'on' })),
  coerceConfigValue: vi.fn(),
  getConfigCardData: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: vi.fn(),
  killWorker: vi.fn(),
  scheduleCardPatch: vi.fn(),
  parkStreamCard: vi.fn(),
  clearUsageLimitState: vi.fn(),
  cardUsageLimit: vi.fn(() => undefined),
  writableTerminalLinkFor: vi.fn(() => 'http://term'),
  resolvePrivateCardAudience: vi.fn(() => []),
  deliverWriteLinkCard: vi.fn(),
  deliverEphemeralOrReply: vi.fn(),
  CARD_POSTING_SENTINEL: '__posting__',
}));

vi.mock('../src/core/session-manager.js', () => ({
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  ensureSessionWhiteboard: vi.fn(),
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  getAvailableBots: vi.fn(async () => []),
  persistStreamCardState: vi.fn(),
  resumeSession: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/im/lark/event-dispatcher.js', () => ({
  canOperate: vi.fn(() => true),
  canTalk: vi.fn(() => true),
}));

vi.mock('../src/core/session-activity.js', () => ({
  publishAttentionPatch: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/services/git-worktree.js', () => ({
  createRepoWorktree: vi.fn(),
  removeRepoWorktree: vi.fn(async () => {}),
  dirSuffixForBranch: (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'branch',
}));

vi.mock('../src/services/worktree-slug-ai.js', () => ({
  worktreeSlugFromContextAI: vi.fn(async (title?: string, firstPrompt?: string) => {
    const text = title?.trim() || firstPrompt?.trim();
    return text?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import { forkWorker, killWorker, deliverEphemeralOrReply } from '../src/core/worker-pool.js';
import { getAvailableBots } from '../src/core/session-manager.js';
import { createSession, closeSession } from '../src/services/session-store.js';
import { createRepoWorktree, removeRepoWorktree } from '../src/services/git-worktree.js';
import { applyConfigField } from '../src/services/bot-config-store.js';
import { deleteMessage } from '../src/im/lark/client.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ProjectInfo } from '../src/services/project-scanner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// ─── Helpers ──────────────────────────────────────────────────────────────

const APP_ID = 'app_test';
const ROOT_ID = 'om_root_repo';
const CHAT_ID = 'oc_chat';
const OWNER = 'ou_owner';

const PROJECTS: ProjectInfo[] = [
  { name: 'alpha', path: '/repos/alpha', type: 'repo', branch: 'master' },
  { name: 'beta', path: '/repos/beta', type: 'repo', branch: 'main' },
];

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'uuid-old',
      chatId: CHAT_ID,
      rootMessageId: ROOT_ID,
      title: 'repo test',
      status: 'active',
      createdAt: new Date().toISOString(),
      ownerOpenId: OWNER,
    },
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    larkAppId: APP_ID,
    worker: { killed: false, send: vi.fn() },
    workerPort: 8080,
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    ...overrides,
  } as unknown as DaemonSession;
}

function makeDeps(ds: DaemonSession, projects = PROJECTS) {
  const activeSessions = new Map([[sessionKey(ROOT_ID, APP_ID), ds]]);
  const sessionReply = vi.fn(async () => 'om_reply');
  const deps: CardHandlerDeps = { activeSessions, sessionReply, lastRepoScan: new Map([[CHAT_ID, projects]]) };
  return { deps, sessionReply };
}

function makeSelectEvent(key: 'repo_switch' | 'repo_worktree', path: string) {
  return {
    operator: { open_id: OWNER },
    action: { option: path, value: { key, root_id: ROOT_ID } },
    context: { open_message_id: 'om_card' },
  };
}

function makeManualEvent(path: string, operator = OWNER) {
  return {
    operator: { open_id: operator },
    action: {
      value: { action: 'repo_manual_submit', root_id: ROOT_ID },
      form_value: { repo_manual_path: path },
    },
    context: { open_message_id: 'om_card' },
  };
}

function makeWorktreeSubmitEvent(branch = '', paths?: string[], operator = OWNER) {
  return {
    operator: { open_id: operator },
    action: {
      value: { action: 'repo_worktree_submit', root_id: ROOT_ID },
      form_value: {
        repo_worktree_branch: branch,
        ...(paths ? { repo_worktree_paths: paths } : {}),
      },
    },
    context: { open_message_id: 'om_card' },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  let n = 0;
  vi.mocked(createSession).mockImplementation((chatId: string, rootId: string, title: string, chatType?: string) => ({
    sessionId: `uuid-new-${++n}`,
    chatId,
    rootMessageId: rootId,
    title,
    status: 'active',
    createdAt: new Date().toISOString(),
    chatType,
  }) as any);
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('repo select card — plain switch', () => {
  it('pendingRepo selection forks the CLI with the buffered prompt', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hello world', worker: null });
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDir).toBe('/repos/alpha');
    expect(ds.session.workingDir).toBe('/repos/alpha');
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(forkWorker).mock.calls[0]![1]).toBe('mock-prompt');
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('已选择');
    expect(killWorker).not.toHaveBeenCalled();
    // First-spawn (pendingRepo) closes nothing, so no "session closed" card.
    expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
  });

  it('mid-session selection closes the old session and forks a fresh one', async () => {
    const ds = makeDs(); // no pendingRepo
    ds.session.workingDir = '/repos/gamma'; // old session's actual repo
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);

    expect(killWorker).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('uuid-old');
    expect(ds.session.sessionId).toMatch(/^uuid-new-/);
    expect(ds.workingDir).toBe('/repos/beta');
    expect(ds.session.workingDir).toBe('/repos/beta');
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(forkWorker).mock.calls[0]![1]).toBe('');
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('已切换');
    // The displaced session gets a "session closed" card (Option C safety net)
    // so its context stays visible/recoverable instead of vanishing silently.
    expect(deliverEphemeralOrReply).toHaveBeenCalledTimes(1);
    const closedCard = vi.mocked(deliverEphemeralOrReply).mock.calls[0]![2] as string;
    expect(closedCard).toContain('uuid-old');
    // Regression guard: the closed card must carry the OLD session's repo, NOT
    // the switch target — otherwise `claude --resume` reopens it in the wrong cwd.
    expect(closedCard).toContain('gamma');
    expect(closedCard).not.toContain('beta');
  });
});

describe('repo select card — worktree open', () => {
  it('double click starts ONE background creation and commits once', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    const d = deferred<{ path: string; branch: string; baseRef: string }>();
    vi.mocked(createRepoWorktree).mockReturnValue(d.promise as any);

    const first = await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    const second = await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);

    expect(createRepoWorktree).toHaveBeenCalledTimes(1);
    expect(createRepoWorktree).toHaveBeenCalledWith('/repos/alpha', { slug: 'repo-test' });
    expect(first?.toast?.content).toContain('正在创建');
    expect(second?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(ds.worktreeCreating).toBe(true);

    d.resolve({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/alpha-wt-1');
    expect(ds.session.workingDir).toBe('/repos/alpha-wt-1');
    expect(ds.pendingRepo).toBe(false);
    const replies = sessionReply.mock.calls.map(c => c[1]).join();
    expect(replies).toContain('worktree 已创建');
    // The redundant "已选择" confirmation is suppressed in the worktree flow —
    // the "worktree 已创建：…" line above is the single message the user sees.
    expect(replies).not.toContain('已选择');
  });

  it('blocks a plain switch while git runs — and does NOT commit when the session moved on out-of-band', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    const d = deferred<{ path: string; branch: string; baseRef: string }>();
    vi.mocked(createRepoWorktree).mockReturnValue(d.promise as any);

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    // While git runs, a plain repo pick bounces off the worktree lock…
    const res = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(res?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(forkWorker).not.toHaveBeenCalled();
    // …but a non-repo path (e.g. /close + respawn) can still replace the
    // session — the generation guard must catch that.
    ds.session = { ...ds.session, sessionId: 'replaced-out-of-band' };
    ds.pendingRepo = false;

    d.resolve({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    // Generation guard: no fork, no kill, workingDir untouched.
    expect(forkWorker).not.toHaveBeenCalled();
    expect(killWorker).not.toHaveBeenCalled();
    expect(ds.workingDir).toBeUndefined();
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('未自动切换');
  });

  it('re-checks the generation AFTER the created notice — a plain switch landing during the reply wins', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    // The created notice is a Lark round-trip; a plain selection (NOT gated by
    // worktreeCreating) can consume pendingRepo in that window. Simulate it
    // from inside the reply itself.
    vi.mocked(deps.sessionReply).mockImplementation(async (_root, text) => {
      if (typeof text === 'string' && text.includes('worktree 已创建：') && ds.pendingRepo) ds.pendingRepo = false;
      return 'om_reply';
    });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    // The post-reply guard must catch the swap: no fork, no kill, no switch.
    expect(forkWorker).not.toHaveBeenCalled();
    expect(killWorker).not.toHaveBeenCalled();
    expect(ds.workingDir).toBeUndefined();
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('未自动切换');
  });

  it('blocks a plain switch while the worktree commit is preparing the prompt (post-guard window)', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    // Park the worktree commit inside prompt prep — AFTER its final generation
    // check. This is the window where an ungated plain switch used to
    // double-fork (close the session, then the worktree fork resumes on top).
    let releaseBots: (() => void) | undefined;
    vi.mocked(getAvailableBots).mockImplementationOnce(() => new Promise(res => { releaseBots = () => res([]); }));

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(releaseBots).toBeTruthy());

    // The plain switch must bounce off the lock instead of interleaving.
    const res = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(res?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(killWorker).not.toHaveBeenCalled();

    releaseBots!();
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/alpha-wt-1');
  });

  it('aborts the pending fork when the session is replaced during prompt prep (last-line defence)', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    // A non-repo interleaver (e.g. /close + respawn) swaps the session while
    // prompt prep awaits — the repo lock can't see it, the final check must.
    vi.mocked(getAvailableBots).mockImplementationOnce(async () => {
      ds.session = { ...ds.session, sessionId: 'replaced-mid-prep' };
      return [];
    });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('does NOT switch when the session is /close\'d while git runs (identity guard)', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    const d = deferred<{ path: string; branch: string; baseRef: string }>();
    vi.mocked(createRepoWorktree).mockReturnValue(d.promise as any);

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    // /close deletes the active-map entry but mutates neither sessionId nor
    // pendingRepo — identity against the map is the only tell.
    deps.activeSessions.delete(sessionKey(ROOT_ID, APP_ID));

    d.resolve({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).not.toHaveBeenCalled();
    expect(killWorker).not.toHaveBeenCalled();
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('未自动切换');
  });

  it('aborts the pending fork when the session is /close\'d during prompt prep (last-line defence)', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    // The close lands inside commitSelection's prompt prep — past every
    // earlier guard; only the pre-fork identity check can stop the fork.
    vi.mocked(getAvailableBots).mockImplementationOnce(async () => {
      deps.activeSessions.delete(sessionKey(ROOT_ID, APP_ID));
      return [];
    });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).not.toHaveBeenCalled();
  });

  it('reports a switch failure as such — the worktree DOES exist on disk', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-wt-1', branch: 'wt/1', baseRef: 'origin/master' });
    vi.mocked(forkWorker).mockImplementationOnce(() => { throw new Error('fork boom'); });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    const replies = sessionReply.mock.calls.map(c => c[1]).join();
    expect(replies).toContain('自动切换失败');
    expect(replies).toContain('fork boom');
    // NOT a creation failure — retrying as one would trip "already exists".
    expect(replies).not.toContain('创建 worktree 失败');
  });

  it('creation failure replies an error and releases the in-flight lock', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockRejectedValue(new Error('fetch blew up'));

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true); // still recoverable — card stays
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('fetch blew up');
  });

  it('multi-select creates all selected repos under one parent path and opens that parent', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/feat-multi/alpha', branch: 'feat/multi', baseRef: 'origin/master' })
      .mockResolvedValueOnce({ path: '/repos/feat-multi/beta', branch: 'feat/multi', baseRef: 'origin/master' });

    const res = await handleCardAction(makeWorktreeSubmitEvent('feat/multi', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    expect(res?.toast?.content).toContain('正在创建');
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(createRepoWorktree).toHaveBeenCalledTimes(2);
    expect(createRepoWorktree).toHaveBeenNthCalledWith(1, '/repos/alpha', {
      branch: 'feat/multi',
      slug: undefined,
      worktreePath: '/repos/feat-multi/alpha',
    });
    expect(createRepoWorktree).toHaveBeenNthCalledWith(2, '/repos/beta', {
      branch: 'feat/multi',
      slug: undefined,
      worktreePath: '/repos/feat-multi/beta',
    });
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/feat-multi');
    expect(ds.session.workingDir).toBe('/repos/feat-multi');
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('worktree 已创建');
  });

  it('reads official form multi-select values from action.form_value and creates all selected repos', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/feat-selected/alpha', branch: 'feat/selected', baseRef: 'origin/master' })
      .mockResolvedValueOnce({ path: '/repos/feat-selected/beta', branch: 'feat/selected', baseRef: 'origin/master' });

    await handleCardAction(makeWorktreeSubmitEvent('feat/selected', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(createRepoWorktree).toHaveBeenCalledTimes(2);
    expect(createRepoWorktree).toHaveBeenNthCalledWith(1, '/repos/alpha', {
      branch: 'feat/selected',
      slug: undefined,
      worktreePath: '/repos/feat-selected/alpha',
    });
    expect(createRepoWorktree).toHaveBeenNthCalledWith(2, '/repos/beta', {
      branch: 'feat/selected',
      slug: undefined,
      worktreePath: '/repos/feat-selected/beta',
    });
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/feat-selected');
  });

  it('multi-select without explicit branch uses the default slug parent and child naming', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/repo-test/alpha', branch: 'repo-test', baseRef: 'origin/master' })
      .mockResolvedValueOnce({ path: '/repos/repo-test/beta', branch: 'repo-test', baseRef: 'origin/master' });

    const res = await handleCardAction(makeWorktreeSubmitEvent('', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    expect(res?.toast?.content).toContain('正在创建');
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(createRepoWorktree).toHaveBeenCalledTimes(2);
    expect(createRepoWorktree).toHaveBeenNthCalledWith(1, '/repos/alpha', {
      branch: undefined,
      slug: 'repo-test',
      worktreePath: '/repos/repo-test/alpha',
    });
    expect(createRepoWorktree).toHaveBeenNthCalledWith(2, '/repos/beta', {
      branch: undefined,
      slug: 'repo-test',
      worktreePath: '/repos/repo-test/beta',
    });
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/repo-test');
  });

  it('rejects empty repo_worktree_paths from the official form value', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);

    const res = await handleCardAction(makeWorktreeSubmitEvent('feat/empty', []), deps, APP_ID);

    expect(res?.toast?.type).toBe('error');
    expect(res?.toast?.content).toContain('至少选择一个仓库');
    expect(createRepoWorktree).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.worktreeCreating).not.toBe(true);
  });

  it('rejects missing repo_worktree_paths and does not fall back to standalone multi-select options', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    const event = {
      operator: { open_id: OWNER },
      action: {
        value: { action: 'repo_worktree_submit', root_id: ROOT_ID },
        form_value: { repo_worktree_branch: 'feat/missing' },
        options: ['/repos/alpha', '/repos/beta'],
      },
      context: { open_message_id: 'om_card' },
    };

    const res = await handleCardAction(event, deps, APP_ID);

    expect(res?.toast?.type).toBe('error');
    expect(res?.toast?.content).toContain('至少选择一个仓库');
    expect(createRepoWorktree).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.worktreeCreating).not.toBe(true);
  });

  it('rejects multi-select repos that map to the same child directory before creating worktrees', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const duplicateProjects: ProjectInfo[] = [
      { name: 'same', path: '/repos/team-a/same', type: 'repo', branch: 'master' },
      { name: 'same', path: '/repos/team-b/same', type: 'repo', branch: 'main' },
    ];
    const { deps } = makeDeps(ds, duplicateProjects);

    const res = await handleCardAction(makeWorktreeSubmitEvent('feat/collision', ['/repos/team-a/same', '/repos/team-b/same']), deps, APP_ID);

    expect(res?.toast?.type).toBe('error');
    expect(res?.toast?.content).toContain('相同 worktree 子目录');
    expect(res?.toast?.content).toContain('same');
    expect(createRepoWorktree).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.worktreeCreating).not.toBe(true);
  });

  it('single selection from the new form keeps the existing single-repo path convention and passes branch', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree).mockResolvedValue({ path: '/repos/alpha-feat-one', branch: 'feat/one', baseRef: 'origin/master' });

    await handleCardAction(makeWorktreeSubmitEvent('feat/one', ['/repos/alpha']), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(createRepoWorktree).toHaveBeenCalledWith('/repos/alpha', {
      branch: 'feat/one',
      slug: undefined,
      worktreePath: undefined,
    });
    expect(ds.workingDir).toBe('/repos/alpha-feat-one');
  });

  it('worktree_toggle_mode flips the persisted picker mode and re-sends a fresh repo card', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null, repoCardMessageId: 'om_old_card' });
    const { deps, sessionReply } = makeDeps(ds);
    const event = {
      operator: { open_id: OWNER },
      action: { value: { action: 'worktree_toggle_mode', root_id: ROOT_ID } },
      context: { open_message_id: 'om_card' },
    };

    const res = await handleCardAction(event, deps, APP_ID);

    expect(res?.toast?.type).toBe('info');
    // persisted the flipped mode (config undefined → true)
    expect(vi.mocked(applyConfigField)).toHaveBeenCalledWith('app_test', expect.objectContaining({ configKey: 'worktreeMultiPicker' }), true);
    // withdrew the old card and posted a fresh interactive repo card
    expect(vi.mocked(deleteMessage)).toHaveBeenCalledWith('app_test', 'om_old_card');
    const interactiveCall = sessionReply.mock.calls.find(c => c[2] === 'interactive');
    expect(interactiveCall).toBeDefined();
    expect(createRepoWorktree).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.worktreeCreating).not.toBe(true);
  });

  it('rolls back already-created worktrees when a later repo in the batch fails', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps, sessionReply } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/feat-multi/alpha', branch: 'feat/multi', baseRef: 'origin/master' })
      .mockRejectedValueOnce(new Error('boom on beta'));

    await handleCardAction(makeWorktreeSubmitEvent('feat/multi', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(createRepoWorktree).toHaveBeenCalledTimes(2);
    // the first repo's worktree (already on disk) is rolled back, not leaked
    expect(removeRepoWorktree).toHaveBeenCalledTimes(1);
    expect(removeRepoWorktree).toHaveBeenCalledWith('/repos/alpha', '/repos/feat-multi/alpha');
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true); // still recoverable — card stays
    const replies = sessionReply.mock.calls.map(c => c[1]).join();
    expect(replies).toContain('回滚');
    expect(replies).toContain('boom on beta');
  });
});

describe('repo select card — manual directory entry', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'botmux-manual-repo-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('pendingRepo manual submit forks the CLI in the typed directory', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'queued task', worker: null });
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeManualEvent(tmpDir), deps, APP_ID);

    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDir).toBe(tmpDir);
    expect(ds.session.workingDir).toBe(tmpDir);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(forkWorker).mock.calls[0]![1]).toBe('mock-prompt');
    const reply = sessionReply.mock.calls.map(c => c[1]).join();
    expect(reply).toContain('已选择');
    expect(reply).toContain(basename(tmpDir));
    expect(killWorker).not.toHaveBeenCalled();
  });

  it('mid-session manual submit closes the old session and forks a fresh one', async () => {
    const ds = makeDs(); // no pendingRepo
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeManualEvent(tmpDir), deps, APP_ID);

    expect(killWorker).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('uuid-old');
    expect(ds.session.sessionId).toMatch(/^uuid-new-/);
    expect(ds.session.workingDir).toBe(tmpDir);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('已切换');
  });

  it('rejects a non-existent path with an error toast and does not fork', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);

    const res = await handleCardAction(makeManualEvent(join(tmpDir, 'nope-does-not-exist')), deps, APP_ID);

    expect(res?.toast?.type).toBe('error');
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true); // recoverable — card stays
  });

  it('rejects an empty path with an error toast and does not fork', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    const { deps } = makeDeps(ds);

    const res = await handleCardAction(makeManualEvent('   '), deps, APP_ID);

    expect(res?.toast?.type).toBe('error');
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
  });

  it('blocks a manual submit while a worktree creation holds the commit lock', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null, worktreeCreating: true });
    const { deps } = makeDeps(ds);

    const res = await handleCardAction(makeManualEvent(tmpDir), deps, APP_ID);

    expect(res?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
  });
});
