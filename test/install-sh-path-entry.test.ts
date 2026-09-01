import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * install.sh (the `curl … | sh` installer) — writing the PATH entry.
 *
 * WHY THIS FILE EXISTS: since #1047 the npm package has no `bin` field, so the
 * launcher at `$INSTALL_DIR/botmux` is the ONLY `botmux` command there is. If no
 * startup file puts that directory on PATH, a fully successful install still
 * leaves the user with `botmux: command not found` — and, because the installer
 * exits 0 and prints nothing, with no indication of why.
 *
 * The bug this file pins: the block used to be wrapped in
 *
 *     case ":$PATH:" in *":$INSTALL_DIR:"*) : ;;   # already on PATH
 *
 * which asks whether the directory is on the PATH of the process RUNNING the
 * installer. What decides whether `botmux` works is whether the user's FUTURE
 * shells get it — a property of their startup files, not of this process. botmux
 * itself drives the two apart: the daemon prepends `~/.botmux/bin` to the PATH of
 * every CLI session it spawns, so installing from inside a botmux session hit the
 * skip branch and wrote nothing at all. Same defect as #1117 on the npm side.
 *
 * These tests EXECUTE the real block extracted from install.sh against an isolated
 * HOME. Asserting on the script's text instead would pass just as happily with the
 * logic deleted — and, more to the point, the old code was textually reasonable;
 * only its BEHAVIOUR under a pre-seeded PATH was wrong.
 */
const INSTALL_SH = resolve(import.meta.dirname, '../install.sh');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'botmux-install-path-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface RunOpts {
  /** Put INSTALL_DIR on the PATH of the installing process (the regression case). */
  dirAlreadyOnPath?: boolean;
  /** `$SHELL` basename the installer dispatches on. */
  shell?: string;
  /** Pre-existing files in the fake HOME, as relative path → contents. */
  seed?: Record<string, string>;
  /**
   * Like `seed`, but the contents are built from the (per-run, temporary)
   * INSTALL_DIR. Needed for the "user already added this directory themselves"
   * case: a literal seed cannot name a directory that does not exist yet.
   */
  seedWithInstallDir?: Record<string, (installDir: string) => string>;
  /** Run the block twice in the same HOME (idempotency). */
  twice?: boolean;
}

interface RunResult {
  status: number;
  stdout: string;
  /** Relative path → contents, for every file in the fake HOME. */
  files: Record<string, string>;
  installDir: string;
}

/**
 * Extract install.sh's PATH-writing section — the two helpers it calls, the
 * quoting it depends on, and the section itself — and run it with a controlled
 * HOME, SHELL and PATH.
 *
 * Extraction is anchored on shell-syntax landmarks (function definitions, the
 * `sq=`…`QUOTED_DIR=` pair) rather than on comment text, so rewording a comment
 * cannot silently empty the harness. `assertHarnessIsWellFormed` then proves the
 * pieces actually arrived: without it, "no files written" would be produced both
 * by the bug AND by a broken extraction, and the two are indistinguishable.
 */
