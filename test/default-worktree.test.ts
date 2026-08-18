/**
 * Unit tests for the auto-worktree-on-spawn helper (services/default-worktree).
 *
 * Uses REAL git against temp repos (no network) since the whole point is the
 * git precheck + createRepoWorktree behavior. Focus:
 *   - opt-in gating (isBotDefaultDir + botAutoWorktreeEnabled)
 *   - git precheck: a non-git default dir falls back WITHOUT a premature
 *     "creating…" notice (the double-notice bug the review flagged)
 *   - notify ordering on the happy path (creating → created)
 *   - fail-closed: when the file sandbox is on, a non-git dir or a worktree
 *     creation failure REFUSES (AutoWorktreeFailClosedError) instead of
 *     degrading to the real default dir (which would be a sandbox escape —
 *     the sandbox binds workingDir read-write to the host)
 *
 * Run: pnpm vitest run test/default-worktree.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let tempRoot: string;
let configPath: string;

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

/** A cloned repo (origin/master present) usable as a worktree base. */
function makeRepo(name: string): string {
  const upstream = join(tempRoot, `${name}-upstream`);
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'master');
  git(upstream, 'commit', '--allow-empty', '-m', 'init');
  const clone = join(tempRoot, name);
  git(tempRoot, 'clone', upstream, clone);
  return clone;
}

/** Register one bot pointing defaultWorkingDir at `dir`, toggle configurable. */
async function loadWithBot(
  dir: string,
  autoWorktree: boolean,
  agent: { cliId?: string; backendType?: string; sandbox?: boolean; readIsolation?: boolean } = {},
) {
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_wt',
    larkAppSecret: 'secret',
    cliId: agent.cliId ?? 'claude-code',
    ...(agent.backendType ? { backendType: agent.backendType } : {}),
    defaultWorkingDir: dir,
    ...(autoWorktree ? { defaultWorkingDirAutoWorktree: true } : {}),
    ...(agent.sandbox ? { sandbox: true } : {}),
    ...(agent.readIsolation ? { readIsolation: true } : {}),
  }], null, 2), 'utf-8');
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  const mod = await import('../src/services/default-worktree.js');
  return { registry, mod };
}

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'default-worktree-test-')));
  configPath = join(tempRoot, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('maybeCreateDefaultWorktree', () => {
  it('creates a worktree off a git default dir and notifies creating→created in order', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, true);
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).not.toBe(repo);       // landed in the new worktree, not the base repo
    expect(r.dir).toMatch(/proj-wt/);   // sibling <repo>-wt-… naming
    // Two notices, in order: the "creating…" heads-up THEN the "created" result.
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain(r.dir);
  });

  it('does not push for an invalid codex-app + riff backend pair', async () => {
    const repo = makeRepo('codex-invalid-riff');
    const { mod } = await loadWithBot(repo, true, { cliId: 'codex-app', backendType: 'riff' });

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh',
    });

    const branch = git(r.dir, 'branch', '--show-current');
    expect(git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).toBe('');
  });

  it('pushes when a Riff CLI is paired with a stale local backend', async () => {
    const repo = makeRepo('riff-invalid-local');
    const { mod } = await loadWithBot(repo, true, { cliId: 'riff', backendType: 'pty' });

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh',
    });

    const branch = git(r.dir, 'branch', '--show-current');
    expect(git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).toContain(`refs/heads/${branch}`);
  });

  it('non-git default dir falls back WITHOUT a premature "creating" notice (single fallback notice)', async () => {
    const plain = join(tempRoot, 'not-a-repo');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true);
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(plain);          // degrades to the base dir, session still starts
    expect(notices).toHaveLength(1);    // ONLY the fallback — no misleading "creating…" first
  });

  it('fail-closed: sandbox on + non-git default dir REFUSES (throws, no fallback to the real dir)', async () => {
    const plain = join(tempRoot, 'not-a-repo-sbx');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { sandbox: true });
    const notices: string[] = [];

    // The sandbox binds workingDir read-write to the real host dir (DIRECT mode),
    // so a fallback to baseDir would be a sandbox escape — the spawn is refused.
    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);

    // No fallback notice from the service — the caller (runAutoWorktreeCommit)
    // surfaces the refusal + recovery hint and closes the pending session.
    expect(notices).toHaveLength(0);
  });

  it('fail-closed: sandbox on + worktree creation failure REFUSES (throws, only the creating notice)', async () => {
    // An empty git repo (init, no commits) passes isGitWorkTree but make
    // createRepoWorktree throw ("fatal: not a valid object name: 'HEAD'").
    const empty = join(tempRoot, 'empty-repo');
    mkdirSync(empty);
    execFileSync('git', ['init', '-b', 'master'], { cwd: empty, stdio: 'ignore' });
    const { mod } = await loadWithBot(empty, true, { sandbox: true });
    const notices: string[] = [];

    await expect(mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);

    // Only the "creating…" heads-up went out; NO fallback-to-real-dir notice.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('worktree');
  });

  it('fail-closed: BOTMUX_SANDBOX=1 env also refuses even without the bot config flag', async () => {
    const plain = join(tempRoot, 'not-a-repo-env');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true); // sandbox config flag OFF
    process.env.BOTMUX_SANDBOX = '1';
    try {
      await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
        isBotDefaultDir: true, locale: 'zh',
      })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
    } finally {
      delete process.env.BOTMUX_SANDBOX;
    }
  });

  it('fail-closed: legacy readIsolation=true also refuses (worker treats it as sandbox-on)', async () => {
    // The worker's sandboxRequested unions sandbox || readIsolation || BOTMUX_SANDBOX,
    // so a legacy readIsolation bot IS sandboxed even when the new `sandbox` flag is
    // absent (unmigrated read-only BOTS_CONFIG). fail-closed must track that union.
    const plain = join(tempRoot, 'not-a-repo-riso');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { readIsolation: true });
    const notices: string[] = [];

    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);

    expect(notices).toHaveLength(0); // no fallback-to-real-dir notice
  });

  it('sandbox off: worktree creation failure still DEGRADES to base dir (no refusal)', async () => {
    const empty = join(tempRoot, 'empty-repo-nosbx');
    mkdirSync(empty);
    execFileSync('git', ['init', '-b', 'master'], { cwd: empty, stdio: 'ignore' });
    const { mod } = await loadWithBot(empty, true); // sandbox off
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(empty); // degraded to the base dir — session still starts
    expect(notices.some(n => n.includes('回退'))).toBe(true); // fallback notice posted
  });

  it('no-ops (no notice, dir unchanged) when the dir did not come from the bot default', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, true);
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: false, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r).toEqual({ dir: repo });
    expect(notices).toHaveLength(0);
  });

  it('no-ops when the toggle is off even if isBotDefaultDir is true', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, false); // toggle off
    expect(mod.botAutoWorktreeEnabled('app_wt')).toBe(false);

    const notices: string[] = [];
    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r).toEqual({ dir: repo });
    expect(notices).toHaveLength(0);
  });
});
