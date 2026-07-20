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
  buildNewTopicCliInput: vi.fn(() => ({ content: 'mock-prompt' })),
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
  pushWorktreeBranch: vi.fn(async () => {}),
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
import { forkWorker, killWorker, deliverEphemeralOrReply, deliverWriteLinkCard } from '../src/core/worker-pool.js';
import { buildNewTopicCliInput, getAvailableBots, getSessionWorkingDir } from '../src/core/session-manager.js';
import { getBot } from '../src/bot-registry.js';
import { createSession, closeSession } from '../src/services/session-store.js';
import { createRepoWorktree, pushWorktreeBranch, removeRepoWorktree } from '../src/services/git-worktree.js';
import { applyConfigField } from '../src/services/bot-config-store.js';
import { deleteMessage } from '../src/im/lark/client.js';
import { canOperate } from '../src/im/lark/event-dispatcher.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { ProjectInfo } from '../src/services/project-scanner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
    // Match makeSelectEvent / makeSkipEvent / makeManualEvent open_message_id —
    // only the live posted card may drive selection.
    repoCardMessageId: 'om_card',
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

function makeSkipEvent(operator = OWNER) {
  return {
    operator: { open_id: operator },
    action: { value: { action: 'skip_repo', root_id: ROOT_ID } },
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
  vi.mocked(getBot).mockImplementation(() => ({
    config: { larkAppId: APP_ID, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botName: 'testbot',
    botOpenId: 'ou_bot',
  }) as any);
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
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_initial_turn',
      currentReplyTarget: {
        rootMessageId: ROOT_ID,
        turnId: 'om_stale_reply_target',
        updatedAt: new Date().toISOString(),
      },
      worker: null,
    });
    ds.session.riffRepoDirs = ['/stale/riff/repo'];
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDir).toBe('/repos/alpha');
    expect(ds.session.workingDir).toBe('/repos/alpha');
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledWith(
      ds,
      { content: 'mock-prompt' },
      { turnId: 'om_initial_turn' },
    );
    expect(ds.pendingTurnId).toBeUndefined();
    expect(ds.session.riffRepoDirs).toBeUndefined();
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('已选择');
    expect(killWorker).not.toHaveBeenCalled();
    // First-spawn (pendingRepo) closes nothing, so no "session closed" card.
    expect(deliverEphemeralOrReply).not.toHaveBeenCalled();
  });

  it('pendingRepo selection forwards the complete Codex App sidecar to forkWorker', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hello world', worker: null });
    ds.session.cliId = 'codex-app';
    const substituteTrigger = {
      target: { userId: 'u_configured' },
      observedMention: { name: 'Observed Person', userId: 'u_configured' },
      disclosure: 'prefix' as const,
    };
    ds.pendingSubstituteTrigger = substituteTrigger;
    const codexAppInput = {
      text: 'hello world',
      additionalContext: {
        botmux_substitute_policy: { kind: 'application' as const, value: 'fixed policy' },
        botmux_substitute_target: { kind: 'untrusted' as const, value: 'observed identity' },
      },
    };
    vi.mocked(buildNewTopicCliInput).mockReturnValueOnce({ content: 'mock-prompt', codexAppInput });
    const { deps } = makeDeps(ds);

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(forkWorker).mock.calls[0]![1]).toEqual({
      content: 'mock-prompt',
      codexAppInput,
    });
    expect(vi.mocked(forkWorker).mock.calls[0]).toHaveLength(2);
    expect(vi.mocked(buildNewTopicCliInput).mock.calls[0]![11]).toEqual(expect.objectContaining({
      substituteTrigger,
    }));
  });

  it('skip_repo also forwards the complete Codex App sidecar to forkWorker', async () => {
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_skip_turn',
      worker: null,
    });
    ds.session.cliId = 'codex-app';
    const substituteTrigger = {
      target: { userId: 'u_configured' },
      observedMention: { name: 'Observed Person', userId: 'u_configured' },
      disclosure: 'prefix' as const,
    };
    ds.pendingSubstituteTrigger = substituteTrigger;
    const codexAppInput = {
      text: 'hello world',
      additionalContext: {
        botmux_substitute_policy: { kind: 'application' as const, value: 'fixed policy' },
        botmux_substitute_target: { kind: 'untrusted' as const, value: 'observed identity' },
      },
    };
    vi.mocked(buildNewTopicCliInput).mockReturnValueOnce({ content: 'mock-prompt', codexAppInput });
    const { deps } = makeDeps(ds);

    await handleCardAction(makeSkipEvent(), deps, APP_ID);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledWith(
      ds,
      {
        content: 'mock-prompt',
        codexAppInput,
      },
      { turnId: 'om_skip_turn' },
    );
    expect(ds.pendingTurnId).toBeUndefined();
    expect(vi.mocked(buildNewTopicCliInput).mock.calls[0]![11]).toEqual(expect.objectContaining({
      substituteTrigger,
    }));
  });

  it('keeps the pending repo card untouched when skip_repo is clicked while a worktree is being created', async () => {
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_pending_turn',
      repoCardMessageId: 'om_card',
      worktreeCreating: true,
      worker: null,
    });
    const { deps } = makeDeps(ds);

    const result = await handleCardAction(makeSkipEvent(), deps, APP_ID);

    expect(result?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingPrompt).toBe('hello world');
    expect(ds.pendingTurnId).toBe('om_pending_turn');
    expect(ds.repoCardMessageId).toBe('om_card');
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('lets a pending plain selection win over a concurrent skip_repo during prompt preparation', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hello world', worker: null });
    const { deps } = makeDeps(ds);
    let releaseBots: (() => void) | undefined;
    vi.mocked(getAvailableBots).mockImplementationOnce(() => new Promise(resolve => {
      releaseBots = () => resolve([]);
    }));

    const first = handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(releaseBots).toBeTruthy());
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);

    const late = await handleCardAction(makeSkipEvent(), deps, APP_ID);
    expect(late?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(forkWorker).not.toHaveBeenCalled();

    releaseBots!();
    await first;

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.workingDir).toBe('/repos/alpha');
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
  });

  it('lets skip_repo win over a concurrent plain selection during prompt preparation', async () => {
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hello world', worker: null });
    const { deps } = makeDeps(ds);
    let releaseBots: (() => void) | undefined;
    vi.mocked(getAvailableBots).mockImplementationOnce(() => new Promise(resolve => {
      releaseBots = () => resolve([]);
    }));

    const first = handleCardAction(makeSkipEvent(), deps, APP_ID);
    await vi.waitFor(() => expect(releaseBots).toBeTruthy());
    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(true);

    const late = await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);
    expect(late?.toast?.content).toContain('已有一个 worktree 正在创建');
    expect(forkWorker).not.toHaveBeenCalled();

    releaseBots!();
    await first;

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
  });

  it('holds the pending claim through post-fork confirmation so a second card click cannot mid-session-switch', async () => {
    // Regression: previously pendingRepoCommitInFlight was cleared right after
    // forkWorker, while sessionReply was still awaiting. A second card option
    // in that window saw pendingRepo=false + claim released → treated as
    // mid-session switch → killWorker + empty new session.
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_first_turn',
      repoCardMessageId: 'om_card',
      worker: null,
    });
    const { deps, sessionReply } = makeDeps(ds);
    let releaseReply: (() => void) | undefined;
    sessionReply.mockImplementation(async () => new Promise<string>(res => {
      releaseReply = () => res('om_confirm');
    }));

    const first = handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(forkWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(releaseReply).toBeTruthy());
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(true);
    expect(ds.session.sessionId).toBe('uuid-old');

    const late = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    // After successful fork the card is marked consumed before confirm reply,
    // so the second click is rejected even while claim is still held.
    expect(late?.toast?.content).toMatch(/仓库已选定|worktree 正在创建|ignore the old card/i);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(killWorker).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(ds.session.sessionId).toBe('uuid-old');
    expect(ds.workingDir).toBe('/repos/alpha');
    expect(ds.consumedRepoCardMessageIds).toContain('om_card');

    releaseReply!();
    await first;

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.session.sessionId).toBe('uuid-old');
    expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card');
    expect(ds.repoCardMessageId).toBeUndefined();
  });

  it('skip_repo does not persist the default $HOME cwd onto session.workingDir', async () => {
    // Regression: skip reused commitRepoSelection which always pinned dirPath.
    // getSessionWorkingDir falls back to $HOME when unset; pinning that lets a
    // sibling bot inherit HOME instead of getting its own repo card.
    const home = homedir();
    vi.mocked(getSessionWorkingDir).mockReturnValueOnce(home);
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_skip_home',
      repoCardMessageId: 'om_card',
      worker: null,
    });
    // Explicitly unpinned — the default-dir case.
    ds.workingDir = undefined;
    ds.session.workingDir = undefined;
    const { deps, sessionReply } = makeDeps(ds);

    await handleCardAction(makeSkipEvent(), deps, APP_ID);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDir).toBeUndefined();
    expect(ds.session.workingDir).toBeUndefined();
    expect(sessionReply.mock.calls.map(c => c[1]).join()).toContain('已直接开启会话');
    expect(deleteMessage).toHaveBeenCalledWith(APP_ID, 'om_card');
  });

  it('rejects a stale card click while deleteMessage is still pending (local consume mark)', async () => {
    // Regression: deleteMessage used to be fire-and-forget after claim release.
    // We now mark the card consumed before network awaits and hold the claim
    // through best-effort withdraw. A second click on the still-visible card
    // must never mid-session-switch (killWorker), whether claim is still held
    // or Feishu withdraw hangs / returns false.
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_first_turn',
      repoCardMessageId: 'om_card',
      worker: null,
    });
    // Simulate a live worker after the first fork so a mid-session path would
    // call killWorker if the stale click were allowed through.
    vi.mocked(forkWorker).mockImplementationOnce((session) => {
      (session as any).worker = { killed: false, send: vi.fn() };
    });
    const { deps } = makeDeps(ds);
    let releaseDelete: (() => void) | undefined;
    vi.mocked(deleteMessage).mockImplementationOnce(() => new Promise<boolean>(res => {
      releaseDelete = () => res(false); // withdraw "failed" / no-op
    }) as any);

    const first = handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(forkWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(releaseDelete).toBeTruthy());
    // Consume is local and synchronous before the hung delete.
    expect(ds.consumedRepoCardMessageIds).toContain('om_card');
    expect(ds.session.sessionId).toBe('uuid-old');

    const lateWhileDeletePending = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(lateWhileDeletePending?.toast?.content).toMatch(/仓库已选定|worktree 正在创建|ignore the old card/i);
    expect(killWorker).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(1);

    releaseDelete!();
    await first;
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.session.sessionId).toBe('uuid-old');
    expect(ds.workingDir).toBe('/repos/alpha');

    // After claim release, Feishu may still show the card (delete returned false).
    // Consume mark alone must keep rejecting.
    const lateAfter = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(lateAfter?.toast?.content).toMatch(/仓库已选定|ignore the old card/i);
    expect(killWorker).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.sessionId).toBe('uuid-old');
  });

  it('keeps the first-spawn session when confirm sessionReply throws (card still marked consumed)', async () => {
    // Sibling window: sessionReply throws → finally releases claim, card may
    // still be visible. Consume mark must still reject the second click.
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingTurnId: 'om_first_turn',
      repoCardMessageId: 'om_card',
      worker: null,
    });
    vi.mocked(forkWorker).mockImplementationOnce((session) => {
      (session as any).worker = { killed: false, send: vi.fn() };
    });
    const { deps, sessionReply } = makeDeps(ds);
    sessionReply.mockRejectedValueOnce(new Error('reply boom'));

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.consumedRepoCardMessageIds).toContain('om_card');
    expect(ds.workingDir).toBe('/repos/alpha');

    const late = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(late?.toast?.content).toMatch(/仓库已选定|ignore the old card/i);
    expect(killWorker).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.sessionId).toBe('uuid-old');
  });

  it('keeps pending buffers and releases the claim when forkWorker throws, then allows retry', async () => {
    const pendingFollowUps = ['buffered follow-up'];
    const ds = makeDs({
      pendingRepo: true,
      pendingPrompt: 'hello world',
      pendingFollowUps,
      pendingTurnId: 'om_buffered_turn',
      worker: null,
    });
    const { deps } = makeDeps(ds);
    vi.mocked(forkWorker).mockImplementationOnce(() => { throw new Error('fork boom'); });

    await expect(
      handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID),
    ).rejects.toThrow('fork boom');

    expect(ds.pendingRepo).toBe(true);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.pendingPrompt).toBe('hello world');
    expect(ds.pendingFollowUps).toBe(pendingFollowUps);
    expect(ds.pendingTurnId).toBe('om_buffered_turn');
    expect(deleteMessage).not.toHaveBeenCalled();

    await handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);

    expect(forkWorker).toHaveBeenCalledTimes(2);
    expect(ds.pendingRepo).toBe(false);
    expect(ds.pendingRepoCommitInFlight).toBe(false);
    expect(ds.pendingPrompt).toBeUndefined();
    expect(ds.pendingFollowUps).toBeUndefined();
    expect(ds.pendingTurnId).toBeUndefined();
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
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.consumedRepoCardMessageIds).toContain('om_card');
  });

  it('mid-session claims the card before confirm await so a second click cannot double kill/fork', async () => {
    // Regression: mid-session used to mark consumed only after sessionReply.
    // Park the "已切换" reply; a second click on the same card must toast and
    // not kill/create/fork again.
    const ds = makeDs();
    ds.session.workingDir = '/repos/gamma';
    const { deps, sessionReply } = makeDeps(ds);
    let releaseReply: (() => void) | undefined;
    sessionReply.mockImplementation(async (_root, text) => {
      if (typeof text === 'string' && text.includes('已切换') && !releaseReply) {
        return new Promise<string>(res => { releaseReply = () => res('om_switched'); });
      }
      return 'om_reply';
    });

    const first = handleCardAction(makeSelectEvent('repo_switch', '/repos/alpha'), deps, APP_ID);
    await vi.waitFor(() => expect(forkWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(releaseReply).toBeTruthy());
    // Card must already be claimed before the hung confirm reply.
    expect(ds.repoCardMessageId).toBeUndefined();
    expect(ds.consumedRepoCardMessageIds).toContain('om_card');
    expect(ds.session.sessionId).toMatch(/^uuid-new-/);
    const sessionAfterFirst = ds.session.sessionId;

    const late = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(late?.toast?.content).toMatch(/仓库已选定|ignore the old card/i);
    expect(killWorker).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.sessionId).toBe(sessionAfterFirst);
    expect(ds.workingDir).toBe('/repos/alpha');

    releaseReply!();
    await first;
    expect(killWorker).toHaveBeenCalledTimes(1);
    expect(forkWorker).toHaveBeenCalledTimes(1);
    expect(ds.session.sessionId).toBe(sessionAfterFirst);
  });

  it('rejects a card click after restart-like state (no live repoCardMessageId)', async () => {
    // P2: consumed list is in-memory; after daemon restart both it and
    // repoCardMessageId are empty. Old Feishu cards must still be rejected.
    const ds = makeDs({ repoCardMessageId: undefined, consumedRepoCardMessageIds: undefined });
    ds.session.workingDir = '/repos/gamma';
    const { deps } = makeDeps(ds);

    const late = await handleCardAction(makeSelectEvent('repo_switch', '/repos/beta'), deps, APP_ID);
    expect(late?.toast?.content).toMatch(/仓库已选定|ignore the old card/i);
    expect(killWorker).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(forkWorker).not.toHaveBeenCalled();
    expect(ds.session.sessionId).toBe('uuid-old');
    expect(ds.session.workingDir).toBe('/repos/gamma');
  });

  it('ignores a keyless dropdown (option + root_id, no repo_switch/repo_worktree key)', async () => {
    // Security seal: a hand-crafted card (e.g. via `botmux send --card-json`) can
    // supply a bare `option + value.root_id` with no recognized key. It must NOT
    // fall through to a plain switch — otherwise it drives the session's working
    // dir to an attacker-picked path. botmux's own cards always set the key.
    const ds = makeDs(); // no pendingRepo
    ds.session.workingDir = '/repos/gamma';
    const { deps } = makeDeps(ds);

    await handleCardAction({
      operator: { open_id: OWNER },
      action: { option: '/etc', value: { root_id: ROOT_ID } },
      context: { open_message_id: 'om_card' },
    }, deps, APP_ID);

    expect(forkWorker).not.toHaveBeenCalled();
    expect(killWorker).not.toHaveBeenCalled();
    expect(ds.workingDir).not.toBe('/etc');
    expect(ds.session.workingDir).toBe('/repos/gamma');
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

  it('Riff multi-repo pushes every branch and preserves the user-selected repo order', async () => {
    vi.mocked(getBot).mockImplementation(() => ({
      config: {
        larkAppId: APP_ID,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'riff',
      },
      resolvedAllowedUsers: [],
      botName: 'testbot',
      botOpenId: 'ou_bot',
    }) as any);
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    ds.session.cliId = 'riff';
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/feat-riff/alpha', branch: 'feat/riff-alpha', baseRef: 'origin/master' })
      .mockResolvedValueOnce({ path: '/repos/feat-riff/beta', branch: 'feat/riff-beta', baseRef: 'origin/master' });

    await handleCardAction(makeWorktreeSubmitEvent('feat/riff', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(pushWorktreeBranch).toHaveBeenCalledTimes(2);
    expect(pushWorktreeBranch).toHaveBeenNthCalledWith(1, '/repos/feat-riff/alpha', 'feat/riff-alpha');
    expect(pushWorktreeBranch).toHaveBeenNthCalledWith(2, '/repos/feat-riff/beta', 'feat/riff-beta');
    expect(ds.session.riffRepoDirs).toEqual([
      '/repos/feat-riff/alpha',
      '/repos/feat-riff/beta',
    ]);
  });

  it('uses the reconciled CLI/backend pair when deciding whether to push a worktree branch', async () => {
    vi.mocked(getBot).mockImplementation(() => ({
      config: {
        larkAppId: APP_ID,
        larkAppSecret: 'secret',
        cliId: 'codex-app',
        backendType: 'riff',
      },
      resolvedAllowedUsers: [],
      botName: 'testbot',
      botOpenId: 'ou_bot',
    }) as any);
    const invalidNonRiffDs = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    invalidNonRiffDs.session.cliId = 'codex-app';
    const { deps: invalidDeps } = makeDeps(invalidNonRiffDs);
    vi.mocked(createRepoWorktree).mockResolvedValueOnce({
      path: '/repos/codex-app-wt', branch: 'feat/codex-app', baseRef: 'origin/master',
    });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), invalidDeps, APP_ID);
    await vi.waitFor(() => expect(invalidNonRiffDs.worktreeCreating).toBe(false));
    expect(pushWorktreeBranch).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getBot).mockImplementation(() => ({
      config: {
        larkAppId: APP_ID,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'pty',
      },
      resolvedAllowedUsers: [],
      botName: 'testbot',
      botOpenId: 'ou_bot',
    }) as any);
    const invalidRiffDs = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null });
    invalidRiffDs.session.cliId = 'riff';
    const { deps: riffDeps } = makeDeps(invalidRiffDs);
    vi.mocked(createRepoWorktree).mockResolvedValueOnce({
      path: '/repos/riff-wt', branch: 'feat/riff-local', baseRef: 'origin/master',
    });

    await handleCardAction(makeSelectEvent('repo_worktree', '/repos/alpha'), riffDeps, APP_ID);
    await vi.waitFor(() => expect(invalidRiffDs.worktreeCreating).toBe(false));
    expect(pushWorktreeBranch).toHaveBeenCalledOnce();
    expect(pushWorktreeBranch).toHaveBeenCalledWith('/repos/riff-wt', 'feat/riff-local');
  });

  it('stamps multi-repo Riff directories on the fresh mid-session replacement', async () => {
    vi.mocked(getBot).mockImplementation(() => ({
      config: {
        larkAppId: APP_ID,
        larkAppSecret: 'secret',
        cliId: 'riff',
        backendType: 'riff',
      },
      resolvedAllowedUsers: [],
      botName: 'testbot',
      botOpenId: 'ou_bot',
    }) as any);
    const ds = makeDs();
    const oldSession = ds.session;
    const { deps } = makeDeps(ds);
    vi.mocked(createRepoWorktree)
      .mockResolvedValueOnce({ path: '/repos/mid-riff/alpha', branch: 'feat/mid-alpha', baseRef: 'origin/master' })
      .mockResolvedValueOnce({ path: '/repos/mid-riff/beta', branch: 'feat/mid-beta', baseRef: 'origin/master' });

    await handleCardAction(makeWorktreeSubmitEvent('feat/mid', ['/repos/alpha', '/repos/beta']), deps, APP_ID);
    await vi.waitFor(() => expect(ds.worktreeCreating).toBe(false));

    expect(closeSession).toHaveBeenCalledWith('uuid-old');
    expect(ds.session).not.toBe(oldSession);
    expect(oldSession.riffRepoDirs).toBeUndefined();
    expect(ds.session.riffRepoDirs).toEqual([
      '/repos/mid-riff/alpha',
      '/repos/mid-riff/beta',
    ]);
    expect(forkWorker).toHaveBeenCalledTimes(1);
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

  it('worktree_toggle_mode requires canOperate — a non-operator (even the pending-session owner) cannot flip bot config', async () => {
    // It writes bot-level worktreeMultiPicker (bots.json), so it must NOT ride
    // the pendingRepoOwnerException that lets talk-only users start their own session.
    const ds = makeDs({ pendingRepo: true, pendingPrompt: 'hi', worker: null, repoCardMessageId: 'om_old_card' });
    const { deps } = makeDeps(ds);
    vi.mocked(canOperate).mockReturnValueOnce(false); // non-operator
    const event = {
      operator: { open_id: OWNER }, // session owner, but NOT an operator
      action: { value: { action: 'worktree_toggle_mode', root_id: ROOT_ID } },
      context: { open_message_id: 'om_card' },
    };

    const res = await handleCardAction(event, deps, APP_ID);

    expect(res?.toast).toBeUndefined();                // sensitive gate blocks silently (logs only)
    expect(vi.mocked(applyConfigField)).not.toHaveBeenCalled(); // no bot-config write
    expect(vi.mocked(deleteMessage)).not.toHaveBeenCalled();
  });

  it('get_write_link 破例：非 operator 点击得到「无操作权限」toast，而非像其它敏感动作那样静默', async () => {
    // 与上面的 worktree_toggle_mode 对照：敏感门控默认静默 block（仅日志），但
    //「获取操作链接」是用户主动点的取权动作，静默会让人以为按钮坏了 —— 破例给提示。
    const ds = makeDs({ worker: null });
    const { deps } = makeDeps(ds);
    vi.mocked(canOperate).mockReturnValueOnce(false); // non-operator
    const event = {
      operator: { open_id: 'ou_stranger' },
      action: { value: { action: 'get_write_link', root_id: ROOT_ID } },
      context: { open_message_id: 'om_card' },
    };

    const res = await handleCardAction(event, deps, APP_ID);

    expect(res?.toast?.type).toBe('warning');
    expect(res?.toast?.content).toContain('没有操作权限');
    expect(vi.mocked(deliverWriteLinkCard)).not.toHaveBeenCalled(); // 门控就拦下，未投递
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
    expect(vi.mocked(forkWorker).mock.calls[0]![1]).toEqual({ content: 'mock-prompt' });
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
