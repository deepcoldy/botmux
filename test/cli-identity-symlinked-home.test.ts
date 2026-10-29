/**
 * A sandboxed session on a host whose home is a symlink (`/home/u` ->
 * `/data00/home/u`) used to get identity helper paths written in the LEXICAL
 * form. The bwrap root only mounts canonical paths, so inside the sandbox
 * `GIT_ASKPASS`, git's `credential.<host>.helper`, the wrapper-script bodies and
 * the login-shell shim all pointed at a path that does not exist
 * (`botmux-git-askpass: not found`, then `could not read Username`).
 *
 * The fix names those paths by realpath for sandboxed sessions. It must NOT be
 * done by mounting the home alias: the end-to-end case below asserts the helper
 * runs while the rest of the home (an ssh key) stays invisible. The same rule
 * covers the runner argv embedded in the trigger-user wrappers (proven model)
 * and in the managed lark-cli wrapper.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import type { FsPolicy } from '../src/adapters/cli/fs-policy.js';
import {
  GIT_ASKPASS_BASENAME,
  canonicalPathNearest,
  prepareTriggerUserCliEnv,
  publishActiveTurn,
  sessionIdentityBinDir,
  sessionVisiblePath,
  writeSessionIdentity,
} from '../src/core/cli-identity.js';
import { prepareLarkToolEnv } from '../src/core/lark-tool-binding.js';

const SESSION = 'sess-symlink-home';
const HOST = 'code.example.test';
const POLICY = { enabled: true, tools: ['bytedcli' as const], fallback: 'none' as const, gitHost: HOST };

const linux = process.platform === 'linux';
const canRunBwrap = linux && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;

interface Layout {
  root: string;
  /** Canonical home (the `/data00/home/u` side). */
  home: string;
  /** Symlink to `home` (the `/home/u` side). */
  alias: string;
  lexicalDataDir: string;
  canonicalDataDir: string;
  stubBin: string;
}

