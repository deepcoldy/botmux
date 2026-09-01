/**
 * PATH entry written by both installers (`npm i -g` postinstall and install.sh).
 *
 * THE BUG THIS GUARDS: `npm i -g botmux` succeeded but left `botmux: command not
 * found`. There is no `bin` field any more, so the launcher at `~/.botmux/bin/botmux`
 * is the only `botmux` there is — and both installers merely PRINTED
 * `echo 'export PATH=…' >> ~/.profile`. **zsh never reads ~/.profile**, so a zsh
 * user who followed that hint verbatim got a silently-ignored file.
 *
 * The per-shell file choices below are measured, not recalled (see the module
 * header for the full matrix): zsh reads .zshenv in all three invocation modes;
 * bash's login (.bash_profile) and interactive (.bashrc) files are disjoint, so
 * both are needed; fish uses conf.d/*.fish and is not POSIX (`set -gx`).
 *
 * Run: npx vitest run test/install-path-entry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  detectShell,
  pathEntryTargets,
  fileAlreadyHasEntry,
  ensurePathEntry,
  PATH_ENTRY_MARKER,
} from '../scripts/install-path-entry.mjs';

let home: string;
let installDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bmx-path-'));
  installDir = join(home, '.botmux', 'bin');
  mkdirSync(installDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const rel = (f: string) => f.slice(home.length);

describe('detectShell', () => {
  it('reads the login shell from $SHELL', () => {
    expect(detectShell({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
    expect(detectShell({ SHELL: '/bin/dash' })).toBe('other');
    expect(detectShell({})).toBe('unknown');
  });

  it('matches versioned/prefixed shell paths', () => {
    expect(detectShell({ SHELL: '/opt/homebrew/bin/zsh-5.9' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/bin/bash' })).toBe('bash');
  });
});

describe('pathEntryTargets', () => {
  it('zsh gets .zshenv — the only file read by -c, -i AND -li alike', () => {
    const t = pathEntryTargets('zsh', installDir, home, {});
    expect(t.map(x => rel(x.file))).toEqual(['/.zshenv']);
    // NOT .profile: that is the exact bug being fixed.
    expect(t.map(x => rel(x.file))).not.toContain('/.profile');
  });

  it('bash gets BOTH .bashrc and a login file (login vs interactive are disjoint)', () => {
    const t = pathEntryTargets('bash', installDir, home, {});
    expect(t.map(x => rel(x.file))).toContain('/.bashrc');
    expect(t).toHaveLength(2);
  });

  /**
   * bash reads only the FIRST of .bash_profile → .bash_login → .profile. Creating
   * .bash_profile on a machine whose login config lives in .profile silently stops
   * that file from ever being read again — measured with a sentinel: visible to
   * `bash -lic` before, MISSING after. Fixing a PATH entry must not cost the user
   * their existing login config.
   */
  describe('bash login file is chosen without shadowing', () => {
    const loginTarget = () =>
      pathEntryTargets('bash', installDir, home, {}).map(x => rel(x.file)).find(f => f !== '/.bashrc');

    it('appends to .profile when that is the only login file present', () => {
      writeFileSync(join(home, '.profile'), 'export SENTINEL=yes\n');
      expect(loginTarget()).toBe('/.profile');
    });

    it('appends to .bash_login when that is the one present', () => {
      writeFileSync(join(home, '.bash_login'), 'export SENTINEL=yes\n');
      expect(loginTarget()).toBe('/.bash_login');
    });

    it('prefers .bash_profile when it exists (bash reads it first)', () => {
      writeFileSync(join(home, '.bash_profile'), '');
      writeFileSync(join(home, '.profile'), '');
      expect(loginTarget()).toBe('/.bash_profile');
    });

    it('creates .bash_profile only when none of the three exists (nothing to shadow)', () => {
      expect(loginTarget()).toBe('/.bash_profile');
    });

    it('never writes the same file twice', () => {
      writeFileSync(join(home, '.profile'), '');
      const files = pathEntryTargets('bash', installDir, home, {}).map(x => x.file);
      expect(new Set(files).size).toBe(files.length);
    });
  });

  it('fish gets conf.d/botmux.fish with NATIVE fish syntax, not POSIX export', () => {
    // Explicit env: the HOST may have XDG_CONFIG_HOME set (CI does), which would
    // legitimately relocate the file and make a hardcoded ~/.config path wrong.
    const t = pathEntryTargets('fish', installDir, home, {});
    expect(rel(t[0].file)).toBe('/.config/fish/conf.d/botmux.fish');
    expect(t[0].line).toContain('set -gx PATH');
    expect(t[0].line).not.toContain('export ');
  });

  it('unknown/other shells fall back to .profile', () => {
    for (const s of ['other', 'unknown']) {
      expect(rel(pathEntryTargets(s, installDir, home, {})[0].file)).toBe('/.profile');
    }
  });

  it('every generated line carries the installer marker and the install dir', () => {
    for (const s of ['zsh', 'bash', 'fish', 'other']) {
      for (const { line } of pathEntryTargets(s, installDir, home, {})) {
        expect(line).toContain(PATH_ENTRY_MARKER);
        expect(line).toContain(installDir);
      }
    }
  });
});

