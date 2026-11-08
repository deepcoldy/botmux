/**
 * Session-closed card「清理 worktree」through the real card dispatcher: the
 * operator gate (closed-session context), the click wiring, the real session
 * store inventory and a REAL `git worktree add` worktree.
 *
 * Run: bunx vitest run test/card-handler-worktree-cleanup.test.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMessageMock } = vi.hoisted(() => ({ updateMessageMock: vi.fn(async () => {}) }));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, updateMessage: updateMessageMock };
});

const APP_ID = 'app_wt_clean';
const OWNER = 'ou_owner';
const STRANGER = 'ou_stranger';
let tempRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

async function setup(sessionStatus: 'closed' | 'active' = 'closed') {
  const upstream = join(tempRoot, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'master');
  git(upstream, 'commit', '--allow-empty', '-m', 'init');
  const repo = join(tempRoot, 'proj');
  git(tempRoot, 'clone', upstream, repo);
  const cfg = join(tempRoot, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{ larkAppId: APP_ID, larkAppSecret: 's', cliId: 'claude-code', lang: 'zh', allowedUsers: [OWNER] }]));
  process.env.BOTS_CONFIG = cfg;
  process.env.SESSION_DATA_DIR = join(tempRoot, 'data');

  vi.resetModules();
  const sessionStore = await import('../src/services/session-store.js');
  sessionStore.init(APP_ID);
  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  const { createRepoWorktree } = await import('../src/services/git-worktree.js');
  const { recordCreatedWorktree } = await import('../src/services/botmux-worktree-store.js');
  const creation = await createRepoWorktree(repo, { branch: 'wt/review' });
  await recordCreatedWorktree(APP_ID, creation);

  const session = sessionStore.createSession('oc_chat', 'om_root', 'Review', 'group', 'thread');
  session.larkAppId = APP_ID;
  session.workingDir = creation.path;
  sessionStore.updateSession(session);
  if (sessionStatus === 'closed') sessionStore.closeSession(session.sessionId);
  const { handleCardAction } = await import('../src/im/lark/card-handler.js');
  return { repo, dir: creation.path, sessionId: session.sessionId, handleCardAction };
}

function click(operator: string, sessionId: string) {
  return {
    operator: { open_id: operator },
    action: { value: { action: 'cleanup_session_worktree', root_id: 'om_root', session_id: sessionId } },
    context: { open_message_id: 'om_closed_card' },
  };
}

const deps = () => ({ activeSessions: new Map(), sessionReply: vi.fn(async () => ''), lastRepoScan: new Map() }) as any;

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'card-wt-cleanup-')));
  updateMessageMock.mockClear();
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('closed card「清理 worktree」click', () => {
  it('a non-operator is refused with a toast and nothing is removed', async () => {
    const { dir, sessionId, handleCardAction } = await setup();

    const res = await handleCardAction(click(STRANGER, sessionId), deps(), APP_ID);

    expect(res).toEqual({ toast: { type: 'warning', content: expect.any(String) } });
    expect(existsSync(dir)).toBe(true);
  });

  it('the operator gets the running card at once, then the worktree is removed and the result patched in', async () => {
    const { repo, dir, sessionId, handleCardAction } = await setup();

    const res = await handleCardAction(click(OWNER, sessionId), deps(), APP_ID);
    expect(JSON.stringify(res.card.data)).not.toContain('cleanup_session_worktree');
    expect(existsSync(dir)).toBe(true);

    await res.afterAck();
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'wt/review')).toContain('wt/review');
    expect(updateMessageMock).toHaveBeenCalledTimes(1);
    const [appId, messageId, card] = updateMessageMock.mock.calls[0] as unknown as [string, string, string];
    expect([appId, messageId]).toEqual([APP_ID, 'om_closed_card']);
    expect(card).toContain(dir);
    expect(card).not.toContain('cleanup_session_worktree');
  });

  it('a session that is active again is refused', async () => {
    const { dir, sessionId, handleCardAction } = await setup('active');

    const res = await handleCardAction(click(OWNER, sessionId), deps(), APP_ID);

    expect(res).toHaveProperty('toast');
    expect(existsSync(dir)).toBe(true);
  });
});