function runPathBlock(opts: RunOpts = {}): RunResult {
  const base = tmp();
  const home = join(base, 'home');
  const installDir = join(base, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  for (const [rel, contents] of Object.entries(opts.seed ?? {})) {
    const target = join(home, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  for (const [rel, build] of Object.entries(opts.seedWithInstallDir ?? {})) {
    const target = join(home, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, build(installDir));
  }

  const src = readFileSync(INSTALL_SH, 'utf-8');
  const lines = src.split('\n');
  const lineIndex = (re: RegExp, what: string): number => {
    const i = lines.findIndex(l => re.test(l));
    expect(i, `install.sh must still contain ${what}`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const section = (startRe: RegExp, endRe: RegExp): string => {
    const from = lineIndex(startRe, String(startRe));
    const rel = lines.slice(from + 1).findIndex(l => endRe.test(l));
    expect(rel, `install.sh must still contain ${endRe} after ${startRe}`).toBeGreaterThanOrEqual(0);
    return lines.slice(from, from + rel + 2).join('\n');
  };

  // ⚠️ THE TAIL MUST BE TAKEN WHOLE, from the end of the last helper to EOF.
  // An earlier version of this harness started at `posix_line=`, which made the
  // tests BLIND to the very bug they exist for: a gate placed ABOVE that line
  // (exactly where the original `case ":$PATH:"` sat) simply was not extracted,
  // so re-introducing it left all of them green. Measured — the mutant survived.
  // Anything between the helpers and EOF is part of the decision being tested.
  const afterHelpers = lineIndex(/^append_path_line\(\)/, 'append_path_line()');
  const helperEnd = afterHelpers + 1
    + lines.slice(afterHelpers + 1).findIndex(l => /^\}/.test(l));
  const tail = lines.slice(helperEnd + 1).join('\n');

  const harness = [
    'set -u',
    `INSTALL_DIR="${installDir}"`,
    "MARKER='# added by botmux installer'",
    section(/^sq=/, /^QUOTED_DIR=/),
    section(/^path_line_present\(\)/, /^\}/),
    section(/^bash_login_file\(\)/, /^\}/),
    section(/^append_path_line\(\)/, /^\}/),
    tail,
  ].join('\n');

  const script = join(base, 'harness.sh');
  writeFileSync(script, `${harness}\n`);
  assertHarnessIsWellFormed(script, harness);

  const path = opts.dirAlreadyOnPath ? `${installDir}:/usr/bin:/bin` : '/usr/bin:/bin';
  const env = { PATH: path, HOME: home, SHELL: `/bin/${opts.shell ?? 'bash'}` };
  let stdout = '';
  let status = 0;
  const once = () => {
    try {
      stdout += execFileSync('sh', [script], { encoding: 'utf-8', env });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      stdout += `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  };
  once();
  if (opts.twice) once();

  return { status, stdout, files: readTree(home), installDir };
}

/**
 * Guard against a vacuous run. "Zero startup files" is the exact symptom this
 * file tests for, so a harness that failed to assemble would look like a PASS on
 * the buggy branch and a FAIL on the fixed one — i.e. it would invert the result
 * rather than error out. Prove the pieces are present before drawing conclusions.
 */
function assertHarnessIsWellFormed(script: string, harness: string): void {
  execFileSync('sh', ['-n', script]);                 // parses as POSIX sh
  expect(harness).toContain('append_path_line()');    // the writer
  expect(harness).toContain('path_line_present()');   // the idempotency check
  expect(harness).toContain('.zshenv');               // per-shell dispatch survived
  expect(harness).toContain('posix_line=');           // the line being written
}

function readTree(root: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(join(root, entry.name), rel));
    else out[rel] = readFileSync(join(root, entry.name), 'utf-8');
  }
  return out;
}

describe('install.sh — PATH entry is written for the user\'s future shells', () => {
  it('REGRESSION: writes the startup file even when INSTALL_DIR is already on the installing PATH', () => {
    // THE BUG. botmux's own daemon prepends ~/.botmux/bin to every CLI session's
    // PATH, so this is the shape of "user installs from inside a botmux session":
    // the old `case ":$PATH:"` gate skipped everything and exited 0 silently, and
    // `botmux` stayed missing from every new terminal.
    const r = runPathBlock({ dirAlreadyOnPath: true, shell: 'bash' });

    expect(Object.keys(r.files).sort()).toEqual(['.bash_profile', '.bashrc']);
    for (const contents of Object.values(r.files)) {
      expect(contents).toContain(r.installDir);
      expect(contents).toContain('# added by botmux installer');
    }
    // And it must SAY so — a silent success is what made the original report
    // ("installed, still command not found") so hard to act on.
    expect(r.stdout).toContain('open a new terminal');
  });

  it('the pre-seeded PATH makes no difference: same files either way', () => {
    // The A/B that isolates the variable. Before the fix these two disagreed
    // (2 files vs 0); the property we now want is that PATH is simply irrelevant.
    const on = runPathBlock({ dirAlreadyOnPath: true, shell: 'bash' });
    const off = runPathBlock({ dirAlreadyOnPath: false, shell: 'bash' });
    expect(Object.keys(on.files).sort()).toEqual(Object.keys(off.files).sort());
  });

  it('still writes the right file per shell', () => {
    // zsh reads .zshenv in every invocation mode; bash needs BOTH .bashrc
    // (interactive) and its login file; anything else falls back to .profile.
    expect(Object.keys(runPathBlock({ shell: 'zsh' }).files)).toEqual(['.zshenv']);
    expect(Object.keys(runPathBlock({ shell: 'bash' }).files).sort())
      .toEqual(['.bash_profile', '.bashrc']);
    expect(Object.keys(runPathBlock({ shell: 'ksh' }).files)).toEqual(['.profile']);
  });

  it('bash: appends to an EXISTING login file rather than creating .bash_profile', () => {
    // bash's login file is the FIRST of .bash_profile → .bash_login → .profile
    // that exists. Creating .bash_profile when the user's login config lives in
    // .profile would stop that file from ever being read again.
    const r = runPathBlock({ shell: 'bash', seed: { '.profile': 'export EDITOR=vi\n' } });
    expect(Object.keys(r.files).sort()).toEqual(['.bashrc', '.profile']);
    expect(r.files['.profile']).toContain('export EDITOR=vi');   // preserved
    expect(r.files['.profile']).toContain(r.installDir);         // and extended
  });

  it('IDEMPOTENT: running twice does not append a second line', () => {
    // Removing the PATH gate must not turn re-running the installer (the
    // documented upgrade gesture) into PATH growth. Two independent layers
    // prevent it: path_line_present() skips the append, and the emitted line
    // guards itself with its own `case` so re-sourcing cannot grow $PATH.
    const r = runPathBlock({ shell: 'bash', twice: true });
    for (const contents of Object.values(r.files)) {
      expect(contents.split('# added by botmux installer').length - 1).toBe(1);
    }
  });

  it('respects a hand-written PATH line already naming this directory', () => {
    // The user solved it themselves; adding a redundant second line would be
    // noise. This needs the seed to name the SAME directory the run will use,
    // which is why it goes through seedWithInstallDir — a literal seed would
    // name some other run's tmp dir and the assertion would pass vacuously.
    const r = runPathBlock({
      shell: 'zsh',
      seedWithInstallDir: { '.zshenv': dir => `export PATH="${dir}:$PATH"\n` },
    });
    expect(r.files['.zshenv']).not.toContain('# added by botmux installer');
    expect(r.files['.zshenv'].trimEnd().split('\n')).toHaveLength(1);
    // Treated as handled, so the user is told they are set — not given a fallback.
    expect(r.stdout).toContain('open a new terminal');
  });

  it('a SIBLING/child directory in the startup file does not count as handled', () => {
    // Substring matching produced measured false positives (`<dir>-old`,
    // `/backup<dir>`, `<dir>/other`) that each left the real directory unwritten.
    for (const suffix of ['-old', '/other']) {
      const r = runPathBlock({
        shell: 'zsh',
        seedWithInstallDir: { '.zshenv': dir => `export PATH="${dir}${suffix}:$PATH"\n` },
      });
      expect(r.files['.zshenv'], `PATH containing <dir>${suffix} must not count`)
        .toContain('# added by botmux installer');
    }
  });

  it('SOURCE PIN: the block is not gated on the installing process\'s PATH', () => {
    // Compare CODE ONLY: the fix deliberately KEEPS an explanatory comment quoting
    // the old `case ":$PATH:"` gate, so matching the whole file would let this
    // assertion trip over its own documentation.
    const code = readFileSync(INSTALL_SH, 'utf-8')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    // The emitted LINE still contains a `case ":$PATH:"` guard — that one is
    // correct and load-bearing (it runs in the user's shell, not here). What must
    // not exist is a gate around INSTALL_DIR deciding whether to write at all.
    expect(code).not.toMatch(/case\s+":\$PATH:"\s+in\s*\n\s*\*":\$INSTALL_DIR:"\*/);
    expect(code).toMatch(/posix_line=.*case .*PATH/);   // the self-guarding line survives
    expect(code).toMatch(/path_line_present/);          // file-level idempotency survives
  });
});