describe('ensurePathEntry', () => {
  it('creates the file when absent, and is idempotent on a second run', () => {
    const first = ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    expect(first.written.map(rel)).toEqual(['/.zshenv']);
    const body = readFileSync(join(home, '.zshenv'), 'utf8');
    expect(body).toContain(installDir);

    const second = ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    expect(second.written).toEqual([]);
    expect(second.skipped.map(rel)).toEqual(['/.zshenv']);
    // The file must not have grown a duplicate line.
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toBe(body);
  });

  it('appends without destroying existing content, and never glues onto an unterminated line', () => {
    // Deliberately NO trailing newline — the case that corrupts a naive append.
    writeFileSync(join(home, '.zshenv'), 'alias ll="ls -la"');
    ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    const lines = readFileSync(join(home, '.zshenv'), 'utf8').split('\n');
    expect(lines[0]).toBe('alias ll="ls -la"');
    expect(lines[1]).toContain(installDir);
  });

  it("respects a PATH line the user already wrote in their own style", () => {
    writeFileSync(join(home, '.zshenv'), `path+=(${installDir})\n`);
    const r = ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    expect(r.written).toEqual([]);
    expect(r.skipped.map(rel)).toEqual(['/.zshenv']);
  });

  it('a mention of the dir that is NOT a PATH line does not count as handled', () => {
    writeFileSync(join(home, '.zshenv'), `# I once installed things into ${installDir}\n`);
    expect(fileAlreadyHasEntry(join(home, '.zshenv'), installDir)).toBe(false);
    expect(ensurePathEntry({ installDir, home, shell: 'zsh', env: {} }).written.map(rel)).toEqual(['/.zshenv']);
  });

  it('reports a failure instead of throwing when the target cannot be written', () => {
    // A file where the parent dir must be — mkdir/append both fail, install must not.
    writeFileSync(join(home, '.config'), 'not a directory');
    const r = ensurePathEntry({ installDir, home, shell: 'fish', env: {} });
    expect(r.written).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].file).toContain('botmux.fish');
  });
});

/**
 * The payoff assertion: after writing, does the real shell actually FIND the
 * command? Anything short of this can pass while the user still sees
 * `command not found` — which is precisely how the original bug shipped.
 */
