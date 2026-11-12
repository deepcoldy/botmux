/**
 * Launch-plan fence for prepareDirectSandbox() unit tests.
 *
 * Many sandbox tests call prepareDirectSandbox() only to inspect the plan it
 * builds (argv, env, args file) and never start bwrap. The function still
 * resolves a bwrap first, and where none is installed ensureSandboxDeps()
 * synchronously runs the package manager (`sudo -n apt-get install -y
 * bubblewrap`, 180 s timeout) before returning null. MEASURED on CI runners
 * that could not reach their apt mirror (#3359): ~80 s per call, the vitest leg
 * timed out case by case and the bun leg hit its 720 s per-file wall. On a root
 * host without bwrap the same call really installs a package.
 *
 * usePlanOnlyBwrap() puts a private directory first on PATH for the enclosing
 * describe, holding:
 *   - network helpers that answer capability probes but refuse execution;
 *   - `bwrap`: a stand-in that answers `--version` / `--help` (advertising the
 *     options sandboxNetworkLaunch() checks for) and refuses to run anything;
 *   - `sudo` and every package manager ensureSandboxDeps() tries: exit 1 at
 *     once, so a missed stand-in fails fast instead of installing.
 * Each refused call is recorded and fails the case in afterEach. A case that
 * really has to run bwrap does not belong behind this fence: gate it on a
 * runtime probe and skip where bwrap cannot run.
 *
 * bwrapExecutable() always prefers the distro bwrap (/usr/bin/bwrap, /bin/bwrap)
 * over PATH, so on a host that has one the plans still name the real bwrap;
 * only a host without one reaches the stand-in. (The fence directory does show
 * up in the plan's child PATH, which nothing here executes.)
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';

/** sudo plus the package managers ensureSandboxDeps() looks for. */
const INSTALLERS = ['sudo', 'apt-get', 'dnf', 'yum', 'apk', 'pacman'];

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

export function usePlanOnlyBwrap(): void {
  let dir = '';
  let log = '';
  let previousPath: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sbx-plan-bwrap-'));
    log = join(dir, 'refused.log');
    if (log.includes("'")) throw new Error(`unquotable fence path: ${log}`);
    writeFileSync(log, '');
    writeScript(join(dir, 'bwrap'), [
      'case "$1" in',
      "  --version) echo 'bubblewrap 0.0.0 (test stand-in: launch plans only)'; exit 0 ;;",
      "  --help) printf '%s\\n' 'usage: bwrap [OPTIONS...] [--] COMMAND [ARGS...]' '    --add-seccomp-fd FD' '    --disable-userns'; exit 0 ;;",
      'esac',
      `printf 'bwrap %s\\n' "$*" >> '${log}'`,
      'exit 1',
      '',
    ].join('\n'));
    // Network launch plans discover these tools even though no namespace or
    // network process is started. Keep this boundary independent of host packages.
    for (const [name, help] of Object.entries({
      slirp4netns: '--disable-host-loopback --disable-dns',
      unshare: '--kill-child --mount-proc', nft: '', ip: '',
    })) {
      writeScript(join(dir, name), [
        `[ "$1" = "--help" ] && { printf '%s\\n' '${help}'; exit 0; }`,
        `printf '${name} %s\\n' "$*" >> '${log}'`,
        'exit 1', '',
      ].join('\n'));
    }
    for (const name of INSTALLERS) {
      writeScript(join(dir, name), `printf '${name} %s\\n' "$*" >> '${log}'\nexit 1\n`);
    }
    // A noexec temp dir would hide the stand-ins from the PATH lookup and let
    // execvp fall through to the real package manager: refuse to run instead.
    const probe = spawnSync(join(dir, 'bwrap'), ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) throw new Error(`plan-only bwrap stand-in in ${dir} is not executable: ${probe.error?.message ?? probe.stderr}`);
    previousPath = process.env.PATH;
    process.env.PATH = previousPath ? `${dir}${delimiter}${previousPath}` : dir;
  });

  afterEach(() => {
    const refused = readFileSync(log, 'utf8');
    writeFileSync(log, '');
    expect(refused, 'a launch-plan test ran bwrap or a package manager; gate real-bwrap cases on a runtime probe instead').toBe('');
  });

  afterAll(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
}