let layout: Layout;

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-symlink-home-')));
  const home = join(root, 'real', 'home');
  const alias = join(root, 'alias');
  const canonicalDataDir = join(home, '.botmux', 'data');
  const stubBin = join(home, '.local', 'bin');
  mkdirSync(canonicalDataDir, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE-KEY');
  writeFileSync(
    join(stubBin, 'bytedcli'),
    '#!/bin/sh\nprintf \'{"status":"ok","data":{"jwt":"%s"}}\' "$BYTEDCLI_USER_CLOUD_JWT"\n',
    { mode: 0o755 },
  );
  symlinkSync(home, alias);
  layout = {
    root, home, alias, canonicalDataDir, stubBin,
    lexicalDataDir: join(alias, '.botmux', 'data'),
  };
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

function prepare(canonicalPaths: boolean, model: 'single' | 'proven' = 'single'): NodeJS.ProcessEnv {
  // PATH names the stub through the alias, as a login shell on such a host would.
  const env: NodeJS.ProcessEnv = {
    PATH: `${join(layout.alias, '.local', 'bin')}:/usr/bin:/bin`,
  };
  prepareTriggerUserCliEnv(
    env, layout.lexicalDataDir, SESSION, POLICY, () => {}, model,
    model === 'proven' ? { appId: 'cli_test', ipcPort: 4242 } : undefined,
    { canonicalPaths },
  );
  return env;
}

/**
 * Managed lark-cli wrapper for this session, its runner reached through the
 * alias. The stub runner only runs if its entry (the second argv slot) is
 * readable, so inside a sandbox both the command AND the args have to be
 * visible.
 */
function prepareLark(canonicalPaths: boolean): { env: NodeJS.ProcessEnv; wrapper: string } {
  writeFileSync(join(layout.stubBin, 'lark-runner'), [
    '#!/bin/sh',
    '[ "$1" = --entry ] && [ -r "$2" ] || { echo "runner entry unreadable: $2" >&2; exit 7; }',
    'shift 2',
    'echo "lark-runner $*"',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(layout.stubBin, 'lark-runner-entry.js'), '');
  const viaAlias = join(layout.alias, '.local', 'bin');
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
  prepareLarkToolEnv({
    env, dataDir: layout.lexicalDataDir, sessionId: SESSION, appId: 'cli_test', canonicalPaths,
    runner: { command: join(viaAlias, 'lark-runner'), args: ['--entry', join(viaAlias, 'lark-runner-entry.js')] },
  });
  return { env, wrapper: readFileSync(join(env.BOTMUX_IDENTITY_BIN!, 'lark-cli'), 'utf8') };
}

function sessionPaths(env: NodeJS.ProcessEnv): Record<string, string> {
  const config = Object.entries(env)
    .filter(([key]) => key.startsWith('GIT_CONFIG_VALUE_'))
    .map(([, value]) => value as string);
  return {
    SESSION_DATA_DIR: env.SESSION_DATA_DIR!,
    BOTMUX_IDENTITY_BIN: env.BOTMUX_IDENTITY_BIN!,
    ZDOTDIR: env.ZDOTDIR!,
    BASH_ENV: env.BASH_ENV!,
    GIT_ASKPASS: env.GIT_ASKPASS!,
    PATH_HEAD: env.PATH!.split(':')[0],
    credentialHelper: config[0],
  };
}

describe('trigger-user identity paths on a symlinked home', () => {
  it('sandboxed sessions get realpath helper paths in env and in generated scripts', () => {
    const env = prepare(true);
    const binDir = sessionIdentityBinDir(layout.canonicalDataDir, SESSION);
    for (const [name, value] of Object.entries(sessionPaths(env))) {
      expect(value, name).not.toContain(layout.alias);
    }
    expect(env.SESSION_DATA_DIR).toBe(layout.canonicalDataDir);
    expect(env.BOTMUX_IDENTITY_BIN).toBe(binDir);
    expect(env.ZDOTDIR).toBe(join(binDir, 'shell'));
    expect(env.BASH_ENV).toBe(join(binDir, 'shell', 'bash_env.sh'));
    expect(env.GIT_ASKPASS).toBe(join(binDir, GIT_ASKPASS_BASENAME));
    expect(env.GIT_CONFIG_VALUE_0).toContain(`"${join(binDir, GIT_ASKPASS_BASENAME)}"`);

    const askpass = readFileSync(env.GIT_ASKPASS!, 'utf8');
    expect(askpass).toContain(join(binDir, 'bytedcli'));
    const wrapper = readFileSync(join(binDir, 'bytedcli'), 'utf8');
    expect(wrapper).toContain(join(layout.stubBin, 'bytedcli'));
    for (const body of [askpass, wrapper]) expect(body).not.toContain(layout.alias);
  });

  it('writes the proven-model resolver data dir by realpath', () => {
    if (!linux) return;
    prepare(true, 'proven');
    const wrapper = readFileSync(join(sessionIdentityBinDir(layout.canonicalDataDir, SESSION), 'bytedcli'), 'utf8');
    expect(wrapper).toContain(`'--data-dir' '${layout.canonicalDataDir}'`);
    expect(wrapper).not.toContain(layout.alias);
  });

  it('keeps the lexical form for unsandboxed sessions (nothing changes there)', () => {
    const env = prepare(false);
    const binDir = sessionIdentityBinDir(layout.lexicalDataDir, SESSION);
    expect(env.SESSION_DATA_DIR).toBe(layout.lexicalDataDir);
    expect(env.GIT_ASKPASS).toBe(join(binDir, GIT_ASKPASS_BASENAME));
    expect(env.BOTMUX_IDENTITY_BIN).toBe(binDir);
  });

  it('is a no-op when the home is not a symlink', () => {
    const plain = (flag: boolean) => {
      const env: NodeJS.ProcessEnv = { PATH: `${layout.stubBin}:/usr/bin:/bin` };
      prepareTriggerUserCliEnv(env, layout.canonicalDataDir, SESSION, POLICY, () => {}, 'single', undefined,
        { canonicalPaths: flag });
      return env;
    };
    expect(plain(true)).toEqual(plain(false));
  });

  it('canonicalPathNearest resolves the deepest existing ancestor', () => {
    expect(canonicalPathNearest(join(layout.alias, '.botmux', 'data', 'not', 'yet')))
      .toBe(join(layout.canonicalDataDir, 'not', 'yet'));
  });

  it('writes the proven-model runner by realpath even when the runtime is reached through a symlink', () => {
    if (!linux) return;
    // Node and Bun on Linux already report execPath by realpath (/proc/self/exe),
    // so stand the runtime behind an alias the way a symlinked home would.
    const runtime = realpathSync(process.execPath);
    const runtimeAlias = join(layout.root, 'runtime-alias');
    symlinkSync(dirname(runtime), runtimeAlias);
    const saved = process.execPath;
    process.execPath = join(runtimeAlias, basename(runtime));
    // Both forms name the same directory, so read each wrapper before the next write.
    const wrapperFor = (canonicalPaths: boolean) => {
      prepare(canonicalPaths, 'proven');
      return readFileSync(join(sessionIdentityBinDir(layout.canonicalDataDir, SESSION), 'bytedcli'), 'utf8');
    };
    let sandboxed: string, unsandboxed: string;
    try {
      sandboxed = wrapperFor(true);
      unsandboxed = wrapperFor(false);
    } finally {
      process.execPath = saved;
    }
    expect(sandboxed).toContain(`__botmux_cred_body=$('${runtime}' `);
    expect(sandboxed).not.toContain(runtimeAlias);
    expect(unsandboxed).toContain(`__botmux_cred_body=$('${join(runtimeAlias, basename(runtime))}' `);
  });
});

describe('sessionVisiblePath', () => {
  it('names an absolute path by realpath only for sandboxed sessions', () => {
    const viaAlias = join(layout.alias, '.local', 'bin', 'bytedcli');
    expect(sessionVisiblePath(viaAlias, true)).toBe(join(layout.stubBin, 'bytedcli'));
    expect(sessionVisiblePath(join(layout.alias, '.botmux', 'data', 'not', 'yet'), true))
      .toBe(join(layout.canonicalDataDir, 'not', 'yet'));
    expect(sessionVisiblePath(viaAlias, false)).toBe(viaAlias);
    expect(sessionVisiblePath(viaAlias, undefined)).toBe(viaAlias);
  });

  it('leaves flags and relative paths of a runner argv untouched', () => {
    // Resolving these would anchor them to the worker's cwd.
    for (const arg of ['--import', '--no-warnings', 'relative/path', '']) {
      expect(sessionVisiblePath(arg, true), arg).toBe(arg);
    }
    expect(canonicalPathNearest('relative/path')).toBe('relative/path');
  });
});

describe('managed lark-cli wrapper on a symlinked home', () => {
  it('names the runner command and args by realpath for sandboxed sessions', () => {
    const { wrapper } = prepareLark(true);
    expect(wrapper).toContain(
      `exec '${join(layout.stubBin, 'lark-runner')}' '--entry' '${join(layout.stubBin, 'lark-runner-entry.js')}' '--binding' `);
    expect(wrapper).not.toContain(layout.alias);
  });

  it('keeps the runner as given for unsandboxed sessions', () => {
    const viaAlias = join(layout.alias, '.local', 'bin');
    expect(prepareLark(false).wrapper).toContain(
      `exec '${join(viaAlias, 'lark-runner')}' '--entry' '${join(viaAlias, 'lark-runner-entry.js')}' '--binding' `);
  });
});

describe.skipIf(!canRunBwrap)('identity helper inside a bwrap root that only mounts canonical paths', () => {
  function policyFor(env: NodeJS.ProcessEnv): FsPolicy {
    // Mirrors what the worker grants: this session's identity dir and the real
    // tool's directory, by canonical path. Nothing under the home root.
    return {
      rules: [
        ...['/usr', '/etc', realpathSync(env.BOTMUX_IDENTITY_BIN!), layout.stubBin]
          .map(path => ({ path, access: 'readOnly' as const, source: 'internal' as const })),
        { path: join(layout.root, 'work'), access: 'readWrite' as const, source: 'internal' as const },
      ],
      net: true,
      writeRegexes: [],
    };
  }

  function runInSandbox(env: NodeJS.ProcessEnv, script: string) {
    mkdirSync(join(layout.root, 'work'), { recursive: true });
    const plan = prepareDirectSandbox({
      sessionId: SESSION,
      dataDir: layout.lexicalDataDir,
      policy: policyFor(env),
      chdir: join(layout.root, 'work'),
      home: layout.home,
      cliBin: '/bin/sh',
      cliArgs: ['-c', script],
    });
    expect(plan).not.toBeNull();
    try {
      const out = spawnSync(plan!.bin, plan!.args, { env: { ...process.env, ...plan!.env, ...env }, encoding: 'utf8' });
      return { out, args: plan!.args };
    } finally {
      plan!.cleanup();
      // The sandbox masks a directory with mode 000; restore before rmSync.
      const empty = join(layout.canonicalDataDir, 'sandboxes', SESSION, 'empties');
      if (existsSync(empty)) { try { chmodSync(empty, 0o700); } catch { /* best effort */ } }
    }
  }

  const askpassCall = (env: NodeJS.ProcessEnv, prompt: string) => {
    // Exactly how git runs the configured helper: through `sh -c`.
    const helper = env.GIT_CONFIG_VALUE_0!.replace(/^!/, '');
    return `${helper} '${prompt}'`;
  };

  it('reproduces the failure with lexical paths, and is fixed by realpath paths', () => {
    const lexical = prepare(false);
    const broken = runInSandbox(lexical, askpassCall(lexical, 'Username for https://x'));
    expect(broken.out.status).not.toBe(0);
    expect(broken.out.stderr).toMatch(/not found|No such file/);
    rmSync(sessionIdentityBinDir(layout.lexicalDataDir, SESSION), { recursive: true, force: true });

    const env = prepare(true);
    writeSessionIdentity(layout.canonicalDataDir, SESSION, { tool: 'bytedcli', cloudJwt: 'user-jwt', turnId: 't1' });
    publishActiveTurn(layout.canonicalDataDir, SESSION, 't1');
    const fixed = runInSandbox(env,
      `${askpassCall(env, 'Username for https://x')}; echo; export BOTMUX_SESSION_ID=${SESSION}; ${askpassCall(env, 'Password for https://x')}`);
    expect(fixed.out.stderr).toBe('');
    expect(fixed.out.status).toBe(0);
    expect(fixed.out.stdout).toBe('x-access-token\nuser-jwt');
  });

  it('runs the managed lark-cli runner only when its argv is named by realpath', () => {
    const lexical = prepareLark(false);
    const broken = runInSandbox(lexical.env, `"${lexical.env.BOTMUX_IDENTITY_BIN}/lark-cli" --version`);
    expect(broken.out.status).not.toBe(0);
    expect(broken.out.stderr).toMatch(/not found|No such file/);

    const { env } = prepareLark(true);
    const fixed = runInSandbox(env, `"${env.BOTMUX_IDENTITY_BIN}/lark-cli" --version`);
    expect(fixed.out.stderr).toBe('');
    expect(fixed.out.status).toBe(0);
    expect(fixed.out.stdout).toBe(`lark-runner --binding ${env.BOTMUX_LARK_TOOL_BINDING} -- --version\n`);
  });

  it('does not widen the readable set: the home root and ssh key stay invisible', () => {
    const env = prepare(true);
    const { out, args } = runInSandbox(env, [
      `test -x "${env.GIT_ASKPASS}"`,
      `test ! -e "${join(layout.alias, '.ssh', 'id_rsa')}"`,
      `test ! -e "${join(layout.home, '.ssh', 'id_rsa')}"`,
      `test ! -e "${layout.alias}"`,
    ].join(' && '));
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);

    const binds = args.flatMap((arg, i) =>
      ['--bind', '--ro-bind', '--bind-try', '--ro-bind-try'].includes(arg) ? [args[i + 1]] : []);
    for (const forbidden of [layout.home, layout.alias, join(layout.home, '.ssh'), layout.root, layout.canonicalDataDir]) {
      expect(binds, forbidden).not.toContain(forbidden);
    }
    // The alias is not re-created either: no `--symlink` lands under the home.
    const symlinkDests = args.flatMap((arg, i) => (arg === '--symlink' ? [args[i + 2]] : []));
    for (const dest of symlinkDests) expect(dest.startsWith(layout.root), dest).toBe(false);
  });
});
