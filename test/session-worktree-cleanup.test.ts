/**
 * Session-closed card「清理 worktree」(#698): the click-time checks and the
 * removal, against REAL git repos and REAL `git worktree add` worktrees.
 *
 * Run: bunx vitest run test/session-worktree-cleanup.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRepoWorktree } from '../src/services/git-worktree.js';
import { findBotmuxWorktreeFor, recordCreatedWorktree } from '../src/services/botmux-worktree-store.js';
import {
  cleanupSessionWorktree,
  defaultSessionWorktreeCleanupDeps,
  sessionWorktreeOffer,
  type SessionWorktreeCleanupDeps,
} from '../src/core/session-worktree-cleanup.js';
import { config } from '../src/config.js';
import type { Session } from '../src/types.js';

let tempRoot: string;
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A clone with origin/master, so new worktrees branch off a real remote ref. */
function makeRepo(name: string): string {
  const upstream = join(tempRoot, `${name}-upstream`);
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'master');
  writeFileSync(join(upstream, 'README.md'), 'hello\n');
  writeFileSync(join(upstream, '.gitignore'), 'node_modules/\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'init');
  const clone = join(tempRoot, name);
  git(tempRoot, 'clone', upstream, clone);
  return clone;
}

/** A worktree created and recorded exactly the way the creation sites do it. */
async function botmuxWorktree(repo: string, branch = 'wt/review'): Promise<string> {
  const creation = await createRepoWorktree(repo, { branch });
  await recordCreatedWorktree('app_a', creation);
  return creation.path;
}

function closedSession(workingDir: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1', chatId: 'oc_chat', rootMessageId: 'om_root', title: 't',
    status: 'closed', createdAt: '2026-10-25T00:00:00.000Z', larkAppId: 'app_a', workingDir,
    ...extra,
  } as Session;
}

function deps(session: Session | undefined, overrides: Partial<SessionWorktreeCleanupDeps> = {}): SessionWorktreeCleanupDeps {
  return {
    ...defaultSessionWorktreeCleanupDeps(),
    getSession: id => (session?.sessionId === id ? session : undefined),
    activeSessionsUsing: () => [],
    ...overrides,
  };
}

