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
  agent: {
    cliId?: string;
    backendType?: string;
    sandbox?: boolean | 'oncall' | 'scratch';
    readIsolation?: boolean;
    apiOnly?: boolean;
    wrapperCli?: string;
    env?: Record<string, string>;
    mojo?: Record<string, unknown>;
  } = {},
) {
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_wt',
    larkAppSecret: 'secret',
    cliId: agent.cliId ?? 'claude-code',
    ...(agent.backendType ? { backendType: agent.backendType } : {}),
    defaultWorkingDir: dir,
    ...(autoWorktree ? { defaultWorkingDirAutoWorktree: true } : {}),
    ...(agent.sandbox ? { sandbox: agent.sandbox } : {}),
    ...(agent.readIsolation ? { readIsolation: true } : {}),
    ...(agent.apiOnly ? { apiOnly: true } : {}),
    ...(agent.wrapperCli ? { wrapperCli: agent.wrapperCli } : {}),
    ...(agent.env ? { env: agent.env } : {}),
    ...(agent.mojo ? { mojo: agent.mojo } : {}),
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

  it('an explicit force request fails closed for a non-git directory', async () => {
    const plain = join(tempRoot, 'forced-not-a-repo');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, false);
    const notices: string[] = [];

    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true,
      locale: 'zh',
      force: true,
      notify: (m) => { notices.push(m); },
    })).rejects.toThrow();

    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain(`\`${plain}\``);
  });

  it('an explicit force request creates and then reuses the deterministic topic worktree when the toggle is off', async () => {
    const repo = makeRepo('forced-topic');
    const { mod } = await loadWithBot(repo, false);
    const target = join(tempRoot, 'forced-topic-shared');
    const ctx = {
      isBotDefaultDir: true,
      locale: 'zh' as const,
      force: true,
      worktreePath: target,
      branch: 'wt/botmux-topic',
      reuseExisting: true,
    };

    const first = await mod.maybeCreateDefaultWorktree('app_wt', repo, ctx);
    const second = await mod.maybeCreateDefaultWorktree('app_wt', repo, ctx);

    expect(first.dir).toBe(target);
    expect(second.dir).toBe(target);
    expect(git(target, 'branch', '--show-current')).toBe('wt/botmux-topic');
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

  it('fail-open window: sandbox off→on flip DURING the build is ignored — the gate consumes the frozen session snapshot', async () => {
    // R3 regression: the gate used to compute fail-closed from LIVE bot config
    // before any await, while the fork adopted the live value later. A dashboard
    // PUT /api/bot-sandbox flipping sandbox off→on while the "creating…" notice
    // was in flight made the gate degrade on the OLD value (fallback to the real
    // default dir) while the fork engaged the local sandbox on the NEW value
    // there — the write-escape the gate exists to prevent. The decision is now
    // frozen at pending-session establishment (freezeSessionSandboxDecision) and
    // handed to the gate via sandboxSnapshot; a mid-build flip changes
    // neither the gate nor the fork (both read the session snapshot).
    const empty = join(tempRoot, 'empty-repo-flip');
    mkdirSync(empty);
    execFileSync('git', ['init', '-b', 'master'], { cwd: empty, stdio: 'ignore' });
    const { registry, mod } = await loadWithBot(empty, true); // sandbox OFF at freeze time

    // Simulate the pending-session freeze (runAutoWorktreeCommit does this before
    // any git/notice await): snapshot the decision inputs ONCE.
    const liveCfg = registry.getBot('app_wt').config;
    const frozen = { sandbox: liveCfg.sandbox === true };
    expect(frozen.sandbox).toBe(false);

    const notices: string[] = [];
    // Flip the LIVE config while the "creating…" notice is in flight — exactly
    // what updateBotSandbox's in-memory publish does (bot.config.sandbox = true).
    const flipDuringNotice = (m: string) => {
      notices.push(m);
      if (notices.length === 1) {
        registry.getBot('app_wt').config.sandbox = true;
      }
    };

    const r = await mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh', notify: flipDuringNotice,
      sandboxSnapshot: frozen,
    });

    // The flip really happened on the live config…
    expect(registry.getBot('app_wt').config.sandbox).toBe(true);
    // …but the gate consumed the FROZEN snapshot (sandbox:false), so it degrades
    // instead of refusing — and the fork would read the same frozen session
    // fields, so no sandbox engages on the real dir (no fallback escape).
    expect(r.dir).toBe(empty);
    expect(notices.some(n => n.includes('回退'))).toBe(true);

    // Contrast: a decision computed from the NEW live config (what the OLD gate
    // would have re-read after the fallback) now REFUSES — proving the flip is
    // real and the freeze is what kept this build on the degraded path.
    await expect(mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh',
      sandboxSnapshot: { sandbox: true },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('fail-open window: sandbox on→off flip DURING the build is ignored — the gate still refuses on the frozen snapshot', async () => {
    // The symmetric direction: frozen ON, live flips OFF mid-build. The gate must
    // still refuse (fail-closed) — degrading would hand the fork a real dir while
    // the frozen decision (which the fork consumes) keeps the sandbox engaged.
    const empty = join(tempRoot, 'empty-repo-flip-off');
    mkdirSync(empty);
    execFileSync('git', ['init', '-b', 'master'], { cwd: empty, stdio: 'ignore' });
    const { registry, mod } = await loadWithBot(empty, true, { sandbox: true });

    const liveCfg = registry.getBot('app_wt').config;
    const frozen = { sandbox: liveCfg.sandbox === true };
    expect(frozen.sandbox).toBe(true);

    const notices: string[] = [];
    const flipDuringNotice = (m: string) => {
      notices.push(m);
      if (notices.length === 1) {
        registry.getBot('app_wt').config.sandbox = false;
      }
    };

    await expect(mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh', notify: flipDuringNotice,
      sandboxSnapshot: frozen,
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);

    // The flip really happened…
    expect(registry.getBot('app_wt').config.sandbox).toBe(false);
    // …but the gate refused on the frozen ON decision (only the creating notice).
    expect(notices).toHaveLength(1);
  });

  it('snapshot ON / live OFF when ENTERING the gate: the gate refuses on the frozen snapshot', async () => {
    // Divergence exists BEFORE the gate decides (unlike the flip-in-notify
    // tests, where the verdict is already computed). A gate that re-read live
    // config would degrade here; the frozen snapshot must win.
    const plain = join(tempRoot, 'not-a-repo-snap-on-live-off');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true); // live: sandbox OFF
    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: true },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('snapshot OFF / live ON when ENTERING the gate: the gate degrades on the frozen snapshot', async () => {
    const plain = join(tempRoot, 'not-a-repo-snap-off-live-on');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { sandbox: true }); // live: oncall
    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: false },
    });
    expect(r.dir).toBe(plain);
  });

  it('mojo remote proof voided mid-build: the gate degrades at T0, the fork-side guard refuses oncall at T1', async () => {
    // Reproduction of the reported TOCTOU: mojo{cloud:true} + oncall + non-git
    // default dir. T0 gate: provably remote → no local sandbox → degrade to the
    // real dir. Mid-build the mojo block flips to cloud:false. T1 (worker):
    // resolves to LOCAL oncall in that real dir → must be refused, never run.
    const plain = join(tempRoot, 'not-a-repo-mojo-flip');
    mkdirSync(plain);
    const { registry, mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', sandbox: true, mojo: { cloud: true },
    });
    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: true, cliId: 'mojo' },
    });
    expect(r.dir).toBe(plain); // T0: degraded (gate judged remote)

    // Mid-build config edit voids the remote proof.
    const cfg = registry.getBot('app_wt').config as any;
    cfg.mojo = { ...cfg.mojo, cloud: false };

    // T1: what the worker resolves (same helpers as worker.ts spawnCli).
    const { resolveLocalSandboxMode, autoWorktreeFallbackSandboxError } = await import('../src/adapters/backend/sandbox.js');
    const { buildEffectiveMojoConfig, normalizeMojoConfig } = await import('../src/adapters/backend/mojo-types.js');
    const v = normalizeMojoConfig(cfg.mojo);
    const sandboxMode = resolveLocalSandboxMode({
      backendType: 'mojo',
      mojoConfig: buildEffectiveMojoConfig(v.ok ? v.value : undefined, {}),
      configSandbox: true,
    });
    expect(sandboxMode).toBe('oncall'); // the escape the guard must stop
    expect(autoWorktreeFallbackSandboxError({ sandboxMode, workingDir: plain, fallbackDir: plain })).toMatch(/Refusing/);
  });

  it('scratch sandbox does NOT fail closed: the COW overlay keeps the real dir untouched, so it DEGRADES', async () => {
    // scratch (full-root COW overlay / APFS clone) routes every write — cwd
    // included — into a throwaway per-session layer; the host stays unchanged.
    // The real-dir write-escape rationale only holds for oncall (DIRECT bind).
    const empty = join(tempRoot, 'empty-repo-scratch');
    mkdirSync(empty);
    execFileSync('git', ['init', '-b', 'master'], { cwd: empty, stdio: 'ignore' });
    const { mod } = await loadWithBot(empty, true, { sandbox: 'scratch' });
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', empty, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
      sandboxSnapshot: { sandbox: 'scratch' },
    });

    expect(r.dir).toBe(empty);
    expect(notices.some(n => n.includes('回退'))).toBe(true);
  });

  it('BOTMUX_SANDBOX=scratch overrides a frozen oncall decision the same way the worker does → DEGRADES', async () => {
    const plain = join(tempRoot, 'not-a-repo-env-scratch');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { sandbox: true });
    process.env.BOTMUX_SANDBOX = 'scratch';
    try {
      const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
        isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: true },
      });
      expect(r.dir).toBe(plain);
    } finally {
      delete process.env.BOTMUX_SANDBOX;
    }
  });

  it('an unparseable BOTMUX_SANDBOX fails CLOSED (the worker would refuse; the gate must not permit the real dir)', async () => {
    const plain = join(tempRoot, 'not-a-repo-env-bad');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true);
    process.env.BOTMUX_SANDBOX = 'yes-please';
    try {
      await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
        isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: false },
      })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
    } finally {
      delete process.env.BOTMUX_SANDBOX;
    }
  });

  it('frozen snapshot scratch vs live oncall: the gate follows the FROZEN mode the fork will use', async () => {
    const plain = join(tempRoot, 'not-a-repo-frozen-scratch');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { sandbox: true }); // live: oncall
    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: 'scratch' },
    });
    expect(r.dir).toBe(plain);
  });

  it('session CLI snapshot decides the backend: a local CLI on a riff bot is NOT remote-exempt', async () => {
    // reconcileRiffBackendType: a remote backend only sticks when the CLI is the
    // remote CLI itself. A session whose own CLI is local resolves to a LOCAL
    // backend at fork, so the oncall sandbox applies there and the gate must
    // judge with the session's CLI, not the bot's.
    const plain = join(tempRoot, 'not-a-repo-riff-local-cli');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { cliId: 'riff', sandbox: true });
    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', sandboxSnapshot: { sandbox: true, cliId: 'claude-code' },
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('explicit force (/tw) keeps its own fail-closed contract (plain error, session stays pending) under oncall', async () => {
    const plain = join(tempRoot, 'forced-not-a-repo-sbx');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, false, { sandbox: true });
    const err = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', force: true, sandboxSnapshot: { sandbox: true },
    }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('fail-closed does NOT apply to the riff remote backend: sandbox on still DEGRADES', async () => {
    // The worker's sandboxRequested excludes riff (`!riffRemoteBackend` —
    // localSandboxApplies): riff has no local CLI process, the agent runs in
    // riff's own remote sandbox and its writes never touch the real local dir.
    // fail-closed must track that REAL sandbox state — refusing a riff session
    // on a worktree failure would brick a supported config (sandbox + riff) for
    // a local-escape rationale that does not exist there.
    const plain = join(tempRoot, 'not-a-repo-riff');
    mkdirSync(plain);
    // cliId 'riff' forces the riff backend through reconcileRiffBackendType.
    const { mod } = await loadWithBot(plain, true, { cliId: 'riff', sandbox: true });
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(plain); // degraded to the base dir — riff session still starts
    expect(notices.some(n => n.includes('回退'))).toBe(true); // fallback notice posted
    expect(notices.some(n => n.includes('沙盒已开启'))).toBe(false); // no fail-closed refusal
  });

  it('fail-closed does NOT apply to riff even with BOTMUX_SANDBOX=1 (env must not bypass the riff exemption)', async () => {
    // Regression: the BOTMUX_SANDBOX env check was short-circuiting OUTSIDE the
    // riff guard, so a riff bot + BOTMUX_SANDBOX=1 fail-closed on a worktree
    // failure — bricking a session the worker deliberately leaves unsandboxed
    // (sandboxRequested = !riffRemoteBackend && (... || BOTMUX_SANDBOX)). The
    // riff exemption must wrap the WHOLE union, env included.
    const plain = join(tempRoot, 'not-a-repo-riff-env');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { cliId: 'riff' }); // no sandbox flag
    process.env.BOTMUX_SANDBOX = '1';
    try {
      const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
        isBotDefaultDir: true, locale: 'zh',
      });
      expect(r.dir).toBe(plain); // degraded — riff session still starts
    } finally {
      delete process.env.BOTMUX_SANDBOX;
    }
  });

  it('fail-closed does NOT apply to a PROVABLY REMOTE mojo session (cloud on) — sandbox on still DEGRADES', async () => {
    // Regression (maintainer review): the fail-closed predicate only exempted
    // backend==='riff' and bricked a mojo {cloud:true} + sandbox bot on a
    // worktree failure, even though the worker applies NO local sandbox to a
    // provably-remote mojo session (localSandboxApplies → false). The gate now
    // reuses the worker's shared resolveLocalSandboxMode resolver.
    const plain = join(tempRoot, 'not-a-repo-mojo-remote');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', sandbox: true, mojo: { cloud: true },
    });
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(plain); // degraded — the remote mojo session still starts
    expect(notices.some(n => n.includes('回退'))).toBe(true); // fallback notice posted
    expect(notices.some(n => n.includes('沙盒已开启'))).toBe(false); // no fail-closed refusal
  });

  it('fail-closed does NOT apply to remote mojo even with BOTMUX_SANDBOX=1 (exemption wraps the whole union)', async () => {
    const plain = join(tempRoot, 'not-a-repo-mojo-remote-env');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', mojo: { cloud: true },
    });
    process.env.BOTMUX_SANDBOX = '1';
    try {
      const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
        isBotDefaultDir: true, locale: 'zh',
      });
      expect(r.dir).toBe(plain); // degraded — remote mojo session still starts
    } finally {
      delete process.env.BOTMUX_SANDBOX;
    }
  });

  it('fail-closed DOES apply to a LOCAL mojo session (cloud off) — the name alone must not exempt', async () => {
    // mojo is NOT unconditionally remote: without cloud:true the agent's tools
    // run on the bot host, so the local sandbox (and the fail-closed gate) must
    // stay engaged.
    const plain = join(tempRoot, 'not-a-repo-mojo-local');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', sandbox: true, mojo: {}, // no cloud → local execution
    });

    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh',
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('fail-closed DOES apply to mojo cloud when a top-level wrapperCli voids the remote proof', async () => {
    // The remote proof needs the SAME effective config the worker builds: a
    // top-level wrapperCli runs before the binary and can rewrite the env the
    // decision depends on, so it voids the cloud proof. A narrower snapshot
    // (mojo block only) would have missed this and skipped the local sandbox.
    const plain = join(tempRoot, 'not-a-repo-mojo-wrapper');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', sandbox: true, wrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo',
      mojo: { cloud: true },
    });

    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh',
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('fail-closed DOES apply to mojo cloud when the merged env voids the remote proof', async () => {
    // Same proof rule via the merged top-level/mojo env: any env key besides the
    // canonical JWT name can redirect execution (PATH / loader hooks), so it
    // voids the cloud proof and the local sandbox stays engaged.
    const plain = join(tempRoot, 'not-a-repo-mojo-env');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, {
      cliId: 'mojo', backendType: 'mojo', sandbox: true,
      mojo: { cloud: true, env: { MOJO_PROOF_TEST_VAR: 'x' } },
    });

    await expect(mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh',
    })).rejects.toBeInstanceOf(mod.AutoWorktreeFailClosedError);
  });

  it('apiOnly bot with NO explicit sandbox flag DEGRADES (no-transport sessions are no longer force-isolated)', async () => {
    // #899 removed forkWorker's forced readIsolation for a no-transport session
    // (apiOnly bot or HTTP virtual chat): disk read scope now follows the owner's
    // own sandbox config, symmetric with a normal chat session. The worker
    // therefore engages NO local sandbox here, so the fail-closed gate must not
    // refuse either — degrading to the base dir is safe (nothing to escape from).
    const plain = join(tempRoot, 'not-a-repo-apionly');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { apiOnly: true }); // no sandbox flag
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(plain); // degraded — no local sandbox would have engaged
    expect(notices.some(n => n.includes('回退'))).toBe(true);
  });

  it('HTTP virtual chat with NO explicit sandbox flag DEGRADES (no forced isolation)', async () => {
    // Same rule for a synthetic HTTP virtual chat (webhook / trigger session):
    // no forced readIsolation anymore, so no fail-closed refusal.
    const plain = join(tempRoot, 'not-a-repo-httpvirtual');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true); // no sandbox flag

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh',
    });

    expect(r.dir).toBe(plain); // degraded — no local sandbox would have engaged
  });

  it('fail-closed does NOT apply to apiOnly + riff (the remote exemption wraps the no-transport arm too)', async () => {
    // A no-transport session on a REMOTE backend still has no local CLI process,
    // so the remote exemption must wrap the no-transport arm as well — refusing
    // here would brick a supported config for a local-escape rationale that does
    // not exist on riff.
    const plain = join(tempRoot, 'not-a-repo-apionly-riff');
    mkdirSync(plain);
    const { mod } = await loadWithBot(plain, true, { cliId: 'riff', apiOnly: true });

    const r = await mod.maybeCreateDefaultWorktree('app_wt', plain, {
      isBotDefaultDir: true, locale: 'zh',
    });

    expect(r.dir).toBe(plain); // degraded — riff session still starts
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

/**
 * 话题指令头 `/repo wt <目标> [分支]` 的 git 腿复用 `/tw` 的 force 路径：force 让失败即抛
 * （fail closed，设计 R9），branch 让目录命名走 createRepoWorktree 的显式分支规则。
 */
describe('maybeCreateDefaultWorktree with force + explicit branch (header /repo wt)', () => {
  it('explicit branch → <repo>-<branch suffix> sibling dir, notices creating→created', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, false);
    const notices: string[] = [];

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh', force: true, branch: 'ci/temp_split', notify: (m) => { notices.push(m); },
    });

    expect(r.dir).toBe(join(tempRoot, 'proj-ci-temp_split'));
    expect(git(r.dir, 'branch', '--show-current')).toBe('ci/temp_split');
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('正在');
    expect(notices[1]).toContain(r.dir);
  });

  it('no branch → auto-named wt/… worktree (semantic slug when latin text is available)', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, false);

    const r = await mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh', force: true, title: 'bun version check',
    });

    expect(r.dir).toMatch(/proj-wt/);
    expect(git(r.dir, 'branch', '--show-current')).toMatch(/^wt\//);
  });

  it('target dir already taken → throws (fail closed, no fallback to the base dir)', async () => {
    const repo = makeRepo('proj');
    const { mod } = await loadWithBot(repo, false);
    mkdirSync(join(tempRoot, 'proj-feat-taken'));
    const notices: string[] = [];

    await expect(mod.maybeCreateDefaultWorktree('app_wt', repo, {
      isBotDefaultDir: true, locale: 'zh', force: true, branch: 'feat/taken', notify: (m) => { notices.push(m); },
    })).rejects.toThrow(/already exists/);
    // "creating…" then the raw error (force path notifies the error instead of a fallback line).
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('正在');
    expect(notices[1]).toMatch(/already exists/);
  });
});