describe('the written file actually puts botmux on PATH (real shells)', () => {
  function fakeLauncher() {
    const p = join(installDir, 'botmux');
    writeFileSync(p, '#!/bin/sh\necho BOTMUX_OK\n', { mode: 0o755 });
    return p;
  }
  function have(bin: string): boolean {
    try { execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  /** Run `botmux` through a shell, with HOME pointed at the fixture. */
  function runIn(shell: string, args: string[]): string {
    // ⚠️ Do NOT spread process.env: the host's XDG_CONFIG_HOME / ZDOTDIR would come
    // along and send the shell looking somewhere other than where we wrote (CI sets
    // XDG_CONFIG_HOME, so this passed locally and failed there). Pass only what the
    // fixture defines.
    return execFileSync(shell, args, {
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
  }

  it('zsh finds it in non-interactive mode (scripts and ssh commands)', () => {
    if (!have('zsh')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    expect(runIn('zsh', ['-c', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('bash finds it in BOTH interactive and login mode', () => {
    if (!have('bash')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'bash' });
    // Two different startup files answer these two invocations; that is why the
    // implementation writes both.
    expect(runIn('bash', ['-ic', 'botmux'])).toContain('BOTMUX_OK');
    expect(runIn('bash', ['-lic', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('fish finds it (native syntax really evaluates)', () => {
    if (!have('fish')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'fish', env: {} });
    expect(runIn('fish', ['-c', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('bash keeps reading a pre-existing .profile (no shadowing) AND finds the command', () => {
    if (!have('bash')) return;
    // The exact failure mode: login config in .profile, no .bash_profile.
    writeFileSync(join(home, '.profile'), 'export SENTINEL_FROM_PROFILE=yes\n');
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'bash' });
    // Creating .bash_profile here would make this sentinel MISSING.
    expect(runIn('bash', ['-lic', 'echo "S=${SENTINEL_FROM_PROFILE:-MISSING}"'])).toContain('S=yes');
    expect(runIn('bash', ['-lic', 'botmux'])).toContain('BOTMUX_OK');
    expect(runIn('bash', ['-ic', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('a POSIX shell finds it via .profile', () => {
    if (!have('dash')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'other' });
    expect(runIn('dash', ['-lc', 'botmux'])).toContain('BOTMUX_OK');
  });
});

// install.sh must keep the same per-shell mapping as the .mjs above; if one is
// edited alone the two installers diverge and only one kind of user is fixed.
describe('install.sh stays in step with the shared module', () => {
  const sh = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

  /**
   * The body of one `case` branch of the shell dispatch, so an assertion is about
   * what that shell ACTUALLY writes.
   *
   * ⚠️ Do NOT weaken this back to `expect(sh).toContain('.zshenv')`: measured, a
   * mutation that points install.sh's zsh branch at `.profile` (the original bug,
   * reintroduced) still leaves the string `.zshenv` in the surrounding comments,
   * so `toContain` stays green — an assertion satisfied by both the correct and
   * the broken file has no teeth.
   */
  function caseBranch(pattern: string): string {
    const start = sh.search(new RegExp(`^\\s*${pattern}\\)`, 'm'));
    expect(start).toBeGreaterThan(-1);
    const rest = sh.slice(start);
    const end = rest.indexOf(';;');
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it('the zsh branch writes .zshenv, not .profile', () => {
    const branch = caseBranch('\\*zsh\\*');
    expect(branch).toContain('.zshenv');
    expect(branch).not.toContain('.profile');
  });

  it('the bash branch writes .bashrc plus a resolved login file', () => {
    const branch = caseBranch('\\*bash\\*');
    expect(branch).toContain('.bashrc');
    // The login half is resolved at runtime (see the shadowing test below), so a
    // literal .bash_profile must NOT appear here.
    expect(branch).toContain('bash_login_file');
  });

  it('the fish branch writes conf.d/botmux.fish using native fish syntax', () => {
    const branch = caseBranch('\\*fish\\*');
    expect(branch).toContain('conf.d/botmux.fish');
    expect(branch).toContain('set -gx PATH');
  });

  it('the bash branch resolves its login file instead of hardcoding .bash_profile', () => {
    const branch = caseBranch('\\*bash\\*');
    // Must go through the resolver; a literal $HOME/.bash_profile here would
    // shadow an existing .profile/.bash_login (see the module header).
    expect(branch).toContain('bash_login_file');
    expect(branch).not.toContain('$HOME/.bash_profile');
    expect(sh).toContain('bash_login_file()');
    // The resolver must consider all three, in bash's own order.
    const fn = sh.slice(sh.indexOf('bash_login_file()'));
    expect(fn.slice(0, 400)).toContain('.bash_login');
  });

  it('its idempotence check is per-LINE and quote-aware, not two independent greps', () => {
    const fn = sh.slice(sh.indexOf('path_line_present()'), sh.indexOf('bash_login_file()'));
    // (a) our own line is recognised by marker + the exact quoted dir …
    expect(fn).toContain('grep -F "$MARKER"');
    expect(fn).toContain('grep -Fq "$QUOTED_DIR"');
    // (b) … and a hand-written line by whole-token comparison, skipping comments.
    expect(fn).toContain('awk');
    expect(fn).toMatch(/\^\[\[:space:\]\]\*#/);
    // The old form ANDed two whole-file greps; that must not come back.
    expect(fn).not.toMatch(/grep -q "\$INSTALL_DIR"[^\n]*&&/);
    // Behaviour for all of this is covered by the end-to-end fixture below; these
    // assertions only stop a refactor from quietly deleting one of the two halves.
  });

  it('carries the same marker so the two installers recognise each other\'s line', () => {
    expect(sh).toContain(PATH_ENTRY_MARKER);
  });
});

void existsSync;

describe('the emitted PATH statement is idempotent at RUNTIME', () => {
  function have(bin: string): boolean {
    try { execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  }

  /**
   * Count how many times installDir appears in PATH after `depth` nested shells.
   *
   * ⚠️ The inner script MUST be single-quoted. Wrapping it in double quotes (e.g.
   * via JSON.stringify) lets the PARENT shell expand `$PATH` before the child ever
   * runs, so the number printed is the parent's snapshot and the probe reports 1 no
   * matter what — measured: with an unconditional prepend, the double-quoted form
   * gave 1 at depth 2 while the single-quoted form correctly gave 2 (and 3 at
   * depth 3). Nested shells DO re-read the rc file and DO keep growing PATH.
   */
  function occurrencesAtDepth(bin: string, flag: string, env: Record<string, string>, depth: number): number {
    // Build inside-out, quoting with single quotes at every level.
    let script = 'echo $PATH';
    for (let i = 1; i < depth; i++) {
      script = `${bin} ${flag} '${script.replace(/'/g, `'\\''`)}'`;
    }
    const out = execFileSync(bin, [flag, script], {
      env: { PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    return out.trim().split(':').filter(p => p === installDir).length;
  }

  function launcher() {
    writeFileSync(join(installDir, 'botmux'), '#!/bin/sh\necho BOTMUX_OK\n', { mode: 0o755 });
  }

  /**
   * Two independent ways the same defect shows up, both asserted:
   *
   *  · NESTED shells — each child re-reads the rc file, so an unconditional prepend
   *    grows PATH once per level (measured against the old form: 2 at depth 2, 3 at
   *    depth 3). See occurrencesAtDepth's note on why the inner script has to be
   *    single-quoted, or the parent expands `$PATH` first and the probe is blind.
   *  · RE-SOURCING inside ONE shell — the real-world case of a `.bash_profile` that
   *    also sources `.bashrc`, or any tool that re-reads your env.
   */
  it('zsh: one occurrence when .zshenv is re-sourced, and when nested', () => {
    if (!have('zsh')) return;
    launcher();
    ensurePathEntry({ installDir, home, shell: 'zsh', env: {} });
    const rc = join(home, '.zshenv');
    const out = execFileSync('zsh', [
      '-c', `source ${JSON.stringify(rc)}; source ${JSON.stringify(rc)}; echo "$PATH"`,
    ], { env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home }, encoding: 'utf8', timeout: 20_000 });
    expect(out.trim().split(':').filter(p => p === installDir)).toHaveLength(1);
    for (const depth of [1, 2, 3]) {
      expect(occurrencesAtDepth('zsh', '-c', { HOME: home, ZDOTDIR: home }, depth)).toBe(1);
    }
  }, 40_000);

  it('a POSIX shell: one occurrence when .profile is re-sourced, and when nested', () => {
    if (!have('dash')) return;
    launcher();
    ensurePathEntry({ installDir, home, shell: 'other', env: {} });
    const rc = join(home, '.profile');
    const out = execFileSync('dash', [
      '-lc', `. ${JSON.stringify(rc)}; . ${JSON.stringify(rc)}; echo "$PATH"`,
    ], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 20_000 });
    expect(out.trim().split(':').filter(p => p === installDir)).toHaveLength(1);
    for (const depth of [1, 2, 3]) {
      expect(occurrencesAtDepth('dash', '-lc', { HOME: home }, depth)).toBe(1);
    }
  }, 40_000);

  it('bash: one occurrence even though .bashrc AND the login file both carry it', () => {
    if (!have('bash')) return;
    launcher();
    ensurePathEntry({ installDir, home, shell: 'bash', env: {} });
    // A login bash reads the login file; if it also sources .bashrc the statement
    // runs twice in ONE shell — the guard has to hold for that too.
    writeFileSync(join(home, '.bash_profile'),
      `${readFileSync(join(home, '.bash_profile'), 'utf8')}\n. "$HOME/.bashrc"\n`);
    for (const depth of [1, 2]) {
      expect(occurrencesAtDepth('bash', '-lc', { HOME: home }, depth)).toBe(1);
    }
  }, 40_000);

  it('fish: one occurrence even when conf.d is sourced twice in one shell', () => {
    if (!have('fish')) return;
    launcher();
    ensurePathEntry({ installDir, home, shell: 'fish', env: {} });
    const conf = join(home, '.config', 'fish', 'conf.d', 'botmux.fish');
    // Sourcing the file twice in ONE shell is the sharpest probe here: 1 occurrence
    // with the `contains` guard, 3 without it (measured).
    const count = execFileSync('fish', [
      '-c', `source ${JSON.stringify(conf)}; source ${JSON.stringify(conf)}; for p in $PATH; echo $p; end`,
    ], {
      env: { PATH: '/usr/bin:/bin', HOME: home },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    }).trim().split('\n').filter(p => p === installDir).length;
    expect(count).toBe(1);
    expect(execFileSync('fish', ['-c', 'botmux'], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 20_000,
    })).toContain('BOTMUX_OK');
  }, 40_000);

  it('still prepends when the directory is NOT yet on PATH (positive control)', () => {
    if (!have('dash')) return;
    launcher();
    ensurePathEntry({ installDir, home, shell: 'other', env: {} });
    // Guard against "made it idempotent by never adding anything".
    expect(occurrencesAtDepth('dash', '-lc', { HOME: home }, 1)).toBe(1);
    expect(execFileSync('dash', ['-lc', 'botmux'], {
      env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 20_000,
    })).toContain('BOTMUX_OK');
  }, 40_000);

  it('a directory with shell metacharacters is still not executed', () => {
    if (!have('dash')) return;
    const evil = join(home, `d $(touch ${join(home, 'PWNED_RT')})`);
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'botmux'), '#!/bin/sh\necho BOTMUX_OK\n', { mode: 0o755 });
    ensurePathEntry({ installDir: evil, home, shell: 'other', env: {} });
    execFileSync('dash', ['-lc', 'true'], { env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 20_000 });
    expect(existsSync(join(home, 'PWNED_RT'))).toBe(false);
  }, 40_000);
});

/**
 * install.sh executed END-TO-END, offline.
 *
 * WHY A REAL RUN AND NOT MORE REGEX: this suite twice shipped a semantic drift
 * between install.sh and install-path-entry.mjs that every source-text assertion
 * missed — the two-independent-greps false positive, and awk's `-v` mangling of
 * the quoted spelling (`q'\''bin` arriving as `q'''bin`) which silently appended a
 * duplicate line on every re-install. Only running the script catches those, so
 * the shell half gets behavioural coverage of the same cases the .mjs half has.
 *
 * Offline by construction: fake `uname`/`ldd`/`curl` on PATH, so nothing is
 * downloaded and no network is touched.
 */
/**
 * The emitted STATEMENT has to be idempotent too, not only the file write.
 *
 * An unconditional `export PATH=<dir>:$PATH` re-prepends on every shell startup, so
 * nested shells — and a `.bash_profile` that sources `.bashrc` within one login —
 * keep growing PATH. Measured before the fix: the same directory appeared twice at
 * nesting depth 2. That is persistent environment pollution caused by us writing
 * the rc file, so it needs a real-shell regression, not a source assertion.
 */
describe('install.sh — executed end to end (offline fixture)', () => {
  /** Build a PATH containing only our fakes plus the real tools the script needs. */
  function fakeBinDir(root: string): string {
    const bin = join(root, 'fakebin');
    mkdirSync(bin, { recursive: true });
    const write = (name: string, body: string) => {
      const p = join(bin, name);
      writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    write('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac');
    // Claim glibc so the script does not pick the -musl asset.
    write('ldd', 'echo "ldd (GNU libc) 2.36"');
    // `curl -fSL <url> -o <file>` writes a stand-in binary; the .sha256 fetch fails
    // (exit 1) so the script takes its documented "no checksum published" path.
    write('curl', [
      'out=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
      'case "$url" in *.sha256) exit 1 ;; esac',
      '[ -n "$out" ] || exit 1',
      'printf "#!/bin/sh\\nif [ \\\"${BOTMUX_FIXTURE_BINARY_FAIL:-}\\\" = true ]; then echo GLIBC_2.34-not-found >&2; exit 42; fi\\necho BOTMUX_OK\\n" > "$out"',
    ].join('\n'));
    return bin;
  }

  function runInstaller(opts: {
    home: string;
    shell: string;
    installDir: string;
    env?: Record<string, string>;
  }): { status: number | null; stdout: string; stderr: string } {
    const bin = fakeBinDir(opts.home);
    const r = execFileSync('/bin/sh', [join(__dirname, '..', 'install.sh')], {
      env: {
        // A deliberately minimal environment: only what the script may rely on.
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: opts.home,
        SHELL: opts.shell,
        BOTMUX_INSTALL_DIR: opts.installDir,
        ...opts.env,
      },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    return { status: 0, stdout: r, stderr: '' };
  }

  function runIn(shell: string, args: string[], env: Record<string, string>): string {
    return execFileSync(shell, args, {
      env: { PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
  }

  it('installs the binary and makes zsh find it — honouring $ZDOTDIR', () => {
    if (!existsSync('/usr/bin/zsh')) return;
    const zdot = join(home, 'zdot');
    mkdirSync(zdot, { recursive: true });
    runInstaller({ home, shell: '/usr/bin/zsh', installDir, env: { ZDOTDIR: zdot } });

    // The PATH line must land in $ZDOTDIR/.zshenv, NOT $HOME/.zshenv.
    expect(existsSync(join(zdot, '.zshenv'))).toBe(true);
    expect(existsSync(join(home, '.zshenv'))).toBe(false);
    expect(runIn('/usr/bin/zsh', ['-c', 'botmux'], { HOME: home, ZDOTDIR: zdot })).toContain('BOTMUX_OK');
  });

  it('probes before replacement and preserves an existing binary on failure', () => {
    const installed = join(installDir, 'botmux');
    writeFileSync(installed, '#!/bin/sh\necho PREVIOUS_WORKING_BOTMUX\n', { mode: 0o755 });
    const bin = fakeBinDir(home);
    const r = spawnSync('/bin/sh', [join(__dirname, '..', 'install.sh')], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/dash',
        BOTMUX_INSTALL_DIR: installDir, BOTMUX_FIXTURE_BINARY_FAIL: 'true',
      },
      encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cannot run on this host');
    expect(execFileSync(installed, { encoding: 'utf8' })).toContain('PREVIOUS_WORKING_BOTMUX');
  });

  it('makes fish find it — honouring $XDG_CONFIG_HOME, with fish syntax', () => {
    if (!existsSync('/usr/bin/fish')) return;
    const xdg = join(home, 'xdg');
    mkdirSync(xdg, { recursive: true });
    runInstaller({ home, shell: '/usr/bin/fish', installDir, env: { XDG_CONFIG_HOME: xdg } });

    const conf = join(xdg, 'fish', 'conf.d', 'botmux.fish');
    expect(existsSync(conf)).toBe(true);
    expect(readFileSync(conf, 'utf8')).toContain('set -gx PATH');
    expect(runIn('/usr/bin/fish', ['-c', 'botmux'], { HOME: home, XDG_CONFIG_HOME: xdg })).toContain('BOTMUX_OK');
  });

  it('does not shadow an existing .profile for bash, and works in both modes', () => {
    if (!existsSync('/bin/bash')) return;
    writeFileSync(join(home, '.profile'), 'export SENTINEL_FROM_PROFILE=yes\n');
    runInstaller({ home, shell: '/bin/bash', installDir });

    // Creating .bash_profile here would make the sentinel unreachable.
    expect(existsSync(join(home, '.bash_profile'))).toBe(false);
    expect(runIn('/bin/bash', ['-lic', 'echo "S=${SENTINEL_FROM_PROFILE:-MISSING}"'], { HOME: home }))
      .toContain('S=yes');
    expect(runIn('/bin/bash', ['-lic', 'botmux'], { HOME: home })).toContain('BOTMUX_OK');
    expect(runIn('/bin/bash', ['-ic', 'botmux'], { HOME: home })).toContain('BOTMUX_OK');
  });

  it('is idempotent — a second install leaves the rc file byte-identical', () => {
    runInstaller({ home, shell: '/bin/dash', installDir });
    const after1 = readFileSync(join(home, '.profile'), 'utf8');
    runInstaller({ home, shell: '/bin/dash', installDir });
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(after1);
    expect((after1.match(/added by botmux installer/g) ?? [])).toHaveLength(1);
  });

  it('is idempotent for an install dir containing a single quote', () => {
    // The case awk's `-v` mangling broke: the written line is shell-quoted, so the
    // raw bytes are absent from the file and a naive check re-appends every run.
    const quoted = join(home, "q'bin");
    mkdirSync(quoted, { recursive: true });
    runInstaller({ home, shell: '/bin/dash', installDir: quoted });
    runInstaller({ home, shell: '/bin/dash', installDir: quoted });
    const body = readFileSync(join(home, '.profile'), 'utf8');
    expect((body.match(/added by botmux installer/g) ?? [])).toHaveLength(1);
    // …and the quoting must still work: sh resolves the command.
    expect(runIn('/bin/dash', ['-lc', 'botmux'], { HOME: home })).toContain('BOTMUX_OK');
  });

  it('is idempotent when BOTMUX_INSTALL_DIR carries a trailing slash', () => {
    runInstaller({ home, shell: '/bin/dash', installDir: `${installDir}/` });
    runInstaller({ home, shell: '/bin/dash', installDir: `${installDir}/` });
    const body = readFileSync(join(home, '.profile'), 'utf8');
    expect((body.match(/added by botmux installer/g) ?? [])).toHaveLength(1);
  });

  it('preserves an existing rc file that lacks a trailing newline', () => {
    writeFileSync(join(home, '.profile'), 'alias ll="ls -la"');   // no newline
    runInstaller({ home, shell: '/bin/dash', installDir });
    const lines = readFileSync(join(home, '.profile'), 'utf8').split('\n');
    expect(lines[0]).toBe('alias ll="ls -la"');
    expect(lines[1]).toContain(installDir);
  });

  it('does not execute shell syntax present in the install dir', () => {
    // The command-injection case: the line we write is evaluated on every startup.
    const evil = join(home, 'dir $(touch ' + join(home, 'PWNED') + ')');
    mkdirSync(evil, { recursive: true });
    runInstaller({ home, shell: '/bin/dash', installDir: evil });
    runIn('/bin/dash', ['-lc', 'true'], { HOME: home });
    expect(existsSync(join(home, 'PWNED'))).toBe(false);
  });

  /**
   * The RUNTIME idempotence guard has to hold for the shell installer too.
   * Without this, reverting install.sh's statement to an unconditional prepend
   * leaves the whole runtime group green (measured) — the .mjs tests all go through
   * ensurePathEntry and never touch install.sh.
   */
  it('the statement it writes is idempotent at runtime (POSIX, re-sourced)', () => {
    if (!existsSync('/bin/dash')) return;
    runInstaller({ home, shell: '/bin/dash', installDir });
    // Re-sourcing in ONE shell is asserted alongside nesting: it is the real-world
    // `.bash_profile` sources `.bashrc` case, and it stays discriminating regardless
    // of how the nested probe is quoted.
    const rc = join(home, '.profile');
    const out = runIn('/bin/dash', [
      '-lc', `. ${JSON.stringify(rc)}; . ${JSON.stringify(rc)}; echo "$PATH"`,
    ], { HOME: home });
    expect(out.trim().split(':').filter(p => p === installDir)).toHaveLength(1);
    // …and nesting must still be clean.
    // Single quotes: a double-quoted inner script would let this shell expand $PATH.
    const nested = runIn('/bin/dash', ['-lc', "/bin/dash -lc 'echo $PATH'"], { HOME: home });
    expect(nested.trim().split(':').filter(p => p === installDir)).toHaveLength(1);
  }, 40_000);

  it('the statement it writes is idempotent at runtime (fish, double source)', () => {
    if (!existsSync('/usr/bin/fish')) return;
    const xdg = join(home, 'xdg');
    mkdirSync(xdg, { recursive: true });
    runInstaller({ home, shell: '/usr/bin/fish', installDir, env: { XDG_CONFIG_HOME: xdg } });
    const conf = join(xdg, 'fish', 'conf.d', 'botmux.fish');
    // Source it twice in one shell — the sharpest probe for this guard (see the
    // .mjs counterpart for the measured numbers).
    const out = runIn('/usr/bin/fish', [
      '-c', `source ${JSON.stringify(conf)}; source ${JSON.stringify(conf)}; for p in $PATH; echo $p; end`,
    ], { HOME: home, XDG_CONFIG_HOME: xdg });
    expect(out.trim().split('\n').filter(p => p === installDir)).toHaveLength(1);
  }, 40_000);

  it('adds the entry when only a SIBLING directory is on PATH', () => {
    // `<installDir>-old` must not count as configured — otherwise the real
    // directory is never added and the command stays missing.
    writeFileSync(join(home, '.profile'), `export PATH="${installDir}-old:$PATH"\n`);
    runInstaller({ home, shell: '/bin/dash', installDir });
    const body = readFileSync(join(home, '.profile'), 'utf8');
    expect((body.match(/added by botmux installer/g) ?? [])).toHaveLength(1);
  });

  it('adds a working line back when OUR OWN generated line was commented out', () => {
    // The marker is still on the line, so a marker-based fast path that forgets to
    // skip comments reports "configured" and never restores a working entry —
    // measured: install.sh left 0 active PATH lines while the .mjs half said false.
    writeFileSync(join(home, '.profile'),
      `# export PATH='${installDir}'":$PATH"  ${PATH_ENTRY_MARKER}\n`);
    runInstaller({ home, shell: '/bin/dash', installDir });
    const active = readFileSync(join(home, '.profile'), 'utf8')
      .split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain(installDir);
    expect(runIn('/bin/dash', ['-lc', 'botmux'], { HOME: home })).toContain('BOTMUX_OK');
  });

  it('does not duplicate when our own generated line is present and ACTIVE', () => {
    // Positive control for the test above: the marker fast path must still work.
    runInstaller({ home, shell: '/bin/dash', installDir });
    const once = readFileSync(join(home, '.profile'), 'utf8');
    runInstaller({ home, shell: '/bin/dash', installDir });
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(once);
  });

  it('recognises a user line that differs only by a trailing slash', () => {
    // Exercises the awk half's normalisation: dir passed WITH a trailing slash,
    // the user's existing entry written WITHOUT one (or vice versa).
    writeFileSync(join(home, '.profile'), `export PATH="${installDir}:$PATH"\n`);
    const before = readFileSync(join(home, '.profile'), 'utf8');
    runInstaller({ home, shell: '/bin/dash', installDir: `${installDir}/` });
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(before);
  });

  it('leaves the file alone when the directory is ALREADY on PATH', () => {
    // Positive control for the two tests above: the predicate must still be able
    // to say "already configured", or it would just always append.
    writeFileSync(join(home, '.profile'), `export PATH="${installDir}:$PATH"\n`);
    const before = readFileSync(join(home, '.profile'), 'utf8');
    runInstaller({ home, shell: '/bin/dash', installDir });
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe(before);
  });
});