beforeEach(() => {
  // git worktree canonicalizes macOS /var temp paths to /private/var.
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'session-wt-cleanup-')));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('cleanupSessionWorktree', () => {
  it('removes a clean botmux worktree with `git worktree remove`, keeps the branch, and a repeat click is a no-op', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'ignored build output\n');
    const session = closedSession(dir);

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(session)))
      .toEqual({ status: 'removed', dir, branch: 'wt/review' });
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(dir);
    expect(git(repo, 'branch', '--list', 'wt/review')).toContain('wt/review');
    expect(findBotmuxWorktreeFor(config.session.dataDir, dir)).toBeUndefined();

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(session)))
      .toEqual({ status: 'gone', dir });
  });

  it('also accepts a session whose working dir is a subdirectory of the worktree', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    mkdirSync(join(dir, 'pkg'));

    expect((await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(join(dir, 'pkg'))))).status).toBe('removed');
    expect(existsSync(dir)).toBe(false);
  });

  it('never touches a worktree botmux did not create', async () => {
    const repo = makeRepo('proj');
    const dir = join(tempRoot, 'user-picked');
    git(repo, 'worktree', 'add', '-b', 'user/own', dir);

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'not_botmux' });
    expect(existsSync(dir)).toBe(true);
    expect(sessionWorktreeOffer(closedSession(dir))).toBeUndefined();
  });

  it('never touches a directory re-created at a recorded path after botmux created it', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    // Moved away (inode kept alive), then a user worktree takes the same path.
    git(repo, 'worktree', 'move', dir, `${dir}-moved`);
    git(repo, 'worktree', 'add', '-b', 'user/replacement', dir);

    expect(sessionWorktreeOffer(closedSession(dir))).toBeUndefined();
    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'not_botmux' });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses while a tracked file is modified', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    writeFileSync(join(dir, 'README.md'), 'edited\n');

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'blocked', dir, reasons: [{ kind: 'uncommitted', count: 1 }] });
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });

  it('refuses while an untracked file exists', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    writeFileSync(join(dir, 'notes.txt'), 'draft\n');

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'blocked', dir, reasons: [{ kind: 'uncommitted', count: 1 }] });
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });

  it('refuses while the branch has unpushed commits', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    writeFileSync(join(dir, 'feature.txt'), 'work\n');
    git(dir, 'add', 'feature.txt');
    git(dir, 'commit', '-m', 'feature');

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'blocked', dir, reasons: [{ kind: 'unpushed', count: 1 }] });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses while another session is still active in the directory', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    const active = closedSession(dir, { sessionId: 'other', status: 'active' });

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir), {
      activeSessionsUsing: target => (target === dir ? [active] : []),
    }))).toEqual({ status: 'blocked', dir, reasons: [{ kind: 'sessions', count: 1 }] });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses when the session inventory cannot be read completely', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir), {
      activeSessionsUsing: () => { throw new Error('store locked'); },
    }))).toEqual({ status: 'blocked', dir, reasons: [{ kind: 'sessions_unknown', error: 'store locked' }] });
    expect(existsSync(dir)).toBe(true);
  });

  it.runIf(process.platform === 'linux')('refuses while a process has its current directory inside the worktree', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    mkdirSync(join(dir, 'pkg'));
    const child = spawn('sleep', ['30'], { cwd: join(dir, 'pkg'), stdio: 'ignore' });
    children.push(child);
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'blocked', dir, reasons: [{ kind: 'processes', count: 1 }] });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses when process usage cannot be determined', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir), {
      processesUsing: async () => ({ status: 'unknown', error: 'lsof missing' }),
    }))).toEqual({ status: 'blocked', dir, reasons: [{ kind: 'processes_unknown', error: 'lsof missing' }] });
    expect(existsSync(dir)).toBe(true);
  });

  it('lists every reason at once', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    writeFileSync(join(dir, 'feature.txt'), 'work\n');
    git(dir, 'add', 'feature.txt');
    git(dir, 'commit', '-m', 'feature');
    writeFileSync(join(dir, 'README.md'), 'edited\n');

    const outcome = await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir), {
      activeSessionsUsing: () => [closedSession(dir, { sessionId: 'other', status: 'active' })],
    }));
    expect(outcome).toEqual({
      status: 'blocked',
      dir,
      reasons: [{ kind: 'sessions', count: 1 }, { kind: 'uncommitted', count: 1 }, { kind: 'unpushed', count: 1 }],
    });
  });

  it('refuses once the session has been resumed', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir, { status: 'active' }))))
      .toEqual({ status: 'session_active' });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses when the session is resumed between the click and the worktree lock', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    const reads = [closedSession(dir), closedSession(dir, { status: 'active' })];

    expect(await cleanupSessionWorktree('sess-1', 'app_a', deps(undefined, {
      getSession: () => reads.shift() ?? closedSession(dir, { status: 'active' }),
    }))).toEqual({ status: 'session_active' });
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses a session id that is unknown or belongs to another bot', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);

    expect(await cleanupSessionWorktree('missing', 'app_a', deps(closedSession(dir))))
      .toEqual({ status: 'session_missing' });
    expect(await cleanupSessionWorktree('sess-1', 'app_b', deps(closedSession(dir))))
      .toEqual({ status: 'session_missing' });
    expect(existsSync(dir)).toBe(true);
  });

  it('reports a failed removal instead of forcing it (clean worktree holding a submodule)', async () => {
    const lib = join(tempRoot, 'lib');
    mkdirSync(lib);
    git(lib, 'init', '-b', 'master');
    git(lib, 'commit', '--allow-empty', '-m', 'lib');
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'lib');
    git(dir, 'commit', '-m', 'add submodule');
    git(dir, 'push', '-u', 'origin', 'wt/review');

    const outcome = await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir)));
    expect(outcome.status).toBe('failed');
    expect(existsSync(join(dir, 'lib'))).toBe(true);
    expect(findBotmuxWorktreeFor(config.session.dataDir, dir)?.dir).toBe(dir);
  });

  it('reports a failed removal instead of forcing it (locked worktree)', async () => {
    const repo = makeRepo('proj');
    const dir = await botmuxWorktree(repo);
    git(repo, 'worktree', 'lock', dir);

    const outcome = await cleanupSessionWorktree('sess-1', 'app_a', deps(closedSession(dir)));
    expect(outcome.status).toBe('failed');
    expect(existsSync(dir)).toBe(true);
    expect(findBotmuxWorktreeFor(config.session.dataDir, dir)?.dir).toBe(dir);
  });
});

describe('recordCreatedWorktree', () => {
  it('does not record a worktree that was reused rather than created', async () => {
    const repo = makeRepo('proj');
    const target = join(tempRoot, 'shared', 'proj');
    await createRepoWorktree(repo, { branch: 'wt/shared', worktreePath: target });
    const reused = await createRepoWorktree(repo, { branch: 'wt/shared', worktreePath: target, reuseExisting: true });

    await recordCreatedWorktree('app_a', reused);

    expect(reused.reused).toBe(true);
    expect(findBotmuxWorktreeFor(config.session.dataDir, target)).toBeUndefined();
  });
});
