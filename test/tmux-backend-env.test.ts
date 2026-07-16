/**
 * Tests for TmuxBackend's shell-wrapped CLI launch.
 *
 * The design (see tmux-backend.ts spawn() else branch):
 *   tmux new-session ... -- <shell> <shellFlags> -c <SCRIPT> _ <cwd> KEY=VAL... bin args...
 *
 * Goal: give the CLI an environment that matches "user opens a terminal and
 * runs the CLI by hand" — PATH / NVM / PNPM / mise / etc. come from the
 * user's rcfile loaded by the chosen shell, not from daemon process.env
 * passthrough. The only env injected by botmux is the per-bot/per-session
 * minimum (the namespaced BOTMUX_LARK_APP_ID, BOTMUX marker, SESSION_DATA_DIR,
 * IS_SANDBOX, owner open_id), injected via `/usr/bin/env KEY=VAL` so the values
 * land AFTER rcfile load and override any same-named exports the user has.
 * The bot's bare LARK_APP_* are deliberately NOT injected — the worker redacts
 * them so a child CLI's own Lark OAuth isn't hijacked (see redactChildEnv).
 *
 * SCRIPT also `cd`s back to the requested cwd before exec, so a stray `cd`
 * in the user's rcfile doesn't drag the CLI's working directory away.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBotmuxEnvAssignments,
  buildDebugKeepShellScript,
  DIAGNOSTIC_SHELL_SCRIPT,
  resolveUserShell,
  resolveShellOverride,
  SHELL_WRAPPER_SCRIPT,
} from '../src/adapters/backend/tmux-backend.js';

describe('buildBotmuxEnvAssignments()', () => {
  it('forwards only the daemon-side keys; bare LARK_APP_* are NOT forwarded', () => {
    const out = buildBotmuxEnvAssignments({
      // Bare creds must never reach the child — the worker redacts them
      // (redactChildEnv) and they are not on the allowlist either.
      LARK_APP_ID: 'cli_abc',
      LARK_APP_SECRET: 'secret',
      __OWNER_OPEN_ID: 'ou_x',
      BOTMUX: '1',
      SESSION_DATA_DIR: '/home/u/.botmux/data',
      IS_SANDBOX: '1',
      BOTMUX_LARK_APP_ID: 'cli_namespaced',
      BOTMUX_TURN_ID: 'om_turn',
      // None of the rest should appear — those come from rcfile.
      PATH: '/usr/bin',
      HOME: '/home/u',
      NVM_BIN: '/home/u/.nvm/versions/node/v20/bin',
      HTTP_PROXY: 'http://proxy:8080',
      LANG: 'en_US.UTF-8',
    });
    expect(out).toEqual([
      '__OWNER_OPEN_ID=ou_x',
      'BOTMUX=1',
      'SESSION_DATA_DIR=/home/u/.botmux/data',
      'IS_SANDBOX=1',
      'BOTMUX_LARK_APP_ID=cli_namespaced',
      'BOTMUX_TURN_ID=om_turn',
    ]);
    expect(out.some(s => s.startsWith('LARK_APP_ID='))).toBe(false);
    expect(out.some(s => s.startsWith('LARK_APP_SECRET='))).toBe(false);
  });

  it('forwards CLAUDE_CODE_RESUME_TOKEN_THRESHOLD so the resume-summary bypass reaches the tmux pane (issue #62)', () => {
    // The worker injects this for claude-code to suppress Claude Code 2.1.x's
    // blocking resume-summary menu. Under the tmux backend it ONLY reaches the
    // CLI if it's allowlisted here — `...process.env` passthrough is dead.
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '2147483647',
      PATH: '/usr/bin',
    });
    expect(out).toContain('CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=2147483647');
    expect(out).not.toContain('PATH=/usr/bin');
  });

  it('forwards CJADK_INTERACTIVE so cjadk runs non-interactive in the tmux pane', () => {
    // The worker injects CJADK_INTERACTIVE=0 for `cjadk <agent>` wrapperCli
    // launches (mirrors cjadk's own `cjadk feishu` wrapper). Like every other
    // injected key it ONLY reaches the pane via this allowlist — without it the
    // pane inherits an interactive cjadk (startup selector + input quirks).
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      CJADK_INTERACTIVE: '0',
      PATH: '/usr/bin',
    });
    expect(out).toContain('CJADK_INTERACTIVE=0');
    // Non-cjadk bots don't set it → it must not appear.
    expect(buildBotmuxEnvAssignments({ BOTMUX: '1' }).some(s => s.startsWith('CJADK_INTERACTIVE='))).toBe(false);
  });

  it('forwards list-bots API discovery flags so CLI bots list matches daemon behavior', () => {
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      BOTMUX_LARK_LIST_BOTS_API_ENABLED: 'true',
      BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS: '3000',
      PATH: '/usr/bin',
    });
    expect(out).toContain('BOTMUX_LARK_LIST_BOTS_API_ENABLED=true');
    expect(out).toContain('BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS=3000');
    expect(out).not.toContain('PATH=/usr/bin');
  });

  it('forwards BOTMUX_READY_COMMAND so Hermes can release the first-prompt ready gate', () => {
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      BOTMUX_READY_COMMAND: '"/usr/local/bin/node" "/opt/botmux/dist/cli.js" session-ready',
      PATH: '/usr/bin',
    });
    expect(out).toContain('BOTMUX_READY_COMMAND="/usr/local/bin/node" "/opt/botmux/dist/cli.js" session-ready');
    expect(out).not.toContain('PATH=/usr/bin');
  });

  it('forwards Hermes profile paths so the pane and transcript reader use the same state DB', () => {
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      HERMES_HOME: '/profiles/current',
      HERMES_BOTMUX_SOURCE_HOME: '/profiles/source',
      HERMES_BOTMUX_PROFILES_ROOT: '/profiles/root',
      BOTMUX_HERMES_STATE_DB: '/unsupported/state.db',
    });
    expect(out).toContain('HERMES_HOME=/profiles/current');
    expect(out).toContain('HERMES_BOTMUX_SOURCE_HOME=/profiles/source');
    expect(out).toContain('HERMES_BOTMUX_PROFILES_ROOT=/profiles/root');
    expect(out).not.toContain('BOTMUX_HERMES_STATE_DB=/unsupported/state.db');
  });

  it('skips entries whose value is undefined (e.g. IS_SANDBOX outside root mode)', () => {
    const out = buildBotmuxEnvAssignments({
      BOTMUX: '1',
      BOTMUX_LARK_APP_ID: 'cli_x',
      IS_SANDBOX: undefined,
    });
    expect(out).toEqual(['BOTMUX=1', 'BOTMUX_LARK_APP_ID=cli_x']);
    expect(out.every(s => !s.endsWith('=undefined'))).toBe(true);
  });

  it('does NOT forward arbitrary env even when set (PATH, HTTP_PROXY, ...)', () => {
    const out = buildBotmuxEnvAssignments({
      PATH: '/should/not/leak',
      HTTP_PROXY: 'http://should/not/leak',
      LANG: 'should-not-leak',
      BOTMUX: 'kept',
    });
    expect(out).toEqual(['BOTMUX=kept']);
  });

  it('preserves values with spaces, quotes, equals, newlines (argv array, no shell parsing)', () => {
    const out = buildBotmuxEnvAssignments({
      SESSION_DATA_DIR: 'with space',
      BOTMUX_LARK_APP_ID: 'has=equals=in=value',
      __OWNER_OPEN_ID: `it's "tricky"`,
      BOTMUX: 'line1\nline2',
    });
    expect(out).toContain('SESSION_DATA_DIR=with space');
    expect(out).toContain('BOTMUX_LARK_APP_ID=has=equals=in=value');
    expect(out).toContain(`__OWNER_OPEN_ID=it's "tricky"`);
    expect(out).toContain('BOTMUX=line1\nline2');
  });

  it('returns [] for undefined env (no spawn-opts env passed)', () => {
    expect(buildBotmuxEnvAssignments(undefined)).toEqual([]);
  });

  it('never emits massive argv even with a thousand-entry process.env (Codex check #4)', () => {
    const huge: NodeJS.ProcessEnv = {};
    for (let i = 0; i < 1000; i++) huge[`USER_VAR_${i}`] = 'x'.repeat(200);
    huge.SESSION_DATA_DIR = '/d';
    huge.BOTMUX = '1';
    const out = buildBotmuxEnvAssignments(huge);
    expect(out).toEqual(['BOTMUX=1', 'SESSION_DATA_DIR=/d']);
  });

  it('never forwards the bot bare LARK_APP_ID / LARK_APP_SECRET, even with real values', () => {
    // Defense-in-depth: the bare creds are off the allowlist, so even if a real
    // value somehow reaches opts.env the tmux wrapper won't inject it. (The
    // worker also deletes them up front — see redactChildEnv.) The namespaced
    // BOTMUX_LARK_APP_ID IS still injected — botmux subcommands need it.
    const out = buildBotmuxEnvAssignments({
      LARK_APP_ID: 'cli_real_bot_app',
      LARK_APP_SECRET: 'real_secret',
      BOTMUX: '1',
      BOTMUX_LARK_APP_ID: 'cli_namespaced',
      BOTMUX_SESSION_ID: 'sess_xxx',
      SESSION_DATA_DIR: '/d',
    });
    expect(out.some(s => s.startsWith('LARK_APP_ID='))).toBe(false);
    expect(out.some(s => s.startsWith('LARK_APP_SECRET='))).toBe(false);
    expect(out).toContain('BOTMUX=1');
    expect(out).toContain('BOTMUX_LARK_APP_ID=cli_namespaced');
    expect(out).toContain('BOTMUX_SESSION_ID=sess_xxx');
    expect(out).toContain('SESSION_DATA_DIR=/d');
  });

  // ── Per-bot env (bots.json `env`) injected via the 2nd arg ──────────────────
  it('appends per-bot injectEnv AFTER the botmux-managed keys (so it wins last)', () => {
    const out = buildBotmuxEnvAssignments(
      { BOTMUX: '1', SESSION_DATA_DIR: '/d' },
      { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'glm-key' },
    );
    expect(out).toEqual([
      'BOTMUX=1',
      'SESSION_DATA_DIR=/d',
      'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic',
      'ANTHROPIC_AUTH_TOKEN=glm-key',
    ]);
  });

  it('forwards per-bot injectEnv even when there is no botmux-managed env at all', () => {
    expect(buildBotmuxEnvAssignments(undefined, { OPENAI_BASE_URL: 'https://x/v1' }))
      .toEqual(['OPENAI_BASE_URL=https://x/v1']);
    expect(buildBotmuxEnvAssignments({}, { HTTPS_PROXY: 'http://127.0.0.1:7890' }))
      .toEqual(['HTTPS_PROXY=http://127.0.0.1:7890']);
  });

  it('re-sanitizes injectEnv: drops botmux-reserved keys even if they sneak in', () => {
    const out = buildBotmuxEnvAssignments(
      { BOTMUX: '1' },
      {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        BOTMUX_SESSION_ID: 'hijack',     // reserved → dropped
        LARK_APP_SECRET: 's',            // reserved → dropped
        CLAUDE_CONFIG_DIR: '/tmp/evil',  // reserved → dropped
        'BAD-NAME': 'x',                 // invalid name → dropped
      },
    );
    expect(out).toEqual(['BOTMUX=1', 'ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic']);
  });

  it('no injectEnv arg leaves output identical to the legacy whitelist-only behavior', () => {
    expect(buildBotmuxEnvAssignments({ BOTMUX: '1', SESSION_DATA_DIR: '/d' }))
      .toEqual(['BOTMUX=1', 'SESSION_DATA_DIR=/d']);
  });
});

describe('resolveUserShell()', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('returns bash-flavoured spec (-i only, NO -l) when $SHELL is bash', () => {
    // Codex Blocker 1: bash -l does NOT auto-source .bashrc. Many users only
    // have nvm/fnm/pnpm hooks in .bashrc, so we use -i alone to ensure .bashrc
    // loads regardless of whether their .bash_profile sources it.
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const fake = join(tmpDir, 'bash');
    writeFileSync(fake, '#!/bin/sh\nexec "$@"\n');
    chmodSync(fake, 0o755);
    const spec = resolveUserShell({ SHELL: fake });
    expect(spec.shell).toBe(fake);
    expect(spec.flags).toEqual(['-i']);
    expect(spec.flags).not.toContain('-l');
  });

  it('returns zsh-flavoured spec (-l -i) when $SHELL is zsh', () => {
    // zsh login reads .zprofile/.zlogin; interactive reads .zshrc. Need both.
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const fake = join(tmpDir, 'zsh');
    writeFileSync(fake, '#!/bin/sh\nexec "$@"\n');
    chmodSync(fake, 0o755);
    const spec = resolveUserShell({ SHELL: fake });
    expect(spec.shell).toBe(fake);
    expect(spec.flags).toEqual(['-l', '-i']);
  });

  it('returns sh-flavoured spec (no rcfile flags) when $SHELL is plain sh', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const fake = join(tmpDir, 'sh');
    writeFileSync(fake, '#!/bin/sh\nexec "$@"\n');
    chmodSync(fake, 0o755);
    const spec = resolveUserShell({ SHELL: fake });
    expect(spec.shell).toBe(fake);
    expect(spec.flags).toEqual([]);
  });

  it('Codex Blocker 2: falls back to a POSIX shell when $SHELL is fish', () => {
    // Our SCRIPT is POSIX-syntax. fish/nu/csh would mis-parse `cd -- "$1"`
    // and `exec /usr/bin/env "$@"` and break the launch. Detect non-POSIX
    // shells and fall back so fish/nu users don't get a totally dead session.
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const fakeFish = join(tmpDir, 'fish');
    writeFileSync(fakeFish, '#!/bin/sh\nexec "$@"\n');
    chmodSync(fakeFish, 0o755);
    const spec = resolveUserShell({ SHELL: fakeFish });
    expect(spec.shell).not.toBe(fakeFish);
    // Whatever we picked must be a known POSIX shell that exists.
    expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(spec.shell);
    expect(existsSync(spec.shell)).toBe(true);
  });

  it('falls back through /bin/zsh → /bin/bash → /bin/sh when $SHELL is unset', () => {
    const spec = resolveUserShell({});
    expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(spec.shell);
    expect(existsSync(spec.shell)).toBe(true);
    if (spec.shell === '/bin/zsh') expect(spec.flags).toEqual(['-l', '-i']);
    else if (spec.shell === '/bin/bash') expect(spec.flags).toEqual(['-i']);
    else expect(spec.flags).toEqual([]);
  });

  it('skips $SHELL when the path is not executable and walks the fallback list', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const bogus = join(tmpDir, 'not-executable');
    writeFileSync(bogus, 'not a real shell');
    chmodSync(bogus, 0o644);
    const spec = resolveUserShell({ SHELL: bogus });
    expect(spec.shell).not.toBe(bogus);
    expect(['/bin/zsh', '/bin/bash', '/bin/sh']).toContain(spec.shell);
  });

  it('launchShell override (absolute path) wins over $SHELL', () => {
    // The escape hatch for a login $SHELL whose rcfile exec-trampolines into
    // another shell: pinning launchShell launches the CLI under it directly.
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const bash = join(tmpDir, 'bash');
    const zsh = join(tmpDir, 'zsh');
    writeFileSync(bash, '#!/bin/sh\nexec "$@"\n'); chmodSync(bash, 0o755);
    writeFileSync(zsh, '#!/bin/sh\nexec "$@"\n'); chmodSync(zsh, 0o755);
    const spec = resolveUserShell({ SHELL: bash }, zsh);
    expect(spec.shell).toBe(zsh);
    expect(spec.flags).toEqual(['-l', '-i']);  // zsh-flavoured, not bash's ['-i']
  });

  it('falls back to $SHELL when the launchShell override is not found/executable', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const bash = join(tmpDir, 'bash');
    writeFileSync(bash, '#!/bin/sh\nexec "$@"\n'); chmodSync(bash, 0o755);
    const spec = resolveUserShell({ SHELL: bash }, '/no/such/zsh');
    expect(spec.shell).toBe(bash);
    expect(spec.flags).toEqual(['-i']);
  });
});

describe('resolveShellOverride()', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined; }
  });

  it('resolves an absolute path and classifies its flags', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const zsh = join(tmpDir, 'zsh');
    writeFileSync(zsh, '#!/bin/sh\nexec "$@"\n'); chmodSync(zsh, 0o755);
    const spec = resolveShellOverride(zsh);
    expect(spec?.shell).toBe(zsh);
    expect(spec?.flags).toEqual(['-l', '-i']);
  });

  it('resolves a bare name from the conventional locations (or null if absent)', () => {
    // bash/sh exist on essentially every CI image; assert the spec is sane when found.
    const spec = resolveShellOverride('sh');
    if (spec) {
      expect(spec.shell.endsWith('/sh')).toBe(true);
      expect(spec.flags).toEqual([]);
    }
  });

  it('returns null for a non-existent override and for a blank string', () => {
    expect(resolveShellOverride('/no/such/shell-xyz')).toBeNull();
    expect(resolveShellOverride('   ')).toBeNull();
  });

  it('returns null (ignored) for an unsupported shell like fish', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bmx-shell-'));
    const fish = join(tmpDir, 'fish');
    writeFileSync(fish, '#!/bin/sh\nexec "$@"\n'); chmodSync(fish, 0o755);
    expect(resolveShellOverride(fish)).toBeNull();
  });
});

describe('buildDebugKeepShellScript()', () => {
  it('keeps the wrapper alive after the CLI exits (no `exec` on env)', () => {
    const s = buildDebugKeepShellScript('/bin/zsh');
    // Critical: there must NOT be `exec /usr/bin/env` in the debug variant —
    // otherwise the CLI would replace the shell process and the user would
    // lose the prompt we promised them.
    expect(s).not.toMatch(/\bexec\s+\/usr\/bin\/env/);
    expect(s).toMatch(/\/usr\/bin\/env "\$@"/);
    // After the CLI runs, must hand off to an interactive shell.
    expect(s).toMatch(/exec '\/bin\/zsh' -i$/);
  });

  it('preserves the cd-back-to-cwd guard from the normal script', () => {
    const s = buildDebugKeepShellScript('/bin/bash');
    expect(s).toMatch(/^cd -- "\$1" && shift/);
  });

  it('emits a clear banner so the user knows the CLI exited, not crashed', () => {
    const s = buildDebugKeepShellScript('/bin/sh');
    expect(s).toContain('[botmux debug]');
    expect(s).toContain('Type exit to close the session');
    // status code should be surfaced so a non-zero exit is obvious.
    expect(s).toContain('status %d');
    expect(s).toContain('"$?"');
  });

  it('single-quotes the shell path safely even when it contains apostrophes', () => {
    // We don't expect this in practice, but `accessSync` doesn't reject it and
    // a malformed single-quote in the embedded SCRIPT would make the wrapper
    // line desync. The escape pattern `'\\''` (close-quote, escaped quote,
    // reopen-quote) is the standard POSIX way to embed a single quote.
    const s = buildDebugKeepShellScript(`/weird/shell/with'apostrophe`);
    expect(s).toContain(`'/weird/shell/with'\\''apostrophe'`);
  });
});

describe('debug keep-shell wrapper end-to-end', () => {
  // Validates the debug script's behaviour using a real shell: a fake CLI
  // exits with a known code, the wrapper banner appears, and a follow-up
  // interactive shell command can still execute. This is what the user gets
  // when they run with BOTMUX_DEBUG_KEEP_SHELL=1.
  const hasEnvBin = existsSync('/usr/bin/env');

  it.skipIf(!hasEnvBin)(
    'after CLI exits, the wrapper hands off to interactive shell with banner',
    () => {
      // We can't easily verify a true interactive shell from spawnSync (it
      // needs a tty), but we CAN verify the script structure with `sh -n`
      // (syntax-check) and that the CLI-stage portion runs to completion.
      const script = buildDebugKeepShellScript('/bin/sh');
      // Syntax-check the script in /bin/sh — guards against typos in the
      // template that no test of buildDebugKeepShellScript alone would catch.
      const syntaxCheck = spawnSync('/bin/sh', ['-n', '-c', script], {
        encoding: 'utf-8',
      });
      expect(syntaxCheck.status).toBe(0);
      expect(syntaxCheck.stderr).toBe('');

      // Now run a non-interactive version where the trailing `exec sh -i`
      // is replaced by a probe — proves cd / env-injection / banner all work.
      const probeScript = script.replace(`exec '/bin/sh' -i`, 'echo PROBE-RAN');
      const result = spawnSync(
        '/bin/sh',
        ['-c', probeScript, '_',
          tmpdir(),               // $1 cwd
          'BOTMUX=1',              // env injection
          '/bin/sh', '-c', 'exit 7',  // fake CLI exiting non-zero
        ],
        { encoding: 'utf-8' },
      );
      expect(result.status).toBe(0);             // wrapper itself succeeds
      expect(result.stderr).toContain('[botmux debug]');
      expect(result.stderr).toContain('status 7'); // surfaced fake CLI exit
      expect(result.stdout).toContain('PROBE-RAN');
    },
  );
});

describe('diagnostic shell wrapper', () => {
  const hasEnvBin = existsSync('/usr/bin/env');

  it('keeps a shell alive after printing the preserved output', () => {
    expect(DIAGNOSTIC_SHELL_SCRIPT).toContain('cat -- "$2"');
    expect(DIAGNOSTIC_SHELL_SCRIPT).toContain('Auto-restart is paused');
    expect(DIAGNOSTIC_SHELL_SCRIPT).toMatch(/exec "\$3" -i$/);
  });

  it.skipIf(!hasEnvBin)(
    'prints the diagnostic file and then hands off to the shell',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'bmx-diag-'));
      try {
        const diag = join(dir, 'diag.ansi');
        writeFileSync(diag, 'startup failed\nmissing token\n');
        const probeScript = DIAGNOSTIC_SHELL_SCRIPT.replace('exec "$3" -i', 'echo DIAG-SHELL-READY');
        const result = spawnSync(
          '/bin/sh',
          ['-c', probeScript, '_', dir, diag, '/bin/sh'],
          { encoding: 'utf-8', env: { HOME: dir, PATH: '/usr/bin:/bin' } },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('startup failed');
        expect(result.stdout).toContain('missing token');
        expect(result.stdout).toContain('DIAG-SHELL-READY');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('shell wrapper end-to-end (the contract spawn() builds)', () => {
  // These tests exercise the full wrapper invocation shape using real shells,
  // independent of tmux. If any of these fail, spawning a CLI inside tmux
  // will fail the same way.

  const envBin = '/usr/bin/env';
  const hasEnvBin = existsSync(envBin);
  const hasBash = existsSync('/bin/bash');
  const SCRIPT = SHELL_WRAPPER_SCRIPT;

  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it.skipIf(!hasEnvBin)(
    'env(1) injection lands AFTER rcfile would have run (per-bot overrides survive)',
    () => {
      const cwd = tmpdir();
      // Wrapper script also cd's to $1, so cwd has to be a real dir.
      const result = spawnSync(
        '/bin/sh',
        ['-c', SCRIPT, '_',
          cwd,
          'BOTMUX_LARK_APP_ID=fresh',
          'SESSION_DATA_DIR=fresh-dir',
          '/usr/bin/env',
        ],
        { encoding: 'utf-8', env: { BOTMUX_LARK_APP_ID: 'stale', SESSION_DATA_DIR: 'stale-dir', PATH: '/usr/bin:/bin' } },
      );
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines).toContain('BOTMUX_LARK_APP_ID=fresh');
      expect(lines).toContain('SESSION_DATA_DIR=fresh-dir');
      expect(lines).not.toContain('BOTMUX_LARK_APP_ID=stale');
    },
  );

  it.skipIf(!hasEnvBin)(
    'wrapper unsets bare LARK_APP_* / CLAUDECODE inherited from the ambient env',
    () => {
      // The new tmux pane inherits the tmux *server* global env, which the
      // redacted client env cannot override (Codex's 2nd blocker). The wrapper
      // `unset`s the bare creds before exec so the CLI never sees them — here
      // we feed them via the spawn env, exactly as an inherited value would
      // appear. The OLD wrapper (no unset) would leak all three.
      const cwd = tmpdir();
      const result = spawnSync(
        '/bin/sh',
        ['-c', SCRIPT, '_', cwd, 'BOTMUX_LARK_APP_ID=ns', '/usr/bin/env'],
        { encoding: 'utf-8', env: {
          LARK_APP_ID: 'inherited_id',
          LARK_APP_SECRET: 'inherited_secret',
          CLAUDECODE: '1',
          PATH: '/usr/bin:/bin',
        } },
      );
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines.some(l => l.startsWith('LARK_APP_ID='))).toBe(false);
      expect(lines.some(l => l.startsWith('LARK_APP_SECRET='))).toBe(false);
      expect(lines.some(l => l.startsWith('CLAUDECODE='))).toBe(false);
      expect(lines).toContain('BOTMUX_LARK_APP_ID=ns');
    },
  );

  it.skipIf(!hasEnvBin)(
    'wrapper clears every stale managed value before injecting this pane values',
    () => {
      const cwd = tmpdir();
      const result = spawnSync(
        '/bin/sh',
        ['-c', SCRIPT, '_', cwd,
          '__OWNER_OPEN_ID=ou_fresh',
          'BOTMUX_SESSION_ID=fresh-session',
          'BOTMUX_CHAT_ID=fresh-chat',
          '/usr/bin/env',
        ],
        { encoding: 'utf-8', env: {
          __OWNER_OPEN_ID: 'ou_stale',
          BOTMUX_SESSION_ID: 'stale-session',
          BOTMUX_CHAT_ID: 'stale-chat',
          IS_SANDBOX: '1',
          CLAUDE_CONFIG_DIR: '/stale/claude',
          CODEX_HOME: '/stale/codex',
          HERMES_HOME: '/stale/hermes',
          HERMES_BOTMUX_SOURCE_HOME: '/stale/hermes-source',
          HERMES_BOTMUX_PROFILES_ROOT: '/stale/hermes-profiles',
          PATH: '/usr/bin:/bin',
          HOME: '/tmp',
        } },
      );
      expect(result.status).toBe(0);
      const lines = result.stdout.split('\n');
      expect(lines).toContain('__OWNER_OPEN_ID=ou_fresh');
      expect(lines).toContain('BOTMUX_SESSION_ID=fresh-session');
      expect(lines).toContain('BOTMUX_CHAT_ID=fresh-chat');
      for (const key of [
        'IS_SANDBOX', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME',
        'HERMES_BOTMUX_SOURCE_HOME', 'HERMES_BOTMUX_PROFILES_ROOT',
      ]) {
        expect(lines.some(line => line.startsWith(`${key}=`)), key).toBe(false);
      }
    },
  );

  const hasTmux = !spawnSync('tmux', ['-V']).error;
  it.skipIf(!hasEnvBin || !hasTmux)(
    'tmux child does NOT inherit bare LARK_APP_* from a server started with them in scope (Codex repro)',
    () => {
      // End-to-end: start a tmux server that already has bare creds in its
      // global env (the pre-upgrade / user-shell case), then create a new
      // session through the real wrapper with a redacted client env. The pane
      // must not see the server's bare creds.
      const sock = `bmx-test-${process.pid}`;
      const outFile = join(tmpdir(), `bmx-pane-env-${process.pid}.txt`);
      // tmux refuses nested sessions when $TMUX is set — strip it.
      const baseEnv = { ...process.env }; delete baseEnv.TMUX; delete baseEnv.TMUX_PANE;
      try {
        // 1) Server started WITH bare creds in scope.
        spawnSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 'holder', 'sleep 60'],
          { env: { ...baseEnv, LARK_APP_ID: 'server_id', LARK_APP_SECRET: 'server_secret', CLAUDECODE: '1' } });
        // 2) New session via the wrapper with a redacted client env; the "CLI"
        //    dumps its env then signals completion so the test stays sync.
        const clientEnv = { ...baseEnv };
        delete clientEnv.LARK_APP_ID; delete clientEnv.LARK_APP_SECRET; delete clientEnv.CLAUDECODE;
        spawnSync('tmux', ['-L', sock, 'new-session', '-d', '-s', 'probe',
          '/bin/sh', '-c', SCRIPT, '_', tmpdir(), 'BOTMUX_LARK_APP_ID=ns',
          '/bin/sh', '-c', `env > ${outFile}; tmux -L ${sock} wait-for -S bmxdone`],
          { env: clientEnv });
        spawnSync('tmux', ['-L', sock, 'wait-for', 'bmxdone'], { timeout: 10_000 });
        const paneEnv = readFileSync(outFile, 'utf-8').split('\n');
        expect(paneEnv.some(l => l.startsWith('LARK_APP_ID='))).toBe(false);
        expect(paneEnv.some(l => l.startsWith('LARK_APP_SECRET='))).toBe(false);
        expect(paneEnv.some(l => l.startsWith('CLAUDECODE='))).toBe(false);
        expect(paneEnv).toContain('BOTMUX_LARK_APP_ID=ns');
      } finally {
        spawnSync('tmux', ['-L', sock, 'kill-server']);
        rmSync(outFile, { force: true });
      }
    },
  );

  it.skipIf(!hasEnvBin)(
    'args with spaces / quotes / newlines reach the CLI verbatim (no shell escaping)',
    () => {
      const tricky = 'with space "and quotes" `backticks` $vars';
      const result = spawnSync(
        '/bin/sh',
        ['-c', SCRIPT, '_',
          tmpdir(),
          'BOTMUX=1',
          '/bin/sh', '-c', 'printf "%s\\n" "$@"', '_',
          tricky,
          'line1\nline2',
        ],
        { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${tricky}\nline1\nline2\n`);
    },
  );

  it.skipIf(!hasBash || !hasEnvBin)(
    'Codex Blocker 1: bash with -i (no -l) loads .bashrc so a nvm/pnpm-style PATH is picked up',
    () => {
      // Plant a fake "node" in tmpdir, set HOME to a temp dir whose .bashrc
      // prepends that dir to PATH, and confirm `/usr/bin/env node` resolves
      // to our planted one. Pre-fix wrapper used `bash -l -i` which doesn't
      // source .bashrc unless .bash_profile does, breaking this exact path.
      tmpDir = mkdtempSync(join(tmpdir(), 'bmx-bashrc-'));
      const home = tmpDir;
      const fakeBin = join(home, 'bin');
      writeFileSync(join(home, '.bashrc'),
        `export PATH="${fakeBin}:$PATH"\n` +
        `echo loaded-bashrc 1>&2\n`,
      );
      // No .bash_profile / .bash_login / .profile — so -l would NOT load .bashrc.
      // -i alone must still pick it up.
      const fakeBinDir = fakeBin;
      const { mkdirSync, writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
      mkdirSync(fakeBinDir, { recursive: true });
      wf(join(fakeBinDir, 'node'), '#!/bin/sh\necho fake-node-was-found\n');
      chmodSync(join(fakeBinDir, 'node'), 0o755);

      const result = spawnSync(
        '/bin/bash',
        ['-i', '-c', SCRIPT, '_',
          home,
          'BOTMUX=1',
          '/usr/bin/env', 'node',
        ],
        { encoding: 'utf-8', env: { HOME: home, PATH: '/usr/bin:/bin' } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('fake-node-was-found');
      expect(result.stderr).toContain('loaded-bashrc');
    },
  );

  it.skipIf(!hasEnvBin)(
    'Codex non-blocker: rcfile that cd\'s away does NOT change the CLI\'s final cwd',
    () => {
      // Build a wrapper invocation that emulates "rcfile cd'd to /tmp", then
      // asserts the script's `cd -- "$1"` puts us back where botmux asked.
      const target = mkdtempSync(join(tmpdir(), 'bmx-cwd-'));
      try {
        // Use sh to emulate a rcfile that cd's. The wrapper SCRIPT cd's first
        // anyway, so we hand-roll the equivalent: pre-cd somewhere wrong, then
        // run the wrapper. The wrapper's `cd -- "$1"` must override.
        const result = spawnSync(
          '/bin/sh',
          ['-c',
            // Pretend rcfile cd'd to /tmp; then invoke our wrapper.
            `cd /tmp && /bin/sh -c '${SCRIPT}' _ "$@"`,
            '_',
            target,                       // $1 inside wrapper
            'BOTMUX=1',
            '/bin/sh', '-c', 'pwd', '_',
          ],
          { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } },
        );
        expect(result.status).toBe(0);
        // realpath because mkdtemp under /tmp may resolve to /private/tmp on macOS.
        const realpathSync = (require('node:fs') as typeof import('node:fs')).realpathSync;
        expect(realpathSync(result.stdout.trim())).toBe(realpathSync(target));
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    },
  );
});
